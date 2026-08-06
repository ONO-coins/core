require('../helpers/env');
process.env.ALLOW_SECURE_ROUTES = 'true';
process.env.SECURE_ROUTES_AUTHORIZATION_HEADER = 'super-secret-token';

const { describe, it, mock, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const keys = require('../helpers/keys');
const factories = require('../helpers/factories');
const { createLedger, installLedgerMocks, installWalletMock, installP2pActionsMock } = require('../helpers/ledger');

const ledger = createLedger();
installLedgerMocks(mock, ledger);
installWalletMock(mock, keys.forger);
const p2pCalls = installP2pActionsMock(mock);

// p2p-client is pulled by the peer controller; stub its dial-out.
const path = require('node:path');
const connectCalls = [];
mock.module(path.join(__dirname, '..', '..', 'p2p/p2p-client.js'), {
    namedExports: { connectToPear: (address, save) => connectCalls.push({ address, save }) },
});
// p2p-sockets is pulled by the secure /stats controller.
mock.module(path.join(__dirname, '..', '..', 'p2p/p2p-sockets.js'), {
    namedExports: { getKeys: () => ['ws://peer-a:1', 'ws://peer-b:2'] },
});

const httpServer = require('../../http-server');
const state = require('../../state');
const blockService = require('../../services/block.service');

const AUTH = 'super-secret-token';
const GOOD_ADDRESS = keys.ALICE_PUB; // 66 hex chars
const app = httpServer.createApp();

async function seedGenesis() {
    const store = ledger.getStore();
    store.blocks.clear();
    store.transactions.clear();
    store.blockTransactions.length = 0;
    store.balances.clear();
    store.pool.clear();
    store.nextBlockTransactionId = 1;
    state.init();
    await blockService.init();
}

before(async () => {
    await seedGenesis();
});

describe('GET /balance/:address — path param validation', () => {
    it('returns the balance record for a valid 66-char address', async () => {
        await ledger.balanceDao.create(GOOD_ADDRESS, 123.5, 0, 1);
        const res = await request(app).get(`/balance/${GOOD_ADDRESS}`);
        assert.equal(res.status, 200);
        assert.equal(res.body.address, GOOD_ADDRESS);
        assert.equal(Number(res.body.balance), 123.5);
    });

    it('rejects an address of the wrong length (schema minLength/maxLength)', async () => {
        const res = await request(app).get('/balance/tooshort');
        assert.equal(res.status, 400);
        assert.ok(res.body.error, 'expected a validation error body');
    });

    it('returns null (200) for an unknown but well-formed address', async () => {
        const res = await request(app).get(`/balance/${keys.CAROL_PUB}`);
        assert.equal(res.status, 200);
        assert.equal(res.body, null);
    });
});

describe('GET /block/:id and /block/chain', () => {
    it('serves a stored block by id', async () => {
        const res = await request(app).get('/block/0');
        assert.equal(res.status, 200);
        assert.equal(res.body.id, 0);
        assert.ok(Array.isArray(res.body.transactions));
    });

    it('rejects a negative id (schema minimum: 0)', async () => {
        const res = await request(app).get('/block/-5');
        assert.equal(res.status, 400);
    });

    it('rejects a non-integer id', async () => {
        const res = await request(app).get('/block/notanumber');
        assert.equal(res.status, 400);
    });

    it('serves the chain from genesis and caps limit at 30', async () => {
        const res = await request(app).get('/block/chain?fromId=0');
        assert.equal(res.status, 200);
        assert.ok(Array.isArray(res.body));
        const tooBig = await request(app).get('/block/chain?limit=1000');
        assert.equal(tooBig.status, 400, 'limit above the schema maximum must be rejected');
    });
});

describe('POST /transaction/init — body validation and processing', () => {
    beforeEach(async () => {
        await seedGenesis();
        // Fund alice on-chain so her transaction passes balance validation.
        const store = ledger.getStore();
        const funding = factories.makeTransaction({ fromKey: keys.carol, to: keys.ALICE_PUB, amount: 1000, timestamp: 1731330000 });
        store.transactions.set(funding.hash, funding);
        store.blockTransactions.push({ id: store.nextBlockTransactionId++, transactionHash: funding.hash, blockId: 0 });
    });

    it('accepts a valid signed transaction, pools it, and broadcasts it', async () => {
        const tx = factories.makeTransaction({ fromKey: keys.alice, to: keys.BOB_PUB, amount: 10, timestamp: 1731330050 });
        const res = await request(app).post('/transaction/init').send(tx);
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal(res.body.hash, tx.hash);
        assert.ok(ledger.getStore().pool.has(tx.hash), 'transaction was not pooled');
        assert.equal(p2pCalls.broadcastTransaction.at(-1).transaction.hash, tx.hash);
    });

    it('rejects a body with a missing required field (OpenAPI schema)', async () => {
        const tx = factories.makeTransaction({ fromKey: keys.alice, to: keys.BOB_PUB, amount: 10, timestamp: 1731330050 });
        delete tx.signature;
        const res = await request(app).post('/transaction/init').send(tx);
        assert.equal(res.status, 400);
    });

    it('rejects unknown extra properties (additionalProperties: false)', async () => {
        const tx = { ...factories.makeTransaction({ fromKey: keys.alice, to: keys.BOB_PUB, amount: 10, timestamp: 1731330050 }), injected: 'x' };
        const res = await request(app).post('/transaction/init').send(tx);
        assert.equal(res.status, 400);
    });

    it('rejects a non-positive amount at the schema boundary', async () => {
        const tx = factories.makeTransaction({ fromKey: keys.alice, to: keys.BOB_PUB, amount: 10, timestamp: 1731330050 });
        const res = await request(app).post('/transaction/init').send({ ...tx, amount: 0 });
        assert.equal(res.status, 400);
    });

    it('rejects malformed JSON bodies with 400, not a crash', async () => {
        const res = await request(app)
            .post('/transaction/init')
            .set('Content-Type', 'application/json')
            .send('{ this is not json ');
        assert.equal(res.status, 400);
    });

    it('rejects a schema-valid but cryptographically invalid transaction (bad signature)', async () => {
        // Passes OpenAPI shape validation but must fail domain validation —
        // proves the controller does not trust the schema alone.
        const tx = factories.makeTransaction({ fromKey: keys.alice, to: keys.BOB_PUB, amount: 10, timestamp: 1731330050 });
        tx.signature = keys.mallory.sign(Buffer.from(tx.hash, 'hex')).toString('hex');
        const res = await request(app).post('/transaction/init').send(tx);
        assert.equal(res.status, 400);
        assert.match(res.body.error, /signature/i);
    });
});

describe('POST /peer — body validation', () => {
    it('accepts an http(s) URL and triggers a dial-out', async () => {
        const res = await request(app).post('/peer').send({ address: 'http://peer.example:5000' });
        assert.equal(res.status, 200);
        assert.equal(connectCalls.at(-1).address, 'http://peer.example:5000');
    });

    it('rejects an address that does not match the http(s) pattern', async () => {
        const res = await request(app).post('/peer').send({ address: 'ftp://peer.example:5000' });
        assert.equal(res.status, 400);
    });

    it('rejects a missing address', async () => {
        const res = await request(app).post('/peer').send({});
        assert.equal(res.status, 400);
    });
});

describe('/secure/* — authorization matrix', () => {
    it('rejects a request with no authorization header (OpenAPI requires it)', async () => {
        // The spec marks the authorization header required, so the request is
        // rejected at the validation layer before the secure middleware — a
        // second, independent gate in front of the token check.
        const res = await request(app).get('/secure/stats');
        assert.equal(res.status, 400);
        assert.match(res.body.error, /authorization/i);
    });

    it('rejects a wrong authorization token', async () => {
        const res = await request(app).get('/secure/stats').set('authorization', 'wrong');
        assert.equal(res.status, 400);
        assert.match(res.body.error, /Access denied/);
    });

    it('allows the correct token and returns live socket keys', async () => {
        const res = await request(app).get('/secure/stats').set('authorization', AUTH);
        assert.equal(res.status, 200);
        assert.deepEqual(res.body.socketConnections, ['ws://peer-a:1', 'ws://peer-b:2']);
    });

    it('remove-chain-to requires auth and validates the blockId param', async () => {
        const denied = await request(app).get('/secure/remove-chain-to/3');
        assert.equal(denied.status, 400);

        const ok = await request(app).get('/secure/remove-chain-to/3').set('authorization', AUTH);
        assert.equal(ok.status, 200);
        assert.equal(ok.body.blockId, 3);

        const badParam = await request(app).get('/secure/remove-chain-to/-1').set('authorization', AUTH);
        assert.equal(badParam.status, 400);
    });

    it('honors ALLOW_SECURE_ROUTES=false as a global kill switch', async () => {
        process.env.ALLOW_SECURE_ROUTES = 'false';
        try {
            const res = await request(app).get('/secure/stats').set('authorization', AUTH);
            assert.equal(res.status, 400);
            assert.match(res.body.error, /turned off/);
        } finally {
            process.env.ALLOW_SECURE_ROUTES = 'true';
        }
    });
});

describe('unknown routes', () => {
    it('returns 404 for an unmapped path', async () => {
        const res = await request(app).get('/does-not-exist');
        assert.equal(res.status, 404);
    });
});
