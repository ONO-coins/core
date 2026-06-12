# Security & Sync Review — Remediation Plan

Status legend: ⬜ not started · 🔵 in progress · ✅ done

Source review covered consensus (`controllers/`, `services/`, `services/shared/`),
crypto (`lib/crypto-utils.lib.js`, `services/forger.service.js`), p2p sync
(`p2p/`), and the DB transaction layer (`databases/postgres/`).

---

## Live validation (two isolated nodes, throwaway DBs, no production peer)

- ✅ Boot integrity: full init sequence, no require-time circular deps (despite the
  new S6 cross-module requires), schema force-sync + genesis correct.
- ✅ Forging: genesis burner forged blocks on a clean chain with no errors — exercises
  `verifyHit/calcHit` (M1 big.js) and the S5 height-scoped `getBurnedBalance` query
  every second.
- ✅ Sync convergence: a fresh node synced from genesis to the forger's tip; identical
  tip hashes. Exercises `onChain`, `validateChain` (S3 cumulative difficulty), and the
  S6/S7 wedge-fixed completion.
- ✅ Catch-up after offline + restart: node converged again (matching tip hashes),
  self-healing through a transient race.
- 🟡 Transient `Cant change immutable blocks` warn during catch-up: benign and correct
  — the connect-time STATUS sync raced with broadcast blocks that advanced the immutable
  boundary, so the now-stale sync was correctly rejected and the node had already
  advanced. S6's `SYNCHRONIZED=true`-on-error settle prevented a wedge. Follow-up: lower
  the log level / skip the redundant STATUS sync while a broadcast is in flight.
- 🐛 Pre-existing, unrelated: `GET /block/chain` with no `fromId` → `id > NaN` SQL error
  (`http-server/controllers/block.controller.js:22`). Input-validation gap, not consensus.
- Not exercised: a head-to-head same-height fork reorg (needs a second forging identity
  with burn balance). S3's `compareBlockDifficulty`/cumulative-difficulty path was
  exercised via sync adoption, but not a live competing fork.

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

### S2 — Destructive rewind before validation & outside the DB transaction ✅
`removeChainSince(blockData.id - 1)` (`block.controller.js:43`) autocommits a
`DELETE` before `verifyBlockHit`/`validateBlock` run and before the insert
transaction opens. An invalid replacement destroys a valid block.
**Fix:** validate fully first; do rewind + insert in one `sequelize.transaction()`.

### S3 — No cumulative chain-work comparison → deep forks never reconcile ✅
**Done (no schema change):**
- `blockService.blockDifficulty(target)` = `MAX_TARGET / target` and
  `cumulativeDifficulty(blocks)` (`services/block.service.js`).
- Same-height: `compareHit` → `compareBlockDifficulty` (`services/shared/block.service.js`)
  — exact integer target comparison + deterministic hash tiebreak; no balance-cache
  dependency. Caller updated in `controllers/block.controller.js`.
- Deeper forks: `validateChain` now gates on cumulative difficulty of the contested
  suffix (`blockDao.getTargetsSince`) instead of chain length, keeping the tx
  count/sum anti-abuse checks (`services/block-transaction.service.js`).
- Work is computed on demand from stored `target`s; forks only differ inside the
  mutable window (≤15 < batch 30), so one sync batch spans the contested region.
- **Note:** a sync ending exactly on a 30-block batch boundary can leave `SYNCING`
  true (pre-existing; track under S6/S7). Multi-batch forks deeper than one batch
  rely on incremental application as before.

### S4 — Tiebreak rewards later/withheld blocks; timestamps barely bounded ✅
> Done: monotonic lower bound (`checkBlockTimestamp`) added to `validateBlock`; future
> +30s bound already existed. The timestamp-dependent tiebreak is resolved by S3 —
> fork choice now uses target/work, where a later timestamp yields a *higher* target
> and therefore *loses*, so withholding no longer pays.
`compareHit` keeps the higher hit (`shared/block.service.js:31`); hit grows with
`elapsedTime` (`forger.service.js:33`). `checkNewBlockTimings` only bounds the
future (+30s), no lower bound, no `> prevBlock.timestamp`
(`block.service.js:158-164`).
**Fix:** require `prev.timestamp < block.timestamp <= now + skew`; reconsider
timestamp-dependent tiebreak.

### S5 — Fork choice / consensus depend on mutable cached balances ✅
S3 removed the cache dependency from fork *choice*. S5 now removes it from consensus
*acceptance*:
- New `transactionDao.calculateBurnedBalanceUpToBlock(address, maxBlockId)` sums
  on-chain burns confirmed in blocks `<= maxBlockId`.
- `balanceService.getBurnedBalance` is now a pure, height-scoped read (no cache read,
  no cache write/side effects). Callers already pass the parent height.
- **Determinism:** `verifyBlockHit` validates `previousHash`, so two nodes only
  compare burned balances when they agree on the parent → they share the identical
  block prefix up to the parent height → identical burned totals. A competing block
  at the same height is excluded by the scope, so it can't pollute the count.
- The spendable-balance cache (`balance.burned` column) is untouched and still used
  for wallet/API balance reads via `shared/balance.service.calculateBalance`.

