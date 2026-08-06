require('../helpers/env');
const { describe, it, mock, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Big = require('big.js');
const keys = require('../helpers/keys');
const factories = require('../helpers/factories');
const { createLedger, installLedgerMocks } = require('../helpers/ledger');
const { BLOCKCHAIN_SETTINGS } = require('../../constants/app.constants');

const ledger = createLedger();
installLedgerMocks(mock, ledger);

const balanceService = require('../../services/balance.service');

const BURN = BLOCKCHAIN_SETTINGS.BURN_ADDRESS;

/**
 * Confirms transactions into a block so calculateBalance (which joins through
 * block_transactions) sees them.
 */
function confirm(transactions, blockId) {
    const store = ledger.getStore();
    for (const tx of transactions) {
        store.transactions.set(tx.hash, tx);
        store.blockTransactions.push({ id: store.nextBlockTransactionId++, transactionHash: tx.hash, blockId });
    }
}

beforeEach(() => {
    const store = ledger.getStore();
    store.transactions.clear();
    store.blockTransactions.length = 0;
    store.balances.clear();
    store.pool.clear();
    store.nextBlockTransactionId = 1;
});

describe('updateByTransaction — sender/recipient bookkeeping', () => {
    it('debits sender amount+fee and credits recipient the amount (new rows from chain)', async () => {
        // Fund alice on chain first so her recomputed balance is well-defined.
        confirm(
            [factories.makeTransaction({ fromKey: keys.carol, to: keys.ALICE_PUB, amount: 100, timestamp: 1 })],
            0,
        );
        const payment = factories.makeTransaction({ fromKey: keys.alice, to: keys.BOB_PUB, amount: 30, timestamp: 2 });
        confirm([payment], 1);

        await balanceService.updateByTransaction(payment, 1);

        // Rows are seeded from the authoritative chain recomputation.
        const bob = await ledger.balanceDao.getBalance(keys.BOB_PUB);
        const alice = await ledger.balanceDao.getBalance(keys.ALICE_PUB);
        assert.equal(new Big(bob.balance).toString(), '30');
        assert.equal(new Big(alice.balance).toString(), new Big(100).minus(30).minus(payment.fee).toString());
    });

    it('records burned amount to the burn tally when sending to the burn address', async () => {
        confirm(
            [factories.makeTransaction({ fromKey: keys.carol, to: keys.ALICE_PUB, amount: 500, timestamp: 1 })],
            0,
        );
        const burn = factories.makeTransaction({ fromKey: keys.alice, to: BURN, amount: 200, timestamp: 2 });
        confirm([burn], 1);

        await balanceService.updateByTransaction(burn, 1);

        const alice = await ledger.balanceDao.getBalance(keys.ALICE_PUB);
        assert.equal(new Big(alice.burned).toString(), '200', 'burn was not tallied');
    });
});

describe('getBurnedBalance — height-scoped forging weight', () => {
    it('counts only burns confirmed at or before the given block height', async () => {
        // Consensus weight must be identical on every node that agrees on the
        // chain prefix, so it is scoped by height, not by the mutable cache.
        confirm([factories.makeTransaction({ fromKey: keys.alice, to: BURN, amount: 100, timestamp: 1 })], 5);
        confirm([factories.makeTransaction({ fromKey: keys.alice, to: BURN, amount: 250, timestamp: 2 })], 8);

        assert.equal(await balanceService.getBurnedBalance(keys.ALICE_PUB, 5), 100);
        assert.equal(await balanceService.getBurnedBalance(keys.ALICE_PUB, 7), 100);
        assert.equal(await balanceService.getBurnedBalance(keys.ALICE_PUB, 8), 350);
        assert.equal(await balanceService.getBurnedBalance(keys.ALICE_PUB, 100), 350);
        assert.equal(await balanceService.getBurnedBalance(keys.BOB_PUB, 100), 0);
    });
});

describe('updateByBlock — fee crediting to the forger', () => {
    it('credits the forger the EXACT fee sum with no float drift (increment path)', async () => {
        // The forger fee is applied by INCREMENT, which only happens when the
        // forger already has a balance row from an earlier block (a fresh or
        // same-block row is recomputed from chain and would ignore off-chain
        // fees). Model that realistic path.
        //
        // Fees are deliberately drift-prone: 0.00001+0.00002+0.00003 sums to
        // 0.00006000000000000001 under IEEE-754 `+=`. After the big.js fix in
        // updateByBlock the stored credit must be EXACTLY 0.00006.
        const recipient = keys.pub(keys.keyAt(9));
        await ledger.balanceDao.create(keys.FORGER_PUB, 5, 0, 0);

        const senders = [keys.alice, keys.bob, keys.carol];
        confirm(
            senders.map((key, i) =>
                factories.makeTransaction({ fromKey: keys.keyAt(20 + i), to: key.publicKey.toString('hex'), amount: 1000, timestamp: i + 1 }),
            ),
            0,
        );
        // Amounts 0.1/0.2/0.3 → uncapped fees 0.00001/0.00002/0.00003.
        const amounts = [0.1, 0.2, 0.3];
        const txs = senders.map((key, i) =>
            factories.makeTransaction({ fromKey: key, to: recipient, amount: amounts[i], timestamp: 100 + i }),
        );
        assert.deepEqual(txs.map((tx) => tx.fee), [0.00001, 0.00002, 0.00003]);
        // Sanity: naive float accumulation really does drift for these values.
        let naive = 0;
        for (const tx of txs) naive += tx.fee;
        assert.notEqual(naive, 0.00006);
        confirm(txs, 1);

        const block = { id: 1, publicKey: keys.FORGER_PUB, transactions: txs };
        await balanceService.updateByBlock(block, undefined);

        const forger = await ledger.balanceDao.getBalance(keys.FORGER_PUB);
        // Prior 5 + fees 0.00006, exact — the whole point of the fix.
        assert.equal(new Big(forger.balance).toString(), '5.00006');
    });
});

describe('changeOrCreateBalance — idempotent same-block re-application', () => {
    it('re-applying within the same block recomputes from chain (no double count)', async () => {
        // If a balance row already reflects this block, a second change must
        // resync from the chain rather than increment again (prevents phantom
        // balance on retries within one block).
        confirm(
            [factories.makeTransaction({ fromKey: keys.carol, to: keys.ALICE_PUB, amount: 100, timestamp: 1 })],
            0,
        );
        const payment = factories.makeTransaction({ fromKey: keys.alice, to: keys.BOB_PUB, amount: 40, timestamp: 2 });
        confirm([payment], 3);

        await balanceService.changeOrCreateBalance(keys.ALICE_PUB, -40, 0, 3);
        const afterFirst = await ledger.balanceDao.getBalance(keys.ALICE_PUB);
        // Second application at the SAME block id → recompute path, same result.
        await balanceService.changeOrCreateBalance(keys.ALICE_PUB, -40, 0, 3);
        const afterSecond = await ledger.balanceDao.getBalance(keys.ALICE_PUB);
        assert.equal(afterSecond.balance, afterFirst.balance, 'balance double-counted on same-block re-apply');
    });
});
