require('../helpers/env');
const { describe, it, mock, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const keys = require('../helpers/keys');
const factories = require('../helpers/factories');
const cryptoUtilsLib = require('../../lib/crypto-utils.lib');
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
    builder.seedBurn(keys.forger, 1_000_000, 0, GENESIS_TS - 10);
    return builder;
}

/** Funds an address on-chain at genesis height so it can spend. */
function fundOnChain(toPub, amount) {
    const store = ledger.getStore();
    const funding = factories.makeTransaction({
        fromKey: keys.carol,
        to: toPub,
        amount,
        timestamp: GENESIS_TS - 5,
    });
    store.transactions.set(funding.hash, funding);
    store.blockTransactions.push({
        id: store.nextBlockTransactionId++,
        transactionHash: funding.hash,
        blockId: 0,
    });
}

/**
 * The core invariant of every rejection test: onBlock must throw AND leave the
 * persistent store byte-for-byte identical. A rejected block that mutates any
 * state is a consensus vulnerability (partial application, phantom balances).
 */
async function assertRejectedAndInert(block, errorMatcher) {
    const before = ledger.dump();
    await assert.rejects(() => blockController.onBlock(block), errorMatcher);
    assert.deepEqual(ledger.dump(), before, 'store was mutated by a rejected block');
    // The processing lock must be released even on failure, or the height
    // wedges forever and no competing block can ever be considered.
    assert.equal(state.getState(state.KEYS.PROCESSING_BLOCK_ID), 0);
}

describe('onBlock — rejection matrix (each block invalid in exactly one way)', () => {
    beforeEach(async (t) => {
        t.mock.timers.enable({ apis: ['Date'], now: NOW_TS * 1000 });
        await freshChain();
    });

    it('rejects a tampered block hash (id integrity)', async () => {
        const builder = new ChainBuilder(ledger, GENESIS_TS);
        const block = builder.makeNext();
        await assertRejectedAndInert({ ...block, hash: 'ab'.repeat(32) }, /invalid hash/);
    });

    it('rejects a forged signature (wrong forger key over a valid hash)', async () => {
        const builder = new ChainBuilder(ledger, GENESIS_TS);
        const block = builder.makeNext();
        const forged = {
            ...block,
            signature: keys.mallory.sign(Buffer.from(block.hash, 'hex')).toString('hex'),
        };
        await assertRejectedAndInert(forged, /invalid signature/);
    });

    it('rejects a wrong generation signature (grinding attempt)', async () => {
        const builder = new ChainBuilder(ledger, GENESIS_TS);
        // Re-hash+sign around a corrupted generation signature so only THAT
        // check fails, not the block hash.
        const block = builder.makeNext();
        const bad = { ...block, generationSignature: 'cd'.repeat(32) };
        bad.hash = factories.blockHash(bad);
        bad.signature = keys.forger.sign(Buffer.from(bad.hash, 'hex')).toString('hex');
        await assertRejectedAndInert(bad, /invalid generation signature/);
    });

    it('rejects a wrong previousHash (broken chain linkage)', async () => {
        const builder = new ChainBuilder(ledger, GENESIS_TS);
        const bad = builder.makeNext();
        const tampered = { ...bad, previousHash: 'ee'.repeat(32) };
        tampered.hash = factories.blockHash(tampered);
        tampered.signature = keys.forger.sign(Buffer.from(tampered.hash, 'hex')).toString('hex');
        await assertRejectedAndInert(tampered, /invalid previous block hash/);
    });

    it('rejects a non-advancing timestamp (== parent, backdating guard)', async () => {
        const builder = new ChainBuilder(ledger, GENESIS_TS);
        // elapsed 0 → timestamp equals parent. Rebuild consistently.
        const bad = factories.makeBlock({
            parent: builder.parent,
            forgerKey: keys.forger,
            timestamp: GENESIS_TS, // not strictly greater than parent
        });
        await assertRejectedAndInert(bad, /invalid timestamp|invalid consensus/);
    });

    it('rejects a wrong target (difficulty manipulation)', async () => {
        const builder = new ChainBuilder(ledger, GENESIS_TS);
        const block = builder.makeNext();
        const bad = { ...block, target: block.target - 1 };
        bad.hash = factories.blockHash(bad);
        bad.signature = keys.forger.sign(Buffer.from(bad.hash, 'hex')).toString('hex');
        await assertRejectedAndInert(bad, /invalid target/);
    });

    it('rejects a block whose forger has insufficient burn (invalid consensus)', async () => {
        // mallory never burned — her hit is 0 and can never beat the ticket.
        const builder = new ChainBuilder(ledger, GENESIS_TS);
        const bad = builder.makeNext({ forgerKey: keys.mallory });
        await assertRejectedAndInert(bad, /invalid consensus/);
    });

    it('rejects a future-dated block beyond MAX_TIMESTAMP_DIFF (timing guard)', async (t) => {
        // Pin the clock far in the past so a legitimately-forged block looks
        // like it is from the future. Timers are already enabled by beforeEach,
        // so move the clock rather than re-enabling.
        t.mock.timers.setTime((GENESIS_TS + 5) * 1000);
        const builder = new ChainBuilder(ledger, GENESIS_TS);
        const block = builder.makeNext(); // timestamp GENESIS_TS + 604800
        await assertRejectedAndInert(block, /Invalid block timings/);
    });

    it('rejects a double-spend within the block (same sender twice)', async () => {
        const builder = new ChainBuilder(ledger, GENESIS_TS);
        fundOnChain(keys.ALICE_PUB, 1_000);
        const spend1 = factories.makeTransaction({ fromKey: keys.alice, to: keys.BOB_PUB, amount: 10, timestamp: GENESIS_TS + 1 });
        const spend2 = factories.makeTransaction({ fromKey: keys.alice, to: keys.CAROL_PUB, amount: 20, timestamp: GENESIS_TS + 2 });
        const bad = builder.makeNext({ transactions: [spend1, spend2] });
        await assertRejectedAndInert(bad, /double spend/i);
    });

    it('rejects a block containing an over-balance spend (cannot mint value)', async () => {
        const builder = new ChainBuilder(ledger, GENESIS_TS);
        fundOnChain(keys.ALICE_PUB, 5);
        const overspend = factories.makeTransaction({ fromKey: keys.alice, to: keys.BOB_PUB, amount: 1_000, timestamp: GENESIS_TS + 1 });
        const bad = builder.makeNext({ transactions: [overspend] });
        await assertRejectedAndInert(bad, /sender balance/i);
    });

    it('rejects a block carrying a transaction with a forged signature', async () => {
        const builder = new ChainBuilder(ledger, GENESIS_TS);
        fundOnChain(keys.ALICE_PUB, 1_000);
        const honest = factories.makeTransaction({ fromKey: keys.alice, to: keys.BOB_PUB, amount: 10, timestamp: GENESIS_TS + 1 });
        const forgedTx = { ...honest, signature: keys.mallory.sign(Buffer.from(honest.hash, 'hex')).toString('hex') };
        const bad = builder.makeNext({ transactions: [forgedTx] });
        await assertRejectedAndInert(bad, /signature/i);
    });

    it('rejects a block whose transaction amount was inflated after signing', async () => {
        const builder = new ChainBuilder(ledger, GENESIS_TS);
        fundOnChain(keys.ALICE_PUB, 1_000);
        const honest = factories.makeTransaction({ fromKey: keys.alice, to: keys.BOB_PUB, amount: 10, timestamp: GENESIS_TS + 1 });
        const mutated = { ...honest, amount: 900 }; // hash no longer matches
        const bad = builder.makeNext({ transactions: [mutated] });
        await assertRejectedAndInert(bad, /hash|signature/i);
    });

    it('rejects a transaction already confirmed in an earlier block (cross-block replay)', async () => {
        // Build and accept one block containing alice→bob, then try to include
        // the very same transaction in the next block.
        const builder = new ChainBuilder(ledger, GENESIS_TS);
        fundOnChain(keys.ALICE_PUB, 1_000);
        const payment = factories.makeTransaction({ fromKey: keys.alice, to: keys.BOB_PUB, amount: 10, timestamp: GENESIS_TS + 1 });
        const block1 = builder.makeNext({ transactions: [payment] });
        assert.equal(await blockController.onBlock(block1), true);
        builder.advanceTo(block1);

        // Reuse the identical (already-confirmed) transaction in block 2.
        const before = ledger.dump();
        const block2 = builder.makeNext({ transactions: [payment] });
        await assert.rejects(() => blockController.onBlock(block2));
        assert.deepEqual(ledger.dump(), before, 'replayed transaction mutated state');
    });
});

