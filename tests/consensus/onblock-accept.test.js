require('../helpers/env');
const { describe, it, mock, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Big = require('big.js');
const keys = require('../helpers/keys');
const factories = require('../helpers/factories');
const { FIXED_NOW_MS, FIXED_NOW_SECONDS } = require('../helpers/env');
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
const NOW_TS = GENESIS_TS + 604_800 + 100; // wall clock just past the forged block

/**
 * Resets the ledger to a fresh genesis and returns a builder whose forger has a
 * large confirmed burn (so its hits beat the ticket).
 */
async function freshChain() {
    const store = ledger.getStore();
    store.blocks.clear();
    store.transactions.clear();
    store.blockTransactions.length = 0;
    store.balances.clear();
    store.pool.clear();
    store.nextBlockTransactionId = 1;

    state.init();
    await blockService.init(); // real genesis + allocations
    const builder = new ChainBuilder(ledger, GENESIS_TS);
    builder.seedBurn(keys.forger, 1_000_000, 0, GENESIS_TS - 10);
    return builder;
}

describe('onBlock — happy path acceptance', () => {
    beforeEach(async (t) => {
        t.mock.timers.enable({ apis: ['Date'], now: (NOW_TS) * 1000 });
        await freshChain();
    });

    it('accepts a valid successor block and persists block + linkage', async () => {
        const builder = new ChainBuilder(ledger, GENESIS_TS);
        // reuse the burn seeded in freshChain
        const block = builder.makeNext();

        const accepted = await blockController.onBlock(block);
        assert.equal(accepted, true);

        const stored = await ledger.blockDao.getById(1);
        assert.ok(stored, 'block was not persisted');
        assert.equal(stored.hash, block.hash);
        // The processing lock must be released on success.
        assert.equal(state.getState(state.KEYS.PROCESSING_BLOCK_ID), 0);
    });

    it('applies transfers exactly: recipient credited, sender debited amount+fee', async () => {
        const builder = new ChainBuilder(ledger, GENESIS_TS);
        // Fund alice on-chain (at genesis height) so she can pay.
        const funding = factories.makeTransaction({
            fromKey: keys.carol,
            to: keys.ALICE_PUB,
            amount: 100,
            timestamp: GENESIS_TS - 5,
        });
        const store = ledger.getStore();
        store.transactions.set(funding.hash, funding);
        store.blockTransactions.push({ id: store.nextBlockTransactionId++, transactionHash: funding.hash, blockId: 0 });

        const payment = factories.makeTransaction({
            fromKey: keys.alice,
            to: keys.BOB_PUB,
            amount: 40,
            timestamp: GENESIS_TS + 10,
        });
        const block = builder.makeNext({ transactions: [payment] });

        assert.equal(await blockController.onBlock(block), true);

        // Recomputed from the confirmed transaction set (authoritative):
        // bob receives exactly 40, alice loses exactly 40 + fee. No rounding.
        assert.equal(ledger.chainBalance(keys.BOB_PUB), '40');
        assert.equal(
            ledger.chainBalance(keys.ALICE_PUB),
            new Big(100).minus(40).minus(payment.fee).toString(),
        );
    });

    it('NO INFLATION: the confirmed transaction set stays exactly zero-sum', async () => {
        // Across every address the signed transfers must net to zero — a block
        // cannot mint value out of thin air. (Fees are credited to the forger
        // off-transaction and are asserted separately in the balance suite.)
        const builder = new ChainBuilder(ledger, GENESIS_TS);
        const store = ledger.getStore();
        const funding = factories.makeTransaction({
            fromKey: keys.carol,
            to: keys.ALICE_PUB,
            amount: 100,
            timestamp: GENESIS_TS - 5,
        });
        store.transactions.set(funding.hash, funding);
        store.blockTransactions.push({ id: store.nextBlockTransactionId++, transactionHash: funding.hash, blockId: 0 });

        const payment = factories.makeTransaction({
            fromKey: keys.alice,
            to: keys.BOB_PUB,
            amount: 40,
            timestamp: GENESIS_TS + 10,
        });
        assert.equal(await blockController.onBlock(builder.makeNext({ transactions: [payment] })), true);

        // Sum of every address's net transaction flow == -(total fees paid).
        let net = new Big(0);
        let fees = new Big(0);
        for (const address of ledger.chainAddresses()) {
            net = net.plus(ledger.chainBalance(address));
        }
        for (const bt of store.blockTransactions) {
            const tx = store.transactions.get(bt.transactionHash);
            if (tx) fees = fees.plus(tx.fee);
        }
        assert.equal(net.plus(fees).toString(), '0', 'value was minted or destroyed');
    });

    it('removes included transactions from the mempool on acceptance', async () => {
        const builder = new ChainBuilder(ledger, GENESIS_TS);
        const store = ledger.getStore();
        const funding = factories.makeTransaction({
            fromKey: keys.carol,
            to: keys.ALICE_PUB,
            amount: 10,
            timestamp: GENESIS_TS - 5,
        });
        store.transactions.set(funding.hash, funding);
        store.blockTransactions.push({ id: store.nextBlockTransactionId++, transactionHash: funding.hash, blockId: 0 });

        const payment = factories.makeTransaction({
            fromKey: keys.alice,
            to: keys.BOB_PUB,
            amount: 5,
            timestamp: GENESIS_TS + 10,
        });
        store.pool.add(payment.hash);
        const block = builder.makeNext({ transactions: [payment] });

        await blockController.onBlock(block);
        assert.equal(store.pool.has(payment.hash), false, 'confirmed tx still in pool');
    });

    it('is idempotent against the block currently being processed (lock)', async () => {
        // Simulate a re-entrant delivery of the same height while it is locked.
        const builder = new ChainBuilder(ledger, GENESIS_TS);
        const block = builder.makeNext();
        state.setState(state.KEYS.PROCESSING_BLOCK_ID, block.id);
        const result = await blockController.onBlock(block);
        assert.equal(result, false, 'a block already being processed should be ignored');
    });
});
