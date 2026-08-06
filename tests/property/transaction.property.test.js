require('../helpers/env');
const { describe, it, mock } = require('node:test');
const assert = require('node:assert/strict');
const Big = require('big.js');
const keys = require('../helpers/keys');
const factories = require('../helpers/factories');
const { forAll } = require('../helpers/prng');
const { createLedger, installLedgerMocks } = require('../helpers/ledger');

const ledger = createLedger();
installLedgerMocks(mock, ledger);

const transactionService = require('../../services/transaction.service');

const SIGNERS = [keys.forger, keys.alice, keys.bob, keys.carol, keys.mallory];
const RECIPIENTS = [keys.FORGER_PUB, keys.ALICE_PUB, keys.BOB_PUB, keys.CAROL_PUB, keys.MALLORY_PUB];

const randomTx = (rng) =>
    factories.makeTransaction({
        fromKey: rng.pick(SIGNERS),
        to: rng.pick(RECIPIENTS),
        amount: rng.amount(),
        timestamp: rng.int(1, 2_000_000_000),
    });

describe('transaction generation invariants', () => {
    it('every honestly generated transaction passes hash/signature/fee/amount validation', () => {
        forAll(
            { name: 'tx-roundtrip', seed: 0x7a11, runs: 400 },
            randomTx,
            (transaction) => {
                assert.equal(transactionService.validateHash(transaction), true, 'hash');
                assert.equal(transactionService.validateSignature(transaction), true, 'signature');
                assert.equal(transactionService.validateFee(transaction), true, 'fee');
                assert.equal(transactionService.validateAmount(transaction).valid, true, 'amount');
            },
        );
    });

    it('transaction id (hash) is stable across re-serialization and property order', () => {
        // Serialization roundtrip: a transaction relayed as JSON and parsed back
        // (in any property order) must keep the same identity — otherwise the
        // same payment could exist under two ids (replay/dedup break).
        forAll(
            { name: 'tx-id-stability', seed: 0x51ab1e, runs: 300 },
            randomTx,
            (transaction) => {
                const roundtripped = JSON.parse(JSON.stringify(transaction));
                const reordered = JSON.parse(
                    JSON.stringify(roundtripped, ['signature', 'fee', 'amount', 'timestamp', 'to', 'from', 'hash']),
                );
                assert.equal(transactionService.validateHash(roundtripped), true);
                assert.equal(transactionService.validateHash(reordered), true);
            },
        );
    });

    it('fee is always in [0, 0.01] and monotone non-decreasing in amount', () => {
        forAll(
            { name: 'fee-bounds', seed: 0xfee5, runs: 1000 },
            (rng) => ({ a: rng.amount(), b: rng.amount() }),
            ({ a, b }) => {
                const feeA = transactionService.calculateFee(a);
                const feeB = transactionService.calculateFee(b);
                assert.ok(feeA >= 0 && feeA <= 0.01, `fee ${feeA} out of bounds`);
                if (a <= b) assert.ok(feeA <= feeB, `fee not monotone: f(${a})=${feeA} > f(${b})=${feeB}`);
                else assert.ok(feeB <= feeA);
            },
        );
    });

    it('fee equals the exact decimal 0.01% (independent Big computation)', () => {
        forAll(
            { name: 'fee-exactness', seed: 0xfee6, runs: 1000 },
            (rng) => rng.amount(),
            (amount) => {
                const expected = Math.min(new Big(amount).div(10_000).toNumber(), 0.01);
                assert.equal(transactionService.calculateFee(amount), expected);
            },
        );
    });
});

describe('transaction mutation invariants (unforgeability)', () => {
    it('mutating any signed field is always detected by hash or signature check', () => {
        forAll(
            { name: 'tx-mutation-detected', seed: 0xdef7, runs: 400 },
            (rng) => {
                const transaction = randomTx(rng);
                const field = rng.pick(['from', 'to', 'amount', 'timestamp']);
                const mutated = { ...transaction };
                if (field === 'amount') mutated.amount = transaction.amount + rng.amount();
                else if (field === 'timestamp') mutated.timestamp = transaction.timestamp + rng.int(1, 1e6);
                else {
                    let other = rng.hex(66);
                    while (other === transaction[field]) other = rng.hex(66);
                    mutated[field] = other;
                }
                return { mutated, field };
            },
            ({ mutated, field }) => {
                const caught =
                    !transactionService.validateHash(mutated) ||
                    !transactionService.validateSignature(mutated);
                assert.equal(caught, true, `mutation of "${field}" slipped through`);
            },
        );
    });

    it('recomputing the hash after mutation still fails on the signature', () => {
        // A smarter attacker re-hashes after tampering so validateHash passes;
        // the signature over the new hash must then fail (they lack the key).
        const cryptoUtilsLib = require('../../lib/crypto-utils.lib');
        forAll(
            { name: 'tx-rehash-attack', seed: 0x4e4a54, runs: 300 },
            (rng) => {
                const transaction = factories.makeTransaction({
                    fromKey: keys.alice,
                    to: rng.pick(RECIPIENTS),
                    amount: rng.amount(),
                    timestamp: rng.int(1, 2_000_000_000),
                });
                const mutated = { ...transaction, amount: transaction.amount + 1 };
                mutated.hash = cryptoUtilsLib.generateDomainHash(
                    'transaction',
                    ['from', 'to', 'timestamp', 'amount'],
                    mutated,
                );
                return mutated;
            },
            (mutated) => {
                assert.equal(transactionService.validateHash(mutated), true);
                assert.equal(transactionService.validateSignature(mutated), false);
            },
        );
    });
});