### S6 — No proactive sync (startup/periodic height gossip) ✅
New `STATUS` message (`{lastBlockId, lastBlockHash}`):
- Sent on connect (`p2p-handlers.socketConnected` → `blockController.sendStatus`) and
  broadcast every `STATUS_BROADCAST_INTERVAL` (30s) from `p2p/index.js`.
- `blockController.onStatus`: if the peer is ahead, or at our height on a different
  block, set `SYNCHRONIZED=false` and `syncRequest(socket, immutableBlockId)`;
  `validateChain` then decides by cumulative difficulty (S3). Steady state (same tip)
  is a no-op, so no churn.
- Reuses the existing `SYNC_REQUEST → CHAIN → onChain` path; also heals tip forks
  that a missed `NEW_BLOCK` broadcast would otherwise leave split.
- Trade-off: a behind node re-applies its ≤15-block mutable window on catch-up
  (correct, bounded, only when actually behind).

### S7 — `onChain` can wedge the `SYNCING` flag ✅ (folded into S6)
Fixed the real wedge: a sync ending on an exact batch multiple never finalized.
- `syncRequest` now always answers (empty chain = "you reached my tip").
- `onChain` finalizes on an empty chain, continues with the **same** socket (a
  behind peer can't end our sync early), and restores `SYNCHRONIZED=true` on error
  so a failed attempt can't leave us perpetually "not synced".

---

## 🟡 MEDIUM

- **M1** — ✅ Hit/target math now uses `big.js` (`calcHit`, `predictForgingTimestamp`, `verifyHit`, `compareHit`); avoids cross-node rounding disagreement on close forks.
- **M2** — ✅ Resolved by analysis; no code change (and intentionally so).
  - The `blocks.id` PRIMARY KEY serializes competing inserts at the same height:
    if the forger and an inbound block both build height N, exactly one commits;
    the other gets a `UniqueConstraintError`. The forger's `generateBlock`
    rolls back (block insert is the first statement, before any balance change);
    the p2p `onBlock` retries, hits `NEED_REPLACE`, and resolves via
    `compareBlockDifficulty`. No partial state, no double-spend.
  - Each chain mutation is one atomic transaction with per-row `increment()`s, and
    height N+1 can't be forged until N commits (it needs N's hash), so there is no
    concurrent cross-height balance interleaving to protect against.
  - `SERIALIZABLE` was rejected: it would raise serialization-failure errors that
    the code doesn't retry, causing spurious block rejections — strictly worse than
    the current PK-protected behavior. A global async mutex would add deadlock risk
    with no correctness gain.
- **M3** — ✅ `onChain`'s rewind (`removeSinceBlockId` + `flushBalancesFromBlock`) now
  runs in one transaction; the multi-statement delete was already internally atomic,
  this closes the gap to the balance flush. Both `removeSinceBlockId` call sites now
  receive a transaction.
- **M4** — ✅ `validateTransactionBalance` is now a pure read using big.js `>=` (allows spending the exact balance); removed the cache-write side effects (and a spurious unique-constraint rejection race) and the unused `blockDao` require.
- **M5** — ✅ `messageEvent` now updates the frequency EMA on every message so a peer recovers after a burst (the old early-return permanently blacklisted any peer that ever flooded). Returns `{ignore, close}`: spam messages are dropped (connection + in-flight block/sync messages survive); the socket closes only on a sustained severe flood (`FREQUENCY.DISCONNECT`).

---

## 🟢 MINOR / HYGIENE

Done in the cleanup pass:
- ✅ `GET /block/chain` with no `fromId` → `id > NaN` SQL error. Guarded in
  `http-server/controllers/block.controller.js`: missing/invalid `fromId` defaults to
  genesis. (Found during live testing.)
- ✅ Transient `Cant change immutable blocks` warn during a redundant/stale sync. A
  `validateChain` rejection now settles the sync quietly at debug level instead of
  throwing a scary warning (`p2p/controllers/block.controller.js`).
- ✅ `blockService.blockDifficulty` guards an out-of-range `target` (returns 0 work
  instead of dividing by zero) — defensive against a malicious synced chain.
- ✅ Typo `TOTAl_CAPACITY` → `TOTAL_CAPACITY` (`app.constants.js`; was unused).

Deferred (with rationale — not blockers):
- **Orphan-tx re-pooling on reorg.** Returning a discarded fork's transactions to the
  pool is only safe if the forger re-validates pool txs before including them —
  otherwise a now-invalid orphan would be forged into a block that peers reject. Needs
  forger-side re-validation + its own test pass; risky to bolt onto the freshly
  validated reorg path. Today a sender can re-broadcast a dropped tx.
- **Per-account nonce / replay.** Exact replay is already blocked by tx-hash uniqueness
  (timestamp is in the hash); a nonce adds ordering guarantees but no new safety here.
- **ECDSA low-S malleability.** No impact: tx/block identity is the hash, which excludes
  the signature, so a malleated signature can't create a duplicate record.
- **Total-supply invariant / `target` 36-bit width / genesis float literals.** Supply is
  fixed by genesis and C1 blocks minting; these are belt-and-suspenders, left as-is.

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
