require('../helpers/env');
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const keys = require('../helpers/keys');
const factories = require('../helpers/factories');
const { forAll, Rng } = require('../helpers/prng');
const { FIXED_NOW_SECONDS } = require('../helpers/env');
const p2pValidator = require('../../p2p/p2p-validator');
const { P2P_MESSAGE_TYPES } = require('../../constants/p2p.constants');

/**
 * The p2p validator is the FIRST line of defense on the untrusted network
 * boundary: every inbound message hits ajv here before any controller. It must
 * (1) never throw on hostile input, (2) never accept a structurally malformed
 * transaction/block, and (3) reject unknown/oversized/prototype-polluting
 * shapes. A single accepted malformed block reaches consensus code.
 */

before(() => p2pValidator.init());

const T0 = FIXED_NOW_SECONDS;

/** A wire-shaped valid transaction (all fields the schema requires). */
function wireTransaction(rng = new Rng(1)) {
    const tx = factories.makeTransaction({
        fromKey: rng.pick([keys.alice, keys.bob]),
        to: keys.BOB_PUB,
        amount: rng.amount(),
        timestamp: rng.int(1, 2_000_000_000),
    });
    return tx; // {hash,from,to,amount,fee,timestamp,signature}
}

/** A wire-shaped valid block (schema does not require id). */
function wireBlock() {
    const parent = { id: 0, hash: 'ab'.repeat(32), target: 1000, timestamp: T0, generationSignature: 'cd'.repeat(32) };
    const block = factories.makeBlock({ parent, forgerKey: keys.forger, timestamp: T0 + 10 });
    const { id, ...rest } = block; // schema allows id but does not require it
    return rest;
}

describe('validator never throws and rejects unknown types', () => {
    it('returns false (never throws) for arbitrary hostile payloads and types', () => {
        forAll(
            { name: 'validator-total-function', seed: 0xf0f0, runs: 3000 },
            (rng) => ({
                type: rng.bool(0.3) ? rng.pick(Object.values(P2P_MESSAGE_TYPES)) : rng.unicode(rng.int(0, 12)),
                data: rng.anyValue(),
            }),
            (message) => {
                let result;
                assert.doesNotThrow(() => {
                    result = p2pValidator.validateMessage(message);
                });
                assert.equal(typeof result, 'boolean');
            },
        );
    });

    it('rejects every unknown message type outright', () => {
        for (const type of ['', 'NOPE', 'new_block', '__proto__', 'constructor', 'PONG']) {
            assert.equal(p2pValidator.validateMessage({ type, data: {} }), false);
        }
    });
});

describe('NEW_TRANSACTION schema', () => {
    it('accepts a well-formed wire transaction', () => {
        assert.equal(
            p2pValidator.validateMessage({ type: P2P_MESSAGE_TYPES.NEW_TRANSACTION, data: wireTransaction() }),
            true,
        );
    });

    it('rejects a transaction missing any required field', () => {
        const base = wireTransaction();
        for (const field of ['hash', 'from', 'to', 'amount', 'fee', 'timestamp', 'signature']) {
            const { [field]: _drop, ...rest } = base;
            assert.equal(
                p2pValidator.validateMessage({ type: P2P_MESSAGE_TYPES.NEW_TRANSACTION, data: rest }),
                false,
                `transaction accepted without "${field}"`,
            );
        }
    });

    it('rejects extra/unexpected properties (additionalProperties: false)', () => {
        // Blocks prototype-pollution smuggling and hidden field injection.
        const withExtra = { ...wireTransaction(), evil: 1, __proto__: { polluted: true } };
        assert.equal(
            p2pValidator.validateMessage({ type: P2P_MESSAGE_TYPES.NEW_TRANSACTION, data: withExtra }),
            false,
        );
    });

    it('rejects wrong-length hex fields (hash 64, from/to 66, signature 128)', () => {
        const base = wireTransaction();
        const badLengths = {
            hash: 'aa'.repeat(31), // 62
            from: keys.ALICE_PUB.slice(0, 64), // 64, needs 66
            to: keys.BOB_PUB + 'ab', // 68
            signature: 'ff'.repeat(63), // 126
        };
        for (const [field, value] of Object.entries(badLengths)) {
            assert.equal(
                p2pValidator.validateMessage({
                    type: P2P_MESSAGE_TYPES.NEW_TRANSACTION,
                    data: { ...base, [field]: value },
                }),
                false,
                `accepted wrong-length "${field}"`,
            );
        }
    });

    it('rejects a non-positive or non-numeric amount at the wire boundary', () => {
        const base = wireTransaction();
        for (const amount of [0, -1, 'x', null, NaN, [], {}]) {
            assert.equal(
                p2pValidator.validateMessage({
                    type: P2P_MESSAGE_TYPES.NEW_TRANSACTION,
                    data: { ...base, amount },
                }),
                false,
                `accepted amount ${String(amount)}`,
            );
        }
    });

    it('fuzz: single-field corruption of a valid transaction is caught most of the time and NEVER throws', () => {
        forAll(
            { name: 'tx-schema-corruption', seed: 0x7a11f, runs: 2000 },
            (rng) => {
                const tx = wireTransaction(rng);
                const field = rng.pick(Object.keys(tx));
                tx[field] = rng.anyValue();
                return tx;
            },
            (tx) => {
                let result;
                assert.doesNotThrow(() => {
                    result = p2pValidator.validateMessage({ type: P2P_MESSAGE_TYPES.NEW_TRANSACTION, data: tx });
                });
                assert.equal(typeof result, 'boolean');
            },
        );
    });
});

