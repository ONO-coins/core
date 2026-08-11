# Security observations documented by the test suite

The suite is green. Findings #1–#4 below were **fixed** (see "Status" on each);
the tests now lock in the corrected behavior. The remaining items are pinned
invariants or observations. Where a test encodes one, it is named.

Fixes applied in this pass (all verified byte-for-byte non-fork / non-consensus):
- `lib/crypto-utils.lib.js` — escape reserved delimiters + reject missing fields.
- `lib/utils.lib.js` — filter the full `127.0.0.0/8` block and `0.0.0.0`.
- `services/balance.service.js` — accumulate forger fees with big.js.

## 1. `generateDomainHash` is only injective for delimiter-free values (load-bearing)

**Status: FIXED.** Values are now percent-escaped for the reserved delimiters
(`%`, `|`, `=`) before entering the preimage, so the encoding is injective even
for hostile non-hex inputs. Because no protocol value contains those characters,
every honest transaction/block/generation hash is **byte-for-byte unchanged** —
verified by the full consensus suite (genesis, block hashing, forging all still
pass) and an explicit equality test against a known pre-fix digest. This is a
hardening, not a protocol change.

`lib/crypto-utils.lib.js` builds a hash preimage as
`domain|network|k1=v1|k2=v2…`. This is collision-free **only** because every
hashed field is hex or a decimal number — values that cannot contain `|` or `=`.

- If a free-text field is ever added to a hashed object, `{a:"1|b=2"}` collides
  with `{a:"1", b:"2"}`, which is a hash/identity forgery vector.
- The ajv p2p schemas and the OpenAPI spec restricting every string field to
  fixed-length hex are therefore **security-critical**, not just hygiene.

Pinned by: `tests/unit/crypto-utils.test.js` ("delimiter characters inside
values no longer forge field boundaries" + the byte-identical honest-hash test)
and the injectivity property in `tests/property/crypto.property.test.js`.

## 2. A missing hashed field serialized as the literal string `"undefined"`

**Status: FIXED.** `generateDomainHash` now throws on an `undefined`/`null`
field value. Unreachable in honest paths (required fields are enforced by the
ajv/OpenAPI schemas), so no honest hash changes; a future *optional* field will
now fail loudly instead of silently colliding.

Pinned by: `tests/unit/crypto-utils.test.js` ("a missing/undefined hashed field
throws instead of colliding").

## 3. `filterLocalUrls` missed several loopback spellings (self-dial / SSRF gap)

**Status: FIXED.** The filter now matches the entire `127.0.0.0/8` block and
`0.0.0.0` (in addition to `localhost` and `::1`), and IPv4-mapped forms whose
textual spelling carries a `127.x`. A regression test confirms genuinely remote
addresses that merely contain a `0` or `127` are not over-filtered.

Pinned by: `tests/unit/utils.lib.test.js` ("catches the full loopback range" /
"does not over-filter…").

**Note:** the fix uses raw-string regexes rather than `URL`-based host parsing on
purpose — Node's `URL` normalizes `::ffff:127.0.0.1` to the compressed
`::ffff:7f00:1` hex form, which would defeat a textual `127.` check.

## 4. `balance.service.updateByBlock` accumulated forger fees with float `+=`

**Status: FIXED.** Fees are now summed with `big.js`
(`fees = fees.plus(tx.fee)`) and converted to a number only at the DAO boundary.
Previously `fees += new Big(tx.fee).toNumber()` drifted (e.g.
`0.00001+0.00002+0.00003 → 0.00006000000000000001`); in production the drift
landed beyond `DECIMAL(27,18)` and was rounded away, so it was harmless, but it
was float arithmetic in money math.

Pinned by: `tests/unit/balance.service.test.js` ("credits the forger the EXACT
fee sum with no float drift"), which uses the drift-prone values above.

## 5. Forger fees only reach the balance cache when the forger already has a row

`changeOrCreateBalance` ignores its `amount` argument on the *create* and
*same-block* paths (it recomputes from chain, and fees are not on-chain
transactions). So a forger's earned fees are reflected in the cached balance
only when it already had a balance row from an earlier block. The authoritative
on-chain recomputation never counts fees at all. This is internally consistent
today but is a subtle coupling worth a comment in the source. **Not changed** —
touching it risks altering balance semantics; flagged for a source comment only.

## 6. (Incidental) Genesis burn transactions carry pre-refactor hashes/signatures

Not caused by these tests, surfaced while verifying the crypto fix. The
hardcoded burn transactions in `constants/app.constants.js` (mainnet
`624450aa…`, testnet `3d71ba44…`) were computed with an older hashing scheme;
recomputing them with the current `generateDomainHash` yields different digests
(mainnet `089a9ce1…`). This is harmless today — `blockService.init()` inserts
the initial allocations without hash/signature validation, and genesis sits
below the immutable window so it is never re-validated. But the stored hash and
signature are internally inconsistent with the live hashing code. If you ever
add a genesis-validation step, regenerate these two rows with keys you control
(their signatures cannot be re-created without the original private keys).

Pinned by: `tests/unit/balance.service.test.js` (models the increment path
explicitly) and the consensus no-inflation test, which asserts conservation over
the on-chain transaction set only.

## Confirmed-good properties (positive security results)

- **ECDSA malleability is rejected**: the high-S twin of a valid signature does
  not verify (`verifySignature` normalizes and compares). — crypto-utils tests.
- **Signing is deterministic (RFC6979)**: identical key+message → identical
  signature, so a weak-RNG nonce cannot leak the key. — crypto property tests.
- **Domain + network separation**: a transaction preimage can never equal a
  block preimage, nor a testnet item a mainnet one. — crypto-utils tests.
- **Wrong passphrase never overwrites an existing seed** (no silent fund loss).
  — wallet tests.
- **Rejected blocks leave state byte-for-byte inert**, and mid-write faults roll
  the whole block back atomically. — consensus rejection + fault-injection tests.
- **Fork resolution is deterministic and arrival-order independent.** —
  consensus determinism test.
- **No inflation**: the confirmed transaction set stays exactly zero-sum
  (net flow + fees == 0). — consensus accept test.
