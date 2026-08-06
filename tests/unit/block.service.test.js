require('../helpers/env');
const { describe, it, mock, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const keys = require('../helpers/keys');
const factories = require('../helpers/factories');
const { FIXED_NOW_MS, FIXED_NOW_SECONDS } = require('../helpers/env');
const { createLedger, installLedgerMocks, installWalletMock } = require('../helpers/ledger');
const { BLOCKCHAIN_SETTINGS, BLOCK_ID_ACTIONS } = require('../../constants/app.constants');

const ledger = createLedger();
installLedgerMocks(mock, ledger);
installWalletMock(mock, keys.forger);

const blockService = require('../../services/block.service');
const state = require('../../state');
const { SyncError } = require('../../constructors/error.constructor');

const T0 = FIXED_NOW_SECONDS;

/** A registered parent block at height `id`. */
function seedBlock({ id, target = 1_000_000, timestamp = T0, hash, generationSignature }) {
    const block = {
        id,
        target,
        timestamp,
        hash: hash ?? require('node:crypto').createHash('sha256').update(`block-${id}`).digest('hex'),
        previousHash: '00'.repeat(32),
        publicKey: keys.FORGER_PUB,
        signature: '00'.repeat(64),
        generationSignature:
            generationSignature ??
            require('node:crypto').createHash('sha256').update(`gen-${id}`).digest('hex'),
    };
    ledger.getStore().blocks.set(id, block);
    return block;
}

beforeEach(() => {
    ledger.getStore().blocks.clear();
    state.init();
});

describe('generateHash — block identity', () => {
    const baseBlock = () => ({
        id: 7,
        publicKey: keys.FORGER_PUB,
        timestamp: T0,
        target: 123456,
        previousHash: 'ab'.repeat(32),
        transactions: [
            factories.makeTransaction({ fromKey: keys.alice, to: keys.BOB_PUB, amount: 1, timestamp: T0 }),
            factories.makeTransaction({ fromKey: keys.bob, to: keys.ALICE_PUB, amount: 2, timestamp: T0 }),
        ],
    });

    it('is invariant to transaction ORDER (canonical sorted merkle-style commitment)', () => {
        // Two nodes may hold the same transactions in different array order;
        // the block id must not depend on it or identical blocks would fork.
        const block = baseBlock();
        const reversed = { ...block, transactions: [...block.transactions].reverse() };
        assert.equal(blockService.generateHash(block), blockService.generateHash(reversed));
    });

    it('changes if the transaction SET changes (transactions are committed to)', () => {
        const block = baseBlock();
        const withoutLast = { ...block, transactions: block.transactions.slice(0, 1) };
        const withExtra = {
            ...block,
            transactions: [
                ...block.transactions,
                factories.makeTransaction({ fromKey: keys.carol, to: keys.BOB_PUB, amount: 3, timestamp: T0 }),
            ],
        };
        const original = blockService.generateHash(block);
        assert.notEqual(blockService.generateHash(withoutLast), original);
        assert.notEqual(blockService.generateHash(withExtra), original);
        // Empty block hashes differently from a non-empty one.
        assert.notEqual(blockService.generateHash({ ...block, transactions: [] }), original);
    });

    it('duplicating an existing transaction changes the hash (no duplicate smuggling)', () => {
        const block = baseBlock();
        const duplicated = { ...block, transactions: [...block.transactions, block.transactions[0]] };
        assert.notEqual(blockService.generateHash(duplicated), blockService.generateHash(block));
    });

    it('binds every header field', () => {
        const block = baseBlock();
        const original = blockService.generateHash(block);
        const mutations = {
            id: block.id + 1,
            publicKey: keys.MALLORY_PUB,
            timestamp: block.timestamp + 1,
            target: block.target + 1,
            previousHash: 'cd'.repeat(32),
        };
        for (const [field, value] of Object.entries(mutations)) {
            assert.notEqual(
                blockService.generateHash({ ...block, [field]: value }),
                original,
                `header field "${field}" is not bound by the block hash`,
            );
        }
    });

    it('generationSignature is NOT hashed but IS bound by deterministic recomputation', async () => {
        // Like the transaction fee, the generation signature lives outside the
        // hash — safe only because checkBlockGenerationSignature recomputes it
        // from the parent. Assert both halves so the guard cannot be dropped.
        const parent = seedBlock({ id: 6 });
        const block = factories.makeBlock({ parent, forgerKey: keys.forger, timestamp: T0 + 10 });
        assert.equal(await blockService.checkBlockGenerationSignature(block), true);

        const forged = { ...block, generationSignature: 'ff'.repeat(32) };
        assert.equal(blockService.checkBlockHash(forged), true); // hash is blind to it...
        assert.equal(await blockService.checkBlockGenerationSignature(forged), false); // ...guard is not
    });
});

describe('generateGenerationSignature — non-grindable forging seed', () => {
    it('is deterministic and depends on exactly (parent seed, forger key)', () => {
        const seedA = blockService.generateGenerationSignature('aa'.repeat(32), keys.FORGER_PUB);
        assert.equal(
            blockService.generateGenerationSignature('aa'.repeat(32), keys.FORGER_PUB),
            seedA,
        );
        assert.notEqual(
            blockService.generateGenerationSignature('ab'.repeat(32), keys.FORGER_PUB),
            seedA,
        );
        assert.notEqual(
            blockService.generateGenerationSignature('aa'.repeat(32), keys.ALICE_PUB),
            seedA,
        );
    });

    it('gives the forger ZERO grindable degrees of freedom', () => {
        // The forger controls nothing in the seed derivation: same parent + same
        // key → one possible seed, no matter what transactions, timestamp or
        // target the forger picks. This is what prevents lottery grinding.
        const parent = seedBlock({ id: 3 });
        const variantA = factories.makeBlock({ parent, forgerKey: keys.forger, timestamp: T0 + 5 });
        const variantB = factories.makeBlock({
            parent,
            forgerKey: keys.forger,
            timestamp: T0 + 500,
            transactions: [
                factories.makeTransaction({ fromKey: keys.alice, to: keys.BOB_PUB, amount: 9, timestamp: T0 }),
            ],
        });
        assert.equal(variantA.generationSignature, variantB.generationSignature);
    });
});

describe('blockDifficulty / cumulativeDifficulty — chain weight', () => {
    it('weighs the hardest block MAX/MIN and the easiest ~1', () => {
        assert.equal(blockService.blockDifficulty(BLOCKCHAIN_SETTINGS.MAX_TARGET).toString(), '1');
        assert.equal(
            blockService.blockDifficulty(BLOCKCHAIN_SETTINGS.MIN_TARGET).toString(),
            String(BLOCKCHAIN_SETTINGS.MAX_TARGET),
        );
    });

    it('is strictly decreasing in target (harder block ⇒ more weight)', () => {
        const d1 = blockService.blockDifficulty(1000);
        const d2 = blockService.blockDifficulty(1001);
        assert.ok(d1.gt(d2));
    });

    it('treats out-of-range/hostile targets as ZERO work, never as infinite work', () => {
        // A malicious chain advertising target 0 must not divide-by-zero into
        // Infinity and instantly win fork resolution.
        for (const hostile of [0, -1, 0.5, NaN, Infinity, -Infinity, '0']) {
            assert.equal(
                blockService.blockDifficulty(hostile).toString(),
                '0',
                `target ${hostile} was not neutralized`,
            );
        }
    });

    it('cumulative difficulty is the exact sum over the suffix', () => {
        const blocks = [{ target: 1000 }, { target: 2000 }, { target: BLOCKCHAIN_SETTINGS.MAX_TARGET }];
        const expected = blockService
            .blockDifficulty(1000)
            .plus(blockService.blockDifficulty(2000))
            .plus(1);
        assert.equal(blockService.cumulativeDifficulty(blocks).toString(), expected.toString());
        assert.equal(blockService.cumulativeDifficulty([]).toString(), '0');
    });
});

describe('createBlockTarget — retargeting rule', () => {
    const parent = { target: 1_000_000, timestamp: T0 };

    it('scales the target by elapsed/10s (exact integer math)', () => {
        // 10s elapsed (on schedule) keeps the target; 5s halves it; 20s doubles.
        assert.equal(blockService.createBlockTarget(parent, T0 + 10), 1_000_000);
        assert.equal(blockService.createBlockTarget(parent, T0 + 5), 500_000);
        assert.equal(blockService.createBlockTarget(parent, T0 + 20), 2_000_000);
        assert.equal(blockService.createBlockTarget(parent, T0 + 13), 1_300_000);
    });

    it('clamps to at most 2× and at least ½× per block (retarget attack limiter)', () => {
        // Without the clamp a single backdated/future-dated block could crash
        // or explode the difficulty in one step.
        assert.equal(blockService.createBlockTarget(parent, T0 + 1_000_000), 2_000_000);
        assert.equal(blockService.createBlockTarget(parent, T0 + 1), 500_000);
        assert.equal(blockService.createBlockTarget(parent, T0), 500_000); // zero elapsed
    });

    it('never leaves the global [MIN_TARGET, MAX_TARGET] window', () => {
        const atMax = { target: BLOCKCHAIN_SETTINGS.MAX_TARGET, timestamp: T0 };
        assert.equal(
            blockService.createBlockTarget(atMax, T0 + 100_000),
            BLOCKCHAIN_SETTINGS.MAX_TARGET,
        );
        const atMin = { target: BLOCKCHAIN_SETTINGS.MIN_TARGET, timestamp: T0 };
        assert.equal(blockService.createBlockTarget(atMin, T0), BLOCKCHAIN_SETTINGS.MIN_TARGET);
    });

    it('matches the independently implemented retarget formula', () => {
        for (const elapsed of [0, 1, 5, 9, 10, 11, 15, 19, 20, 21, 3600]) {
            assert.equal(
                blockService.createBlockTarget(parent, T0 + elapsed),
                factories.expectedTarget(parent, T0 + elapsed),
                `divergence at elapsed=${elapsed}`,
            );
        }
    });
});

describe('checkNewBlockId — height admission', () => {
    beforeEach(() => {
        seedBlock({ id: 5, target: 1_000_000 });
    });

    it('same height → fork resolution path (NEED_REPLACE)', async () => {
        assert.equal(
            await blockService.checkNewBlockId({ id: 5, target: 999 }),
            BLOCK_ID_ACTIONS.NEED_REPLACE,
        );
    });

    it('direct successor → accept path (NO_ACTION_NEED)', async () => {
        assert.equal(
            await blockService.checkNewBlockId({ id: 6, target: 999 }),
            BLOCK_ID_ACTIONS.NO_ACTION_NEED,
        );
    });

    it('a gap of 2+ blocks forces a sync instead of blind acceptance', async () => {
        // Accepting id+2 would skip validation of the missing parent entirely.
        await assert.rejects(
            () => blockService.checkNewBlockId({ id: 7, target: 999 }),
            (error) => error instanceof SyncError,
        );
    });

    it('an older block with a harder target signals a possible better fork (sync)', async () => {
        await assert.rejects(
            () => blockService.checkNewBlockId({ id: 4, target: 999_999 }),
            (error) => error instanceof SyncError && /more difficult/.test(error.message),
        );
    });

    it('an older, not-harder block is a plain duplicate', async () => {
        await assert.rejects(
            () => blockService.checkNewBlockId({ id: 4, target: 1_000_000 }),
            (error) => !(error instanceof SyncError) && /already exists/.test(error.message),
        );
    });
});

describe('checkNewBlockTimings — future-dating guard', () => {
    it('rejects blocks from the future beyond MAX_TIMESTAMP_DIFF', (t) => {
        // A forger dating blocks into the future inflates elapsedTime and with
        // it their hit — this cap is the only wall-clock sanity check.
        t.mock.timers.enable({ apis: ['Date'], now: FIXED_NOW_MS });
        assert.equal(blockService.checkNewBlockTimings({ timestamp: T0 + 31 }), false);
        assert.equal(blockService.checkNewBlockTimings({ timestamp: T0 + 1000 }), false);
    });

    it('accepts now, the +30s boundary, and any past timestamp', (t) => {
        t.mock.timers.enable({ apis: ['Date'], now: FIXED_NOW_MS });
        assert.equal(blockService.checkNewBlockTimings({ timestamp: T0 }), true);
        assert.equal(blockService.checkNewBlockTimings({ timestamp: T0 + 30 }), true);
        assert.equal(blockService.checkNewBlockTimings({ timestamp: 0 }), true);
    });
});

describe('checkBlockTimestamp — monotonic chain time', () => {
    it('a block must move time STRICTLY forward past its parent', async () => {
        // timestamp == parent would make elapsedTime 0 → hit 0, but the check
        // must reject it explicitly; timestamp < parent is a backdating attack
        // that would otherwise let a forger shrink everyone else's future hits.
        seedBlock({ id: 9, timestamp: T0 });
        assert.equal(await blockService.checkBlockTimestamp({ id: 10, timestamp: T0 + 1 }), true);
        assert.equal(await blockService.checkBlockTimestamp({ id: 10, timestamp: T0 }), false);
        assert.equal(await blockService.checkBlockTimestamp({ id: 10, timestamp: T0 - 100 }), false);
    });

    it('an orphan (missing parent) never validates', async () => {
        assert.equal(await blockService.checkBlockTimestamp({ id: 42, timestamp: T0 }), false);
    });
});

describe('checkBlockPreviousHash / checkBlockTarget — chain linkage', () => {
    it('previousHash must equal the stored parent hash exactly', async () => {
        const parent = seedBlock({ id: 11 });
        assert.equal(
            await blockService.checkBlockPreviousHash({ id: 12, previousHash: parent.hash }),
            true,
        );
        assert.equal(
            await blockService.checkBlockPreviousHash({ id: 12, previousHash: 'ee'.repeat(32) }),
            false,
        );
        // Orphan: no parent at all.
        assert.equal(
            await blockService.checkBlockPreviousHash({ id: 99, previousHash: parent.hash }),
            false,
        );
    });

    it('the declared target must match the deterministic retarget exactly', async () => {
        const parent = seedBlock({ id: 11, target: 1_000_000, timestamp: T0 });
        const good = { id: 12, timestamp: T0 + 13, target: 1_300_000 };
        assert.equal(await blockService.checkBlockTarget(good), true);
        // Off by one either way is a consensus violation (difficulty manipulation).
        assert.equal(await blockService.checkBlockTarget({ ...good, target: 1_300_001 }), false);
        assert.equal(await blockService.checkBlockTarget({ ...good, target: 1_299_999 }), false);
        assert.ok(parent);
    });
});

describe('immutable block window', () => {
    it('immutable id trails the last external block by MAX_MUTABLE_BLOCK_COUNT, floored at 0', async () => {
        seedBlock({ id: 40 });
        const store = ledger.getStore();
        // Height 40 was forged by someone else (external) — window trails it.
        store.blocks.get(40).publicKey = keys.ALICE_PUB;
        assert.equal(await blockService.getImmutableBlockId(), 40 - BLOCKCHAIN_SETTINGS.MAX_MUTABLE_BLOCK_COUNT);

        store.blocks.clear();
        seedBlock({ id: 3 });
        store.blocks.get(3).publicKey = keys.ALICE_PUB;
        assert.equal(await blockService.getImmutableBlockId(), 0);
    });

    it('setImmutableBlockId floors negative ids at 0 and publishes to state', async () => {
        await blockService.setImmutableBlockId(-7);
        assert.equal(state.getState(state.KEYS.IMMUTABLE_BLOCK_ID), 0);
        await blockService.setImmutableBlockId(12);
        assert.equal(state.getState(state.KEYS.IMMUTABLE_BLOCK_ID), 12);
    });
});
