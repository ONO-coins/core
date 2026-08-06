require('../helpers/env');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const keys = require('../helpers/keys');
const factories = require('../helpers/factories');

/**
 * REAL PostgreSQL integration. Everything else in the suite mocks the storage
 * layer; this file exercises the genuine Sequelize models, DAO SQL (including
 * the raw multi-statement rollback query) and DECIMAL(27,18) precision against
 * a live database — the one thing unit mocks cannot guarantee.
 *
 * GATED: skipped unless RUN_PG_INTEGRATION=true and a database is reachable, so
 * the default `npm test` stays hermetic and offline. Run with:
 *   npm run test:integration        (uses .env.test.local; needs local pg)
 * or set RUN_PG_INTEGRATION=true plus DATABASE_* env vars.
 *
 * DATABASE_FORCE_SYNC is honoured by the postgres constructor, so the test DB
 * schema is (re)created on boot. NEVER point this at production data.
 */

const ENABLED = process.env.RUN_PG_INTEGRATION === 'true';

describe('postgres integration', { skip: ENABLED ? false : 'set RUN_PG_INTEGRATION=true (and DATABASE_* / a running postgres) to run' }, () => {
    let database;
    let blockService;
    let blockDao;
    let transactionDao;
    let balanceDao;
    let state;

    before(async () => {
        process.env.DATABASE_FORCE_SYNC = 'true';
        process.env.TESTNET = 'false';
        database = require('../../databases/postgres');
        await database.init();
        state = require('../../state');
        state.init();
        blockService = require('../../services/block.service');
        blockDao = require('../../databases/postgres/dao/block.dao');
        transactionDao = require('../../databases/postgres/dao/transaction.dao');
        balanceDao = require('../../databases/postgres/dao/balance.dao');
    });

    after(async () => {
        if (database?.getSequelize) await database.getSequelize().close();
    });

    it('creates the genesis block and initial allocations on a fresh database', async () => {
        await blockService.init();
        const genesis = await blockDao.getById(0);
        assert.ok(genesis, 'genesis block missing');
        assert.equal(genesis.id, 0);
        assert.equal(genesis.target, 2147483647);
    });

    it('persists a transaction and reads it back with DECIMAL precision intact', async () => {
        // A satoshi-scale amount (10 decimal places) must survive the round trip
        // through DECIMAL(27,18) with no truncation or float rounding.
        const tx = factories.makeTransaction({
            fromKey: keys.alice,
            to: keys.BOB_PUB,
            amount: 12345.0000000001,
            timestamp: 1731330100,
        });
        await transactionDao.create(tx);
        const readBack = await transactionDao.findOne(tx.hash);
        assert.equal(Number(readBack.amount), 12345.0000000001);
        assert.equal(readBack.hash, tx.hash);
    });

    it('enforces the primary-key uniqueness of transaction hashes', async () => {
        const tx = factories.makeTransaction({ fromKey: keys.carol, to: keys.BOB_PUB, amount: 5, timestamp: 1731330200 });
        await transactionDao.create(tx);
        await assert.rejects(() => transactionDao.create(tx), /Unique|unique|duplicate/i);
    });

    it('round-trips a balance row and flushes it on reorg boundary', async () => {
        await balanceDao.create(keys.MALLORY_PUB, 77.25, 0, 3);
        const before = await balanceDao.getBalance(keys.MALLORY_PUB);
        assert.equal(Number(before.balance), 77.25);
        // flushBalancesFromBlock removes rows affected after the given height.
        await balanceDao.flushBalancesFromBlock(2);
        const after = await balanceDao.getBalance(keys.MALLORY_PUB);
        assert.equal(after, null, 'balance row was not flushed on reorg');
    });
});
