# ono-core test suite

Industry-grade tests for the ono proof-of-burn node. Zero third-party test
dependencies — built entirely on Node's built-in runner (`node:test`),
`node:assert/strict`, and Node's experimental module mocking. Every run is
deterministic, offline, and needs no database.

## Running

```bash
npm test              # full hermetic suite (unit + property + fuzz + consensus + api)
npm run test:unit     # fast per-module unit tests
npm run test:property # property-based + fuzz suites
npm run test:consensus# onBlock / fork resolution / determinism against the in-memory ledger
npm run test:api      # supertest over the real Express app
npm run test:coverage # the above with V8 coverage on the source modules
npm run test:integration   # REAL Postgres — gated, see below
```

`npm test` is fully deterministic: 222 tests, no network, no clock dependence,
no database. Every randomized test draws from a seeded PRNG; a failure message
prints the seed and iteration so it replays exactly.

The **integration** suite (`tests/integration`) exercises the genuine Sequelize
stack against a live PostgreSQL. It is skipped unless `RUN_PG_INTEGRATION=true`
and a database is reachable (the `test:integration` script points at
`.env.test.local`). It uses `DATABASE_FORCE_SYNC=true` — never point it at
production data.

## Layout

| Directory            | What it covers |
|----------------------|----------------|
| `tests/helpers`      | Deterministic keys, transaction/block factories (an *independent* implementation of protocol assembly), a seeded PRNG + `forAll` property harness, and an in-memory ledger with real transaction snapshot/rollback semantics. |
| `tests/unit`         | Per-module behavior: crypto, transaction/block/forger/balance services, wallet, peer flood scoring, utils, state. |
| `tests/property`     | Randomized invariants: hash determinism/avalanche, signature unforgeability, retarget clamps, chain-weight monotonicity, proof-of-burn hit exactness (vs independent BigInt). |
| `tests/fuzz`         | Hostile-input robustness: the p2p ajv validator and the raw-frame parser against random bytes, huge/unicode/invalid-UTF-8 payloads, prototype pollution, wrong types. |
| `tests/consensus`    | The heart: `controllers/block.controller.onBlock` driven end-to-end against the ledger — acceptance, a full single-fault rejection matrix (state must stay byte-for-byte inert), atomic rollback under injected mid-write faults, fork replacement, and arrival-order determinism. |
| `tests/api`          | `supertest` over `http-server.createApp()` — OpenAPI validation, secure-route auth matrix, malformed JSON, oversized/typed payloads. |
| `tests/integration`  | Gated real-Postgres tests (genesis, DECIMAL precision, PK uniqueness, reorg flush). |

## Design principles

- **Mock only storage, never protocol logic.** The DAO layer is replaced by an
  in-memory ledger that reproduces Postgres semantics (primary-key/unique
  constraints throw, DECIMAL columns are exact-decimal, snapshot-on-begin /
  restore-on-rollback). All hashing, signing, fee math, retargeting and
  consensus run the real production code.
- **Independent cross-checks.** `tests/helpers/factories.js` re-implements
  transaction and block assembly from the crypto primitives; tests assert the
  production services and the factories agree byte-for-byte, and consensus math
  is cross-checked against a from-scratch BigInt implementation.
- **Verify state, not booleans.** Rejection tests assert the whole store is
  unchanged; acceptance tests assert balances, mempool, linkage and broadcasts.
- **Every consensus rule has a positive and negative test.**

See `tests/FINDINGS.md` for security observations the suite documents.
