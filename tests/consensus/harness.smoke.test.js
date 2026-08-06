require('../helpers/env');
const { describe, it, mock, before } = require('node:test');
const assert = require('node:assert/strict');
const keys = require('../helpers/keys');
const factories = require('../helpers/factories');
const { createLedger, installLedgerMocks, installWalletMock } = require('../helpers/ledger');
const { INITIAL_BLOCK, INITIAL_TRANSACTIONS } = require('../../constants/app.constants');

/**
 * Harness self-test. Everything else in tests/consensus builds on the pattern
 * proven here: install storage mocks → require PRODUCTION modules → drive them.
 * If this file fails, distrust every other consensus result.
 */

const ledger = createLedger();
installLedgerMocks(mock, ledger);
installWalletMock(mock, keys.forger);

// Required AFTER mocks: pulls the mocked DAO layer instead of Sequelize models.
const blockService = require('../../services/block.service');
const state = require('../../state');

describe('consensus test harness', () => {
    before(async () => {
        state.init();
        await blockService.init();
    });

    it('production init() creates the exact genesis block and allocations', async () => {
        const genesis = await ledger.blockDao.getById(0);
        assert.deepEqual(genesis, INITIAL_BLOCK);

        // Every initial allocation must be credited exactly once.
        for (const transaction of INITIAL_TRANSACTIONS) {
            const stored = await ledger.transactionDao.findOne(transaction.hash);
            assert.ok(stored, `initial transaction ${transaction.hash} missing`);
        }
        // The genesis supply equals the declared allocation, computed with
        // EXACT decimal arithmetic (naive float `+` drifts by 2e-8 here —
        // the same defect class this suite hunts in production code).
        const Big = require('big.js');
        const chainSum = INITIAL_TRANSACTIONS.filter(
            (transaction) =>
                transaction.from ===
                '000000000000000000000000000000000000000000000000000000000000000001',
        ).reduce((sum, transaction) => sum.plus(transaction.amount), new Big(0));
        assert.equal(chainSum.toString(), '100003000.03');
    });

    it('transaction rollback restores the store byte-for-byte', async () => {
        const before = ledger.dump();
        const databaseTransaction = await ledger.fakeSequelize.transaction();
        await ledger.blockDao.create({ id: 999, hash: 'x'.repeat(64), target: 5, publicKey: 'p', timestamp: 1, previousHash: 'y'.repeat(64), signature: 's', generationSignature: 'g' });
        await ledger.balanceDao.create('someaddress', 5, 0, 999);
        assert.notDeepEqual(ledger.dump(), before);
        await databaseTransaction.rollback();
        assert.deepEqual(ledger.dump(), before);
    });

    it('unique constraints behave like postgres (duplicate block id throws)', async () => {
        const genesis = await ledger.blockDao.getById(0);
        await assert.rejects(
            () => ledger.blockDao.create(genesis),
            (error) => error.name === 'SequelizeUniqueConstraintError',
        );
    });

    it('independent factory block hashing matches production block hashing', () => {
        const parent = {
            id: 0,
            hash: INITIAL_BLOCK.hash,
            target: INITIAL_BLOCK.target,
            timestamp: INITIAL_BLOCK.timestamp,
            generationSignature: INITIAL_BLOCK.generationSignature,
        };
        const block = factories.makeBlock({
            parent,
            forgerKey: keys.forger,
            timestamp: parent.timestamp + 10,
        });
        // Production validators must agree the factory block is internally valid.
        assert.equal(blockService.checkBlockHash(block), true);
        assert.equal(blockService.checkBlockSignature(block), true);
        assert.equal(blockService.generateHash(block), block.hash);
        // And production target derivation must match the factory's independent one.
        assert.equal(
            blockService.createBlockTarget(parent, block.timestamp),
            factories.expectedTarget(parent, block.timestamp),
        );
    });

    it('factory block generation matches production generateBlock exactly', () => {
        const parent = {
            id: 0,
            hash: INITIAL_BLOCK.hash,
            target: INITIAL_BLOCK.target,
            timestamp: INITIAL_BLOCK.timestamp,
            generationSignature: INITIAL_BLOCK.generationSignature,
        };
        const timestamp = parent.timestamp + 7;
        const produced = blockService.generateBlock(
            parent,
            keys.FORGER_PUB,
            timestamp,
            [],
            keys.forger,
        );
        const factored = factories.makeBlock({
            parent,
            forgerKey: keys.forger,
            timestamp,
        });
        assert.deepEqual(produced, factored);
    });
});
