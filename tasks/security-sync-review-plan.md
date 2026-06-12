# Security & Sync Review — Remediation Plan

Status legend: ⬜ not started · 🔵 in progress · ✅ done

Source review covered consensus (`controllers/`, `services/`, `services/shared/`),
crypto (`lib/crypto-utils.lib.js`, `services/forger.service.js`), p2p sync
(`p2p/`), and the DB transaction layer (`databases/postgres/`).

---

## 🔴 CRITICAL

### C1 — Reject non-positive amounts / negative fees ✅
**Problem:** No `amount > 0` check anywhere in `validateTransaction`
(`services/transaction.service.js:89-103`). A signed tx with `amount = -1000`
flips balance signs in `balance.service.js:72,84`, so an attacker credits
themselves and debits any `to` address. `validateFee` and
`validateTransactionBalance` both pass for negatives.
**Fix:** reject `amount <= 0` and `fee < 0` at the top of `validateTransaction`,
using `big.js` comparisons; re-derive fee rather than trusting the field.
**Files:** `services/transaction.service.js`
**Verify:** unit-style manual check — negative/zero amount tx is rejected;
normal tx still accepted; fee mismatch rejected.

---

## 🟠 CONSENSUS / SYNC (root causes of de-sync)

### S1 — `PROCESSING_BLOCK_ID` never reset on success ✅
Only reset on error (`controllers/block.controller.js:88`,
`p2p/controllers/block.controller.js:58`). After accepting block N it stays = N,
so the `NEED_REPLACE` competing-block path (`block.controller.js:36-44`) is
dropped by the dedup guard at line 27 → fork resolution silently disabled.
**Fix:** treat it purely as a concurrency lock; clear in `finally`.

### S2 — Destructive rewind before validation & outside the DB transaction ⬜
`removeChainSince(blockData.id - 1)` (`block.controller.js:43`) autocommits a
`DELETE` before `verifyBlockHit`/`validateBlock` run and before the insert
transaction opens. An invalid replacement destroys a valid block.
**Fix:** validate fully first; do rewind + insert in one `sequelize.transaction()`.

### S3 — No cumulative chain-work comparison → deep forks never reconcile ⬜
`NEED_REPLACE` only fires at equal height (`block.service.js:143`). Forks ≥2
blocks deep reject each other (`block.service.js:144-148`). No total-work metric.
**Fix:** track cumulative difficulty; reorg to common ancestor + replay.

### S4 — Tiebreak rewards later/withheld blocks; timestamps barely bounded ⬜
`compareHit` keeps the higher hit (`shared/block.service.js:31`); hit grows with
`elapsedTime` (`forger.service.js:33`). `checkNewBlockTimings` only bounds the
future (+30s), no lower bound, no `> prevBlock.timestamp`
(`block.service.js:158-164`).
**Fix:** require `prev.timestamp < block.timestamp <= now + skew`; reconsider
timestamp-dependent tiebreak.

### S5 — Fork choice depends on mutable cached balances ⬜
`getBurnedBalance` returns cached `balance.burned` (`balance.service.js:108-110`);
nodes can hold different cached values → different fork winners → permanent split.
**Fix:** source fork-critical balances from authoritative height-consistent data.

### S6 — No proactive sync (startup/periodic height gossip) ⬜
Sync only triggers reactively on gap >1 `SyncError`. A node one block behind can
stay behind. **Fix:** exchange best-block height/hash on connect + periodically.

### S7 — `onChain` can wedge the `SYNCING` flag ⬜
Early `return` when `CHAIN_PROCESSING` is set leaves `SYNCING = true`
(`p2p/controllers/block.controller.js:84-90`); stuck node stops forging.
**Fix:** always clear flags in `finally`.

---

## 🟡 MEDIUM

- **M1** — Hit/target math overflows `MAX_SAFE_INTEGER` (`forger.service.js:33`); use `big.js`/BigInt consistently.
- **M2** — Default READ COMMITTED + forger/onBlock race; add mutex and/or SERIALIZABLE for chain mutations.
- **M3** — `removeSinceBlockId` multi-statement raw query autocommits outside the surrounding transaction (`block-transaction.dao.js:100-122`).
- **M4** — `validateTransactionBalance` has write side effects and uses strict `>` (`transaction.service.js:69-82`).
- **M5** — Spam filter closes socket on bursts, can drop sync messages (`p2p/p2p-router.js`, `peer.service.messageEvent`).

---

## 🟢 MINOR / HYGIENE

- Replay protection thin (no per-account nonce).
- ECDSA malleability not normalized (no low-S) — low impact.
- `target` only 36 bits (`forger.service.js:18`).
- Total-supply invariant never enforced; typo `TOTAl_CAPACITY` (`app.constants.js:2`).
- Float literals in genesis amounts — keep money in `big.js`/decimal end-to-end.

---

## Execution order

1. **C1** (critical, small)
2. **S1** (high impact, small)
3. **S2** (high impact, medium)
4. **S4** (medium)
5. **S5 + M1** (medium)
6. **S3** (largest; durable fix for permanent splits)
7. **S6 + S7** (medium)
8. **M2 / M3 / M4 / M5** + minor cleanup