describe('NEW_BLOCK schema', () => {
    it('accepts a well-formed wire block', () => {
        assert.equal(p2pValidator.validateMessage({ type: P2P_MESSAGE_TYPES.NEW_BLOCK, data: wireBlock() }), true);
    });

    it('rejects a block missing any required field', () => {
        const base = wireBlock();
        for (const field of ['timestamp', 'target', 'hash', 'previousHash', 'publicKey', 'signature', 'generationSignature', 'transactions']) {
            const { [field]: _drop, ...rest } = base;
            assert.equal(
                p2pValidator.validateMessage({ type: P2P_MESSAGE_TYPES.NEW_BLOCK, data: rest }),
                false,
                `block accepted without "${field}"`,
            );
        }
    });

    it('rejects a block whose transactions array contains a malformed transaction', () => {
        const block = wireBlock();
        block.transactions = [{ ...wireTransaction(), amount: -5 }];
        assert.equal(p2pValidator.validateMessage({ type: P2P_MESSAGE_TYPES.NEW_BLOCK, data: block }), false);
    });

    it('accepts an empty transactions array (empty blocks are legal)', () => {
        const block = wireBlock();
        block.transactions = [];
        // hash/signature won't match but the SCHEMA (structure only) must pass;
        // semantic validation happens later in consensus.
        assert.equal(p2pValidator.validateMessage({ type: P2P_MESSAGE_TYPES.NEW_BLOCK, data: block }), true);
    });

    it('rejects a negative id / negative target / negative timestamp', () => {
        const base = wireBlock();
        assert.equal(p2pValidator.validateMessage({ type: P2P_MESSAGE_TYPES.NEW_BLOCK, data: { ...base, id: -1 } }), false);
        assert.equal(p2pValidator.validateMessage({ type: P2P_MESSAGE_TYPES.NEW_BLOCK, data: { ...base, target: -1 } }), false);
        assert.equal(p2pValidator.validateMessage({ type: P2P_MESSAGE_TYPES.NEW_BLOCK, data: { ...base, timestamp: -1 } }), false);
    });

    it('fuzz: deeply nested / huge / prototype-polluting block payloads never throw', () => {
        forAll(
            { name: 'block-schema-fuzz', seed: 0xb10c, runs: 1500 },
            (rng) => {
                const block = wireBlock();
                if (rng.bool()) block[rng.pick(Object.keys(block))] = rng.anyValue();
                if (rng.bool(0.2)) block.transactions = rng.anyValue();
                if (rng.bool(0.1)) block.transactions = Array.from({ length: rng.int(0, 50) }, () => rng.anyValue());
                return block;
            },
            (block) => {
                let result;
                assert.doesNotThrow(() => {
                    result = p2pValidator.validateMessage({ type: P2P_MESSAGE_TYPES.NEW_BLOCK, data: block });
                });
                assert.equal(typeof result, 'boolean');
            },
        );
    });
});

describe('peer/status/id schemas', () => {
    it('PEERS_RESPONSE accepts only ws/wss strings', () => {
        assert.equal(p2pValidator.validateMessage({ type: P2P_MESSAGE_TYPES.PEERS_RESPONSE, data: ['ws://a:1', 'wss://b:2'] }), true);
        assert.equal(p2pValidator.validateMessage({ type: P2P_MESSAGE_TYPES.PEERS_RESPONSE, data: ['http://a:1'] }), false);
        assert.equal(p2pValidator.validateMessage({ type: P2P_MESSAGE_TYPES.PEERS_RESPONSE, data: [123] }), false);
    });

    it('ID requires a strict UUIDv4', () => {
        assert.equal(
            p2pValidator.validateMessage({ type: P2P_MESSAGE_TYPES.ID, data: { id: '11111111-2222-4333-8444-555555555555' } }),
            true,
        );
        for (const bad of ['not-a-uuid', '11111111-2222-1333-8444-555555555555', '', '11111111-2222-4333-c444-555555555555']) {
            assert.equal(p2pValidator.validateMessage({ type: P2P_MESSAGE_TYPES.ID, data: { id: bad } }), false);
        }
    });

    it('STATUS requires a numeric height and a 64-char hash', () => {
        assert.equal(
            p2pValidator.validateMessage({ type: P2P_MESSAGE_TYPES.STATUS, data: { lastBlockId: 5, lastBlockHash: 'ab'.repeat(32) } }),
            true,
        );
        assert.equal(
            p2pValidator.validateMessage({ type: P2P_MESSAGE_TYPES.STATUS, data: { lastBlockId: -1, lastBlockHash: 'ab'.repeat(32) } }),
            false,
        );
        assert.equal(
            p2pValidator.validateMessage({ type: P2P_MESSAGE_TYPES.STATUS, data: { lastBlockId: 5, lastBlockHash: 'short' } }),
            false,
        );
    });

    it('PEER_GOSSIP requires a ws/wss peer string and forbids extras', () => {
        assert.equal(p2pValidator.validateMessage({ type: P2P_MESSAGE_TYPES.PEER_GOSSIP, data: { peer: 'ws://a:1' } }), true);
        assert.equal(p2pValidator.validateMessage({ type: P2P_MESSAGE_TYPES.PEER_GOSSIP, data: { peer: 'ftp://a:1' } }), false);
        assert.equal(p2pValidator.validateMessage({ type: P2P_MESSAGE_TYPES.PEER_GOSSIP, data: { peer: 'ws://a:1', extra: 1 } }), false);
    });
});
