require('../helpers/env');
const { describe, it, mock } = require('node:test');
const assert = require('node:assert/strict');
const keys = require('../helpers/keys');
const factories = require('../helpers/factories');
const { forAll } = require('../helpers/prng');
const { FIXED_NOW_SECONDS } = require('../helpers/env');
const { createLedger, installLedgerMocks, installWalletMock } = require('../helpers/ledger');
const { BLOCKCHAIN_SETTINGS } = require('../../constants/app.constants');

const ledger = createLedger();
installLedgerMocks(mock, ledger);
installWalletMock(mock, keys.forger);

const blockService = require('../../services/block.service');
const forgerService = require('../../services/forger.service');

const T0 = FIXED_NOW_SECONDS;
const { MIN_TARGET, MAX_TARGET } = BLOCKCHAIN_SETTINGS;

describe('retargeting properties', () => {
    it('the new target ALWAYS stays inside both the per-block and global clamps', () => {
        // Difficulty manipulation resistance: no parent state and no timestamp
        // (past, zero, absurd future, even negative elapsed) may ever push the
        // target outside [max(parent/2, MIN), min(2*parent, MAX)].
        forAll(
            { name: 'retarget-clamped', seed: 0x7a46e7, runs: 3000 },
            (rng) => ({
                parent: { target: rng.int(MIN_TARGET, MAX_TARGET), timestamp: T0 },
                elapsed: rng.int(-1_000_000, 1_000_000),
            }),
            ({ parent, elapsed }) => {
                const target = blockService.createBlockTarget(parent, T0 + elapsed);
                const low = Math.max(Math.floor(parent.target / 2), MIN_TARGET);
                const high = Math.min(2 * parent.target, MAX_TARGET);
                assert.ok(Number.isInteger(target), `non-integer target ${target}`);
                assert.ok(target >= low && target <= high, `target ${target} escaped [${low}, ${high}]`);
            },
        );
    });

    it('production retargeting matches the independent implementation on all inputs', () => {
        forAll(
            { name: 'retarget-independent', seed: 0x7a46e8, runs: 3000 },
            (rng) => ({
                parent: { target: rng.int(MIN_TARGET, MAX_TARGET), timestamp: rng.int(0, 2_000_000_000) },
                elapsed: rng.int(0, 100_000),
            }),
            ({ parent, elapsed }) => {
                assert.equal(
                    blockService.createBlockTarget(parent, parent.timestamp + elapsed),
                    factories.expectedTarget(parent, parent.timestamp + elapsed),
                );
            },
        );
    });
});

describe('chain weight properties', () => {
    it('difficulty is strictly antitone: lower target ⇒ strictly more work', () => {
        forAll(
            { name: 'difficulty-antitone', seed: 0xd1ff, runs: 2000 },
            (rng) => {
                const a = rng.int(MIN_TARGET, MAX_TARGET - 1);
                return { a, b: rng.int(a + 1, MAX_TARGET) };
            },
            ({ a, b }) => {
                assert.ok(
                    blockService.blockDifficulty(a).gt(blockService.blockDifficulty(b)),
                    `difficulty(${a}) not > difficulty(${b})`,
                );
            },
        );
    });

    it('cumulative work is permutation-invariant (exact decimal, no float order-drift)', () => {
        // Nodes may enumerate a contested suffix in different orders while
        // weighing forks; the comparison must not depend on summation order.
        forAll(
            { name: 'work-permutation', seed: 0x50a7, runs: 500 },
            (rng) => {
                const blocks = Array.from({ length: rng.int(1, 20) }, () => ({
                    target: rng.int(MIN_TARGET, MAX_TARGET),
                }));
                const shuffled = [...blocks].sort(() => (rng.bool() ? 1 : -1));
                return { blocks, shuffled };
            },
            ({ blocks, shuffled }) => {
                assert.equal(
                    blockService.cumulativeDifficulty(blocks).toString(),
                    blockService.cumulativeDifficulty(shuffled).toString(),
                );
            },
        );
    });
});

describe('proof-of-burn hit properties', () => {
    it('hit equals the independent BigInt product for any integer inputs', async () => {
        // The one consensus formula every node must agree on to the last digit.
        const { Rng } = require('../helpers/prng');
        const store = ledger.getStore();
        const runs = 200;
        for (let i = 0; i < runs; i++) {
            const rng = new Rng(0xb16b16 + i * 0x9e3779b9);
            const prevTarget = rng.int(MIN_TARGET, MAX_TARGET);
            const burned = rng.int(BLOCKCHAIN_SETTINGS.MIN_FORGER_BALANCE, 10_000_000);
            const elapsed = rng.int(1, 1_000_000);

            store.transactions.clear();
            store.blockTransactions.length = 0;
            const burn = factories.makeTransaction({
                fromKey: keys.alice,
                to: BLOCKCHAIN_SETTINGS.BURN_ADDRESS,
                amount: burned,
                timestamp: T0 - 10_000 - i, // unique tx identity per case
            });
            store.transactions.set(burn.hash, burn);
            store.blockTransactions.push({ id: 1, transactionHash: burn.hash, blockId: 3 });

            const latestBlock = {
                id: 10,
                target: prevTarget,
                timestamp: T0,
                generationSignature: 'cc'.repeat(32),
            };
            const hit = await forgerService.calcHit(latestBlock, T0 + elapsed, keys.ALICE_PUB);
            const independent = BigInt(prevTarget) * BigInt(burned) * BigInt(elapsed);
            assert.equal(
                hit.toFixed(),
                independent.toString(),
                `[hit-bigint-crosscheck seed=${0xb16b16} run=${i}] target=${prevTarget} burned=${burned} elapsed=${elapsed}`,
            );
        }
    });

    it('lottery tickets are uniform-ish and deterministic over random seeds', () => {
        let sum = 0;
        const runs = 2000;
        forAll(
            { name: 'ticket-range', seed: 0x71c4e7, runs },
            (rng) => ({
                latestBlock: {
                    generationSignature: rng.hex(64),
                    id: 1,
                    target: 1,
                    timestamp: 1,
                },
                publicKey: rng.hex(66),
            }),
            ({ latestBlock, publicKey }) => {
                const ticket = forgerService.calcTarget(latestBlock, publicKey);
                assert.equal(forgerService.calcTarget(latestBlock, publicKey), ticket);
                assert.ok(ticket >= 0 && ticket < 16 ** 9);
                sum += ticket;
            },
        );
        // Mean of uniform [0, 16^9) is 16^9/2; allow ±5% — detects truncated or
        // biased seeds (e.g. parsing fewer digits than intended).
        const mean = sum / runs;
        const expected = 16 ** 9 / 2;
        assert.ok(
            Math.abs(mean - expected) < expected * 0.05,
            `ticket mean ${mean} deviates >5% from uniform expectation ${expected}`,
        );
    });
});
