require('../helpers/env');
const { describe, it, mock, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Big = require('big.js');
const keys = require('../helpers/keys');
const factories = require('../helpers/factories');
const { FIXED_NOW_SECONDS } = require('../helpers/env');
const { createLedger, installLedgerMocks, installWalletMock } = require('../helpers/ledger');
const { BLOCKCHAIN_SETTINGS } = require('../../constants/app.constants');

const ledger = createLedger();
installLedgerMocks(mock, ledger);
installWalletMock(mock, keys.forger);

const forgerService = require('../../services/forger.service');
const cryptoUtilsLib = require('../../lib/crypto-utils.lib');

const T0 = FIXED_NOW_SECONDS;

/**
 * Confirms a burn of `amount` from `key` inside block `blockId`, so the burned
 * balance is real chain data (never a mocked number) — the proof-of-burn weight
 * must come from the same place production reads it.
 */
function seedBurn(key, amount, blockId) {
    const store = ledger.getStore();
    const burn = factories.makeTransaction({
        fromKey: key,
        to: BLOCKCHAIN_SETTINGS.BURN_ADDRESS,
        amount,
        timestamp: T0 - 1000 + blockId,
    });
    store.transactions.set(burn.hash, burn);
    store.blockTransactions.push({
        id: store.nextBlockTransactionId++,
        transactionHash: burn.hash,
        blockId,
    });
}

function latestBlockAt({ id = 10, target = 1_000_000, timestamp = T0 } = {}) {
    return {
        id,
        target,
        timestamp,
        hash: 'aa'.repeat(32),
        previousHash: 'bb'.repeat(32),
        publicKey: keys.FORGER_PUB,
        generationSignature: 'cc'.repeat(32),
    };
}

beforeEach(() => {
    const store = ledger.getStore();
    store.blocks.clear();
    store.transactions.clear();
    store.blockTransactions.length = 0;
    store.balances.clear();
});

describe('calcTarget — per-forger lottery ticket', () => {
    it('equals the first 9 hex digits of the domain-separated seed (independent check)', () => {
        const latestBlock = latestBlockAt();
        const seed = cryptoUtilsLib.generateDomainHash(
            'forging-target',
            ['generationSignature', 'publicKey'],
            { generationSignature: latestBlock.generationSignature, publicKey: keys.ALICE_PUB },
        );
        assert.equal(
            forgerService.calcTarget(latestBlock, keys.ALICE_PUB),
            parseInt(seed.substring(0, 9), 16),
        );
    });

    it('is deterministic and inside [0, 16^9)', () => {
        const latestBlock = latestBlockAt();
        const target = forgerService.calcTarget(latestBlock, keys.ALICE_PUB);
        assert.equal(forgerService.calcTarget(latestBlock, keys.ALICE_PUB), target);
        assert.ok(Number.isInteger(target));
        assert.ok(target >= 0 && target < 16 ** 9);
    });

    it('depends only on the parent generation signature and the forger key', () => {
        // NOT on the parent's ECDSA signature, timestamp or transactions — those
        // are grindable by the previous forger. Different key or different
        // parent seed → different ticket; anything else → same ticket.
        const latestBlock = latestBlockAt();
        const ticket = forgerService.calcTarget(latestBlock, keys.ALICE_PUB);
        assert.equal(
            forgerService.calcTarget({ ...latestBlock, timestamp: 1, target: 5, hash: 'ff'.repeat(32) }, keys.ALICE_PUB),
            ticket,
        );
        assert.notEqual(forgerService.calcTarget(latestBlock, keys.BOB_PUB), ticket);
        assert.notEqual(
            forgerService.calcTarget({ ...latestBlock, generationSignature: 'dd'.repeat(32) }, keys.ALICE_PUB),
            ticket,
        );
    });
});

describe('calcHit — proof-of-burn weight', () => {
    it('is ZERO for balances below MIN_FORGER_BALANCE (sybil floor)', async () => {
        seedBurn(keys.alice, BLOCKCHAIN_SETTINGS.MIN_FORGER_BALANCE - 0.01, 5);
        const hit = await forgerService.calcHit(latestBlockAt(), T0 + 10, keys.ALICE_PUB);
        assert.equal(hit.toString(), '0');
    });

    it('activates at exactly MIN_FORGER_BALANCE (boundary inclusive)', async () => {
        seedBurn(keys.alice, BLOCKCHAIN_SETTINGS.MIN_FORGER_BALANCE, 5);
        const latestBlock = latestBlockAt();
        const hit = await forgerService.calcHit(latestBlock, T0 + 10, keys.ALICE_PUB);
        assert.equal(
            hit.toString(),
            new Big(latestBlock.target).times(100).times(10).toString(),
        );
    });

    it('computes prevTarget × burned × elapsed EXACTLY beyond MAX_SAFE_INTEGER', async () => {
        // Independent BigInt cross-check. If the implementation ever falls back
        // to floats, two nodes can round a near-tie differently and fork.
        const burned = 1_000_000;
        const elapsed = 100_000;
        const target = BLOCKCHAIN_SETTINGS.MAX_TARGET; // 2147483647
        seedBurn(keys.alice, burned, 5);
        const latestBlock = latestBlockAt({ target });
        const hit = await forgerService.calcHit(latestBlock, T0 + elapsed, keys.ALICE_PUB);
        const independent = BigInt(target) * BigInt(burned) * BigInt(elapsed);
        assert.ok(independent > BigInt(Number.MAX_SAFE_INTEGER), 'test must exceed float range');
        assert.equal(hit.toFixed(), independent.toString());
    });

    it('burns AFTER the parent height do not count (height-scoped weight)', async () => {
        // A burn confirmed at height 11 must not influence forging on top of
        // height 10 — otherwise nodes at different sync depths disagree.
        seedBurn(keys.alice, 10_000, 11);
        const hit = await forgerService.calcHit(latestBlockAt({ id: 10 }), T0 + 10, keys.ALICE_PUB);
        assert.equal(hit.toString(), '0');
    });

    it('elapsed time ≤ 0 yields a non-positive hit (backdating gives no advantage)', async () => {
        seedBurn(keys.alice, 1_000, 5);
        const zero = await forgerService.calcHit(latestBlockAt(), T0, keys.ALICE_PUB);
        assert.equal(zero.toString(), '0');
        const negative = await forgerService.calcHit(latestBlockAt(), T0 - 5, keys.ALICE_PUB);
        assert.ok(negative.lt(0));
    });
});

describe('verifyHit — the consensus inequality', () => {
    it('requires hit STRICTLY greater than target (boundary must lose)', async (t) => {
        // hit == target is the knife-edge every node must resolve identically.
        const original = { calcTarget: forgerService.calcTarget, calcHit: forgerService.calcHit };
        t.after(() => Object.assign(forgerService, original));

        forgerService.calcTarget = () => 1000;
        forgerService.calcHit = async () => new Big(1000);
        assert.equal(await forgerService.verifyHit(latestBlockAt(), T0 + 1, keys.ALICE_PUB), false);

        forgerService.calcHit = async () => new Big('1000.0000000001');
        assert.equal(await forgerService.verifyHit(latestBlockAt(), T0 + 1, keys.ALICE_PUB), true);

        forgerService.calcHit = async () => new Big(999);
        assert.equal(await forgerService.verifyHit(latestBlockAt(), T0 + 1, keys.ALICE_PUB), false);
    });

    it('end-to-end: a big burner eventually wins, a non-burner never does', async () => {
        seedBurn(keys.alice, 1_000_000, 5);
        const latestBlock = latestBlockAt({ target: BLOCKCHAIN_SETTINGS.MAX_TARGET });
        // With max prevTarget and 1M burned, one week of elapsed time crushes
        // any possible 9-hex-digit ticket (< 16^9 ≈ 6.9e10).
        assert.equal(
            await forgerService.verifyHit(latestBlock, T0 + 604_800, keys.ALICE_PUB),
            true,
        );
        // bob burned nothing: hit is 0 forever, regardless of elapsed time.
        assert.equal(
            await forgerService.verifyHit(latestBlock, T0 + 10 ** 9, keys.BOB_PUB),
            false,
        );
    });

    it('verifyBlockHit reads the parent by id and applies the same rule', async () => {
        seedBurn(keys.alice, 1_000_000, 5);
        const parent = latestBlockAt({ id: 10, target: BLOCKCHAIN_SETTINGS.MAX_TARGET });
        ledger.getStore().blocks.set(10, parent);
        const block = {
            id: 11,
            timestamp: T0 + 604_800,
            publicKey: keys.ALICE_PUB,
        };
        assert.equal(await forgerService.verifyBlockHit(block), true);
        assert.equal(
            await forgerService.verifyBlockHit({ ...block, publicKey: keys.BOB_PUB }),
            false,
        );
    });
});

describe('predictForgingTimestamp — forger scheduling', () => {
    it('returns Infinity when the forger has no burned balance (never schedules)', async () => {
        const predicted = await forgerService.predictForgingTimestamp(latestBlockAt(), keys.BOB_PUB);
        assert.equal(predicted, Infinity);
    });

    it('the predicted moment is achievable and nothing earlier wins by margin > 1s', async () => {
        seedBurn(keys.alice, 5_000, 5);
        const latestBlock = latestBlockAt();
        const predicted = await forgerService.predictForgingTimestamp(latestBlock, keys.ALICE_PUB);
        assert.ok(Number.isFinite(predicted));
        assert.ok(predicted > latestBlock.timestamp);
        // One second after the prediction the hit strictly exceeds the ticket
        // (the prediction itself can land exactly ON the boundary, where the
        // strict inequality still loses — the 1s forge loop absorbs that).
        assert.equal(await forgerService.verifyHit(latestBlock, predicted + 1, keys.ALICE_PUB), true);
        // Two seconds before the prediction the hit must still lose — the
        // prediction may be pessimistic by at most the ceil() rounding of 1s.
        assert.equal(await forgerService.verifyHit(latestBlock, predicted - 2, keys.ALICE_PUB), false);
    });
});
