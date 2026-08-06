require('../helpers/env');
const { describe, it, mock, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Big = require('big.js');
const keys = require('../helpers/keys');
const factories = require('../helpers/factories');
const { FIXED_NOW_MS, FIXED_NOW_SECONDS } = require('../helpers/env');
const { createLedger, installLedgerMocks } = require('../helpers/ledger');

const ledger = createLedger();
installLedgerMocks(mock, ledger);

// Required AFTER storage mocks.
const transactionService = require('../../services/transaction.service');

const T0 = FIXED_NOW_SECONDS;

/** A fully valid transaction from alice to bob. */
const validTx = (overrides = {}) =>
    factories.makeTransaction({
        fromKey: keys.alice,
        to: keys.BOB_PUB,
        amount: 25,
        timestamp: T0,
        ...overrides,
    });

/** Seeds alice's cached balance so balance validation passes. */
async function seedBalance(address, balance) {
    const store = ledger.getStore();
    store.balances.delete(address);
    await ledger.balanceDao.create(address, balance, 0, 1);
}

describe('calculateFee', () => {
    it('charges exactly 0.01% with decimal precision (no float drift)', () => {
        // Fee correctness is consensus-critical: validateFee recomputes the fee
        // on every node, so any nondeterminism forks the network.
        assert.equal(transactionService.calculateFee(1), 0.0001);
        assert.equal(transactionService.calculateFee(50), 0.005);
        assert.equal(transactionService.calculateFee(99.99), 0.009999);
        // 0.3 * 0.0001 in binary floats is 3.0000000000000004e-5; the exact
        // decimal answer is 0.00003. The implementation must produce the latter.
        assert.equal(transactionService.calculateFee(0.3), 0.00003);
        assert.equal(transactionService.calculateFee(0.0001), 1e-8);
    });

    it('caps the fee at exactly 0.01, boundary included', () => {
        assert.equal(transactionService.calculateFee(100), 0.01); // exact cap boundary
        assert.equal(transactionService.calculateFee(100.00000001), 0.01);
        assert.equal(transactionService.calculateFee(1_000_000), 0.01);
        assert.equal(transactionService.calculateFee(100_000_000), 0.01);
    });
});

describe('validateAmount', () => {
    it('rejects non-positive amounts (the sign-flip theft vector)', () => {
        // A signed transaction with amount < 0 would otherwise DEBIT the
        // recipient and CREDIT the sender in updateByTransaction — the classic
        // negative-value theft. Zero must also fail (spam / no-op with fee 0).
        for (const amount of [-1, -0.00000001, 0, -1e308]) {
            const result = transactionService.validateAmount({ amount, fee: 0 });
            assert.equal(result.valid, false, `amount ${amount} was accepted`);
        }
    });

    it('rejects negative fees (fee-refund theft vector)', () => {
        const result = transactionService.validateAmount({ amount: 5, fee: -0.01 });
        assert.equal(result.valid, false);
    });

    it('rejects NaN / Infinity / non-numeric garbage without throwing', () => {
        for (const bad of [NaN, Infinity, -Infinity, 'abc', null, undefined, {}, []]) {
            for (const target of ['amount', 'fee']) {
                const transaction = { amount: 5, fee: 0.0005, [target]: bad };
                let result;
                assert.doesNotThrow(() => {
                    result = transactionService.validateAmount(transaction);
                });
                assert.equal(result.valid, false, `${target}=${String(bad)} was accepted`);
            }
        }
    });

    it('accepts the smallest protocol amount and huge (but finite) amounts', () => {
        assert.equal(transactionService.validateAmount({ amount: 1e-10, fee: 0 }).valid, true);
        assert.equal(
            transactionService.validateAmount({ amount: 100_000_000, fee: 0.01 }).valid,
            true,
        );
        // Beyond MAX_SAFE_INTEGER: big.js must keep exactness, not overflow.
        assert.equal(
            transactionService.validateAmount({ amount: 9_007_199_254_740_993, fee: 0 }).valid,
            true,
        );
    });
});

describe('validateHash / validateSignature — transaction integrity', () => {
    it('accepts an honest transaction', () => {
        const transaction = validTx();
        assert.equal(transactionService.validateHash(transaction), true);
        assert.equal(transactionService.validateSignature(transaction), true);
    });

    it('any mutation of a hashed field invalidates the hash (tamper evidence)', () => {
        const transaction = validTx();
        const mutations = {
            from: keys.MALLORY_PUB, // redirect blame
            to: keys.MALLORY_PUB, // redirect funds
            amount: transaction.amount + 0.00000001, // inflate payment
            timestamp: transaction.timestamp + 1, // replay at a new identity
        };
        for (const [field, value] of Object.entries(mutations)) {
            const tampered = { ...transaction, [field]: value };
            assert.equal(
                transactionService.validateHash(tampered),
                false,
                `tampering "${field}" was not detected by the hash`,
            );
        }
    });

    it('fee is NOT covered by the hash but IS bound by validateFee recomputation', () => {
        // The hash covers (from, to, timestamp, amount) only. A relay could
        // alter the fee field without breaking hash or signature — the reason
        // this is safe is that validateFee recomputes the fee from the amount
        // deterministically and rejects any deviation. Both halves are asserted
        // so a future refactor cannot silently drop the recomputation guard.
        const transaction = validTx();
        const tampered = { ...transaction, fee: transaction.fee + 0.001 };
        assert.equal(transactionService.validateHash(tampered), true); // hash blind to fee...
        assert.equal(transactionService.validateSignature(tampered), true);
        assert.equal(transactionService.validateFee(tampered), false); // ...but recomputation catches it
        assert.equal(transactionService.validateFee(transaction), true);
    });

    it('rejects a signature transplanted from a different signer', () => {
        const honest = validTx();
        const forged = {
            ...honest,
            signature: keys.mallory.sign(Buffer.from(honest.hash, 'hex')).toString('hex'),
        };
        assert.equal(transactionService.validateSignature(forged), false);
    });

    it('rejects a self-consistent transaction whose "from" is not the real signer', () => {
        // Mallory builds a transaction spending from alice's account, hashes it
        // correctly, signs it with her own key. Hash validation passes —
        // signature validation must be what stops the theft.
        const theft = {
            from: keys.ALICE_PUB,
            to: keys.MALLORY_PUB,
            amount: 10,
            timestamp: T0,
            fee: transactionService.calculateFee(10),
        };
        theft.hash = require('../../lib/crypto-utils.lib').generateDomainHash(
            'transaction',
            ['from', 'to', 'timestamp', 'amount'],
            theft,
        );
        theft.signature = keys.mallory.sign(Buffer.from(theft.hash, 'hex')).toString('hex');
        assert.equal(transactionService.validateHash(theft), true);
        assert.equal(transactionService.validateSignature(theft), false);
    });
});

describe('validateTransactionBalance', () => {
    beforeEach(() => {
        const store = ledger.getStore();
        store.balances.clear();
        store.transactions.clear();
        store.blockTransactions.length = 0;
    });

    it('allows spending the entire balance to the last exact decimal', async () => {
        const transaction = validTx({ amount: 10 });
        await seedBalance(keys.ALICE_PUB, new Big(10).plus(transaction.fee).toNumber());
        assert.equal(await transactionService.validateTransactionBalance(transaction), true);
    });

    it('rejects when required exceeds balance by one atomic unit', async () => {
        const transaction = validTx({ amount: 10 });
        const oneShort = new Big(10).plus(transaction.fee).minus('0.0000000001').toNumber();
        await seedBalance(keys.ALICE_PUB, oneShort);
        assert.equal(await transactionService.validateTransactionBalance(transaction), false);
    });

    it('the fee counts against the balance (amount alone is not enough)', async () => {
        const transaction = validTx({ amount: 10 });
        await seedBalance(keys.ALICE_PUB, 10);
        assert.equal(await transactionService.validateTransactionBalance(transaction), false);
    });

    it('falls back to the authoritative on-chain balance when the cache row is missing', async () => {
        // After a reorg flushes the balance cache the sender must not be treated
        // as broke — the chain is the source of truth.
        const store = ledger.getStore();
        const funding = factories.makeTransaction({
            fromKey: keys.carol,
            to: keys.ALICE_PUB,
            amount: 50,
            timestamp: T0 - 100,
        });
        store.transactions.set(funding.hash, funding);
        store.blockTransactions.push({ id: 1, transactionHash: funding.hash, blockId: 1 });

        const transaction = validTx({ amount: 10 });
        assert.equal(await transactionService.validateTransactionBalance(transaction), true);
    });

    it('unknown sender with no history has zero balance and cannot spend', async () => {
        assert.equal(await transactionService.validateTransactionBalance(validTx()), false);
    });
});

describe('checkDuplicatedSender — in-block double spend guard', () => {
    it('flags two transactions from the same sender in one block', () => {
        // Balance validation checks each transaction against the CURRENT
        // balance; two spends of the same funds in one block would both pass
        // individually. One-sender-per-block is the double-spend guard.
        const first = validTx({ amount: 1 });
        const second = validTx({ amount: 2 });
        const result = transactionService.checkDuplicatedSender([first, second]);
        assert.equal(result.valid, false);
        assert.equal(result.error, 'Possible double spend');
    });

    it('accepts distinct senders and the empty set', () => {
        const txs = [
            validTx(),
            factories.makeTransaction({ fromKey: keys.bob, to: keys.CAROL_PUB, amount: 1, timestamp: T0 }),
            factories.makeTransaction({ fromKey: keys.carol, to: keys.BOB_PUB, amount: 1, timestamp: T0 }),
        ];
        assert.equal(transactionService.checkDuplicatedSender(txs).valid, true);
        assert.equal(transactionService.checkDuplicatedSender([]).valid, true);
    });

    it('finds the duplicate even among many senders', () => {
        const txs = [];
        for (const key of [keys.alice, keys.bob, keys.carol, keys.mallory]) {
            txs.push(
                factories.makeTransaction({ fromKey: key, to: keys.FORGER_PUB, amount: 1, timestamp: T0 }),
            );
        }
        txs.push(factories.makeTransaction({ fromKey: keys.carol, to: keys.FORGER_PUB, amount: 2, timestamp: T0 + 1 }));
        assert.equal(transactionService.checkDuplicatedSender(txs).valid, false);
    });
});

describe('validateTransaction — full pipeline and error precedence', () => {
    beforeEach(async () => {
        const store = ledger.getStore();
        store.balances.clear();
        await seedBalance(keys.ALICE_PUB, 1_000);
    });

    it('accepts a fully valid transaction', async () => {
        assert.deepEqual(await transactionService.validateTransaction(validTx()), { valid: true });
    });

    it('reports precise errors for each failure class', async () => {
        const honest = validTx({ amount: 10 });
        const cases = [
            [{ ...honest, amount: -5 }, 'Transaction amount must be positive'],
            [{ ...honest, timestamp: honest.timestamp + 1 }, 'Invalid transaction hash'],
            [
                {
                    ...honest,
                    signature: keys.mallory.sign(Buffer.from(honest.hash, 'hex')).toString('hex'),
                },
                'Invalid transaction signature',
            ],
            [{ ...honest, fee: 0.009 }, 'Invalid transaction fee'],
            [validTx({ amount: 5_000 }), 'Invalid transaction sender balance'],
        ];
        for (const [transaction, expectedError] of cases) {
            const result = await transactionService.validateTransaction(transaction);
            assert.equal(result.valid, false);
            assert.equal(result.error, expectedError);
        }
    });
});

describe('newTransaction — persistence and replay', () => {
    beforeEach(async () => {
        const store = ledger.getStore();
        store.balances.clear();
        store.transactions.clear();
        store.blockTransactions.length = 0;
        await seedBalance(keys.ALICE_PUB, 1_000);
    });

    it('persists a valid transaction', async () => {
        const transaction = validTx();
        await transactionService.newTransaction(transaction);
        assert.deepEqual(await ledger.transactionDao.findOne(transaction.hash), transaction);
    });

    it('REPLAY: re-submitting the identical signed transaction is rejected', async () => {
        // Without this, anyone observing the network could re-broadcast a
        // payment and drain the sender by repetition.
        const transaction = validTx();
        await transactionService.newTransaction(transaction);
        await assert.rejects(
            () => transactionService.newTransaction(transaction),
            /already exists/,
        );
        // Store must still contain exactly one copy.
        assert.equal(ledger.getStore().transactions.size, 1);
    });

    it('an invalid transaction is never persisted', async () => {
        const before = ledger.dump();
        await assert.rejects(() =>
            transactionService.newTransaction({ ...validTx(), amount: -1 }),
        );
        assert.deepEqual(ledger.dump(), before);
    });
});

describe('generateTransaction', () => {
    it('produces a transaction that passes every validator (mocked clock)', (t) => {
        t.mock.timers.enable({ apis: ['Date'], now: FIXED_NOW_MS });
        const produced = transactionService.generateTransaction(keys.BOB_PUB, 42, keys.alice);
        assert.equal(produced.timestamp, FIXED_NOW_SECONDS);
        assert.equal(transactionService.validateHash(produced), true);
        assert.equal(transactionService.validateSignature(produced), true);
        assert.equal(transactionService.validateFee(produced), true);
        assert.equal(transactionService.validateAmount(produced).valid, true);
    });

    it('matches the independent factory implementation byte-for-byte', (t) => {
        // Two separately written implementations of transaction assembly must
        // agree exactly — catches drift in hash params, fee math, or signing.
        t.mock.timers.enable({ apis: ['Date'], now: FIXED_NOW_MS });
        const produced = transactionService.generateTransaction(keys.BOB_PUB, 42, keys.alice);
        const factored = factories.makeTransaction({
            fromKey: keys.alice,
            to: keys.BOB_PUB,
            amount: 42,
            timestamp: FIXED_NOW_SECONDS,
        });
        assert.deepEqual(produced, factored);
    });
});