describe('onBlock — fault injection proves atomicity', () => {
    beforeEach(async (t) => {
        t.mock.timers.enable({ apis: ['Date'], now: NOW_TS * 1000 });
        await freshChain();
    });

    it('a crash while writing balances rolls the ENTIRE block back', async () => {
        const builder = new ChainBuilder(ledger, GENESIS_TS);
        fundOnChain(keys.ALICE_PUB, 1_000);
        const payment = factories.makeTransaction({ fromKey: keys.alice, to: keys.BOB_PUB, amount: 40, timestamp: GENESIS_TS + 1 });
        const block = builder.makeNext({ transactions: [payment] });

        const before = ledger.dump();
        // New payee/payer rows go through balanceDao.create; crash there.
        ledger.injectFault('balanceDao.create');
        await assert.rejects(() => blockController.onBlock(block), /injected fault/);
        // No block, no linkage, no transaction, no balance may survive.
        assert.deepEqual(ledger.dump(), before, 'partial block application after mid-write crash');
        assert.equal(state.getState(state.KEYS.PROCESSING_BLOCK_ID), 0);
    });

    it('a crash while linking block-transactions rolls back the block insert too', async () => {
        const builder = new ChainBuilder(ledger, GENESIS_TS);
        const block = builder.makeNext();
        const before = ledger.dump();
        ledger.injectFault('blockTransactionDao.bulkCreate');
        await assert.rejects(() => blockController.onBlock(block), /injected fault/);
        assert.equal(await ledger.blockDao.getById(1), null, 'block survived a failed linkage');
        assert.deepEqual(ledger.dump(), before);
    });
});
