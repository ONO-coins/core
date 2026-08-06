require('../helpers/env');
const { describe, it, mock, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const keys = require('../helpers/keys');
const factories = require('../helpers/factories');
const {
    createLedger,
    installLedgerMocks,
    installWalletMock,
    installP2pActionsMock,
} = require('../helpers/ledger');
const { ChainBuilder } = require('./chain-builder');

const ledger = createLedger();
installLedgerMocks(mock, ledger);
installWalletMock(mock, keys.forger);
installP2pActionsMock(mock);

const blockService = require('../../services/block.service');
const sharedBlockService = require('../../services/shared/block.service');
const blockController = require('../../controllers/block.controller');
const state = require('../../state');

const GENESIS_TS = 1731330074;
const NOW_TS = GENESIS_TS + 604_800 + 100;

async function freshChain() {
    const store = ledger.getStore();
    store.blocks.clear();
    store.transactions.clear();
    store.blockTransactions.length = 0;
    store.balances.clear();
    store.pool.clear();
    store.nextBlockTransactionId = 1;
    ledger.clearFaults();
    state.init();
    await blockService.init();
    const builder = new ChainBuilder(ledger, GENESIS_TS);
    // Both the honest forger and a competitor have burn weight at genesis.
    builder.seedBurn(keys.forger, 1_000_000, 0, GENESIS_TS - 10);
    builder.seedBurn(keys.alice, 1_000_000, 0, GENESIS_TS - 9);
    return builder;
}

describe('compareBlockDifficulty — deterministic fork winner selection', () => {
    beforeEach(async (t) => {
        t.mock.timers.enable({ apis: ['Date'], now: NOW_TS * 1000 });
        await freshChain();
    });

    it('a strictly harder (lower target) competitor wins', async () => {
        const store = ledger.getStore();
        store.blocks.set(3, { id: 3, target: 1000, hash: 'aa'.repeat(32) });
        assert.equal(await sharedBlockService.compareBlockDifficulty({ id: 3, target: 999, hash: 'bb'.repeat(32) }), true);
        assert.equal(await sharedBlockService.compareBlockDifficulty({ id: 3, target: 1001, hash: 'bb'.repeat(32) }), false);
    });

    it('an equal-target tie is broken by the lexicographically smaller hash (global agreement)', async () => {
        // Every node must pick the SAME winner on a tie or the network splits.
        // The rule is deterministic on the signed hash, not on arrival order.
        const store = ledger.getStore();
        store.blocks.set(3, { id: 3, target: 1000, hash: 'cccccc' + 'c'.repeat(58) });
        assert.equal(
            await sharedBlockService.compareBlockDifficulty({ id: 3, target: 1000, hash: 'aaaaaa' + 'a'.repeat(58) }),
            true,
            'smaller hash should win the tie',
        );
        assert.equal(
            await sharedBlockService.compareBlockDifficulty({ id: 3, target: 1000, hash: 'ffffff' + 'f'.repeat(58) }),
            false,
            'larger hash should lose the tie',
        );
    });

    it('an identical block (same hash) never replaces itself', async () => {
        const store = ledger.getStore();
        store.blocks.set(3, { id: 3, target: 1000, hash: 'dd'.repeat(32) });
        assert.equal(await sharedBlockService.compareBlockDifficulty({ id: 3, target: 1000, hash: 'dd'.repeat(32) }), false);
    });

    it('any competitor wins when we hold no block at that height', async () => {
        assert.equal(await sharedBlockService.compareBlockDifficulty({ id: 77, target: 5, hash: 'ee'.repeat(32) }), true);
    });
});

describe('onBlock — competing tip replacement at the same height', () => {
    beforeEach(async (t) => {
        t.mock.timers.enable({ apis: ['Date'], now: NOW_TS * 1000 });
        await freshChain();
    });

    it('replaces our tip atomically with a strictly heavier competing block', async () => {
        // Genesis target is already MAX, so only a small elapsed (<10s) drops
        // the child target below the clamp. Smaller elapsed → lower (harder)
        // target. Both hits still crush the 9-hex-digit ticket.
        const builder = new ChainBuilder(ledger, GENESIS_TS);
        const ours = builder.makeNext({ forgerKey: keys.forger, elapsed: 9 });
        assert.equal(await blockController.onBlock(ours), true);

        // Competitor forged by alice with LESS elapsed time → lower (harder) target.
        const competitor = new ChainBuilder(ledger, GENESIS_TS).makeNext({
            forgerKey: keys.alice,
            elapsed: 5,
        });
        assert.ok(competitor.target < ours.target, 'competitor must be strictly harder for this test');

        assert.equal(await blockController.onBlock(competitor), true);

        const winner = await ledger.blockDao.getById(1);
        assert.equal(winner.hash, competitor.hash, 'heavier block did not replace the tip');
        assert.equal(winner.publicKey, keys.ALICE_PUB);
        // Exactly one block at height 1 — no duplicate/fork left behind.
        const atHeight1 = [...ledger.getStore().blocks.values()].filter((b) => b.id === 1);
        assert.equal(atHeight1.length, 1);
        assert.equal(state.getState(state.KEYS.PROCESSING_BLOCK_ID), 0);
    });

    it('rejects a strictly lighter competing block and leaves our tip untouched', async () => {
        const builder = new ChainBuilder(ledger, GENESIS_TS);
        const ours = builder.makeNext({ forgerKey: keys.forger, elapsed: 5 });
        assert.equal(await blockController.onBlock(ours), true);

        const lighter = new ChainBuilder(ledger, GENESIS_TS).makeNext({
            forgerKey: keys.alice,
            elapsed: 9, // more time → higher target → lighter
        });
        assert.ok(lighter.target > ours.target);

        const before = ledger.dump();
        await assert.rejects(() => blockController.onBlock(lighter), /already exists/i);
        assert.deepEqual(ledger.dump(), before, 'a losing fork mutated state');
    });
});

describe('validateChain — sync-time cumulative-difficulty rule', () => {
    beforeEach(async (t) => {
        t.mock.timers.enable({ apis: ['Date'], now: NOW_TS * 1000 });
        await freshChain();
    });

    it('rejects a chain longer than one synchronization batch', async () => {
        const blockTransactionService = require('../../services/block-transaction.service');
        const chain = Array.from({ length: 31 }, (_, i) => ({
            previousHash: 'x'.repeat(64),
            target: 5,
            transactions: [],
            id: i + 1,
        }));
        const result = await blockTransactionService.validateChain(chain);
        assert.equal(result.valid, false);
        assert.match(result.error, /too long/);
    });

    it('rejects a chain whose base is unknown to us (no common ancestor)', async () => {
        const blockTransactionService = require('../../services/block-transaction.service');
        const chain = [{ previousHash: 'nonexistent'.padEnd(64, '0'), target: 5, transactions: [] }];
        const result = await blockTransactionService.validateChain(chain);
        assert.equal(result.valid, false);
        assert.match(result.error, /Immutable block does not found/);
    });

    it('rejects a fork that does not carry strictly more work than ours', async () => {
        // Adopt-only-if-heavier: an equal or lighter incoming suffix must lose,
        // otherwise an attacker replays our own chain to force pointless reorgs.
        const blockTransactionService = require('../../services/block-transaction.service');
        const builder = new ChainBuilder(ledger, GENESIS_TS);
        const ours = builder.makeNext({ elapsed: 302_400 });
        assert.equal(await blockController.onBlock(ours), true);

        // Incoming chain rooted at genesis carrying a single, lighter block.
        const incoming = [
            factories.makeBlock({
                parent: {
                    id: 0,
                    hash: require('../../constants/app.constants').INITIAL_BLOCK.hash,
                    target: require('../../constants/app.constants').INITIAL_BLOCK.target,
                    timestamp: GENESIS_TS,
                    generationSignature:
                        require('../../constants/app.constants').INITIAL_BLOCK.generationSignature,
                },
                forgerKey: keys.alice,
                timestamp: GENESIS_TS + 604_800, // more elapsed → higher target → lighter
            }),
        ];
        const result = await blockTransactionService.validateChain(incoming);
        assert.equal(result.valid, false);
        assert.match(result.error, /less cumulative difficulty/);
    });
});

describe('determinism — arrival order does not change the final state', () => {
    beforeEach(async (t) => {
        t.mock.timers.enable({ apis: ['Date'], now: NOW_TS * 1000 });
    });

    it('two competing blocks converge to the SAME winner regardless of delivery order', async () => {
        // The canonical-chain rule must be order-independent: whichever of two
        // competing height-1 blocks is heavier must win, whether it arrives
        // first or second. This is the core anti-fork property.
        const runOrder = async (order) => {
            await freshChain();
            const heavier = new ChainBuilder(ledger, GENESIS_TS).makeNext({ forgerKey: keys.forger, elapsed: 5 });
            const lighter = new ChainBuilder(ledger, GENESIS_TS).makeNext({ forgerKey: keys.alice, elapsed: 9 });
            assert.ok(heavier.target < lighter.target);
            for (const block of order === 'heavier-first' ? [heavier, lighter] : [lighter, heavier]) {
                try {
                    await blockController.onBlock(block);
                } catch {
                    /* losing fork is rejected — expected */
                }
            }
            return ledger.blockDao.getById(1);
        };

        const a = await runOrder('heavier-first');
        const b = await runOrder('lighter-first');
        assert.equal(a.hash, b.hash, 'winner depended on arrival order (consensus split!)');
        assert.equal(a.publicKey, keys.FORGER_PUB, 'the heavier block should win in both orders');
    });
});
