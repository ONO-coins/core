require('../helpers/env');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const keys = require('../helpers/keys');
const { forAll, Rng } = require('../helpers/prng');
const cryptoUtilsLib = require('../../lib/crypto-utils.lib');

/**
 * Randomized cryptographic invariants. Deterministic seeds — a failure message
 * carries the seed + run index and replays exactly.
 */

const SIGNER_KEYS = [keys.forger, keys.alice, keys.bob, keys.carol, keys.mallory];

describe('hash properties', () => {
    it('determinism and fixed length over arbitrary unicode inputs', () => {
        forAll(
            { name: 'hash-determinism', seed: 0xc0ffee, runs: 1000 },
            (rng) => rng.unicode(rng.int(0, 300)),
            (input) => {
                const digest = cryptoUtilsLib.hash(input);
                assert.equal(digest, cryptoUtilsLib.hash(input));
                assert.match(digest, /^[0-9a-f]{64}$/);
            },
        );
    });

    it('avalanche effect: flipping one input bit flips ~half the output bits', () => {
        // Each digest is 256 bits; under SHA-256's design each output bit flips
        // with p=0.5 on any input change. Per-case we require >30% flipped
        // (a <30% outcome is a ~8-sigma event — impossible unless the hash is
        // broken or truncated), and the aggregate mean must sit in [45%, 55%].
        const bitCount = (buf1, buf2) => {
            let bits = 0;
            for (let i = 0; i < buf1.length; i++) {
                let xor = buf1[i] ^ buf2[i];
                while (xor) {
                    bits += xor & 1;
                    xor >>= 1;
                }
            }
            return bits;
        };
        let totalFlipped = 0;
        const runs = 300;
        forAll(
            { name: 'hash-avalanche', seed: 0xa7a1a, runs },
            (rng) => {
                const input = Buffer.from(rng.bytes(rng.int(1, 100)));
                const bitIndex = rng.int(0, input.length * 8 - 1);
                return { input, bitIndex };
            },
            ({ input, bitIndex }) => {
                const flipped = Buffer.from(input);
                flipped[bitIndex >> 3] ^= 1 << (bitIndex & 7);
                const d1 = Buffer.from(cryptoUtilsLib.hash(input.toString('latin1')), 'hex');
                const d2 = Buffer.from(cryptoUtilsLib.hash(flipped.toString('latin1')), 'hex');
                const flippedBits = bitCount(d1, d2);
                totalFlipped += flippedBits;
                assert.ok(flippedBits > 256 * 0.3, `only ${flippedBits}/256 bits flipped`);
            },
        );
        const mean = totalFlipped / runs / 256;
        assert.ok(mean > 0.45 && mean < 0.55, `avalanche mean ${mean} outside [0.45, 0.55]`);
    });

    it('no collisions across a large sample of distinct inputs', () => {
        const seen = new Map();
        forAll(
            { name: 'hash-collision-sample', seed: 0x5eed, runs: 5000 },
            (rng) => rng.hex(rng.int(1, 64)),
            (input) => {
                const digest = cryptoUtilsLib.hash(input);
                if (seen.has(digest)) {
                    assert.equal(seen.get(digest), input, 'SHA-256 collision found (!)');
                }
                seen.set(digest, input);
            },
        );
    });
});

describe('signature properties', () => {
    it('sign→verify roundtrip holds for every key and random message', () => {
        forAll(
            { name: 'sign-verify-roundtrip', seed: 0x51611, runs: 300 },
            (rng) => ({
                key: rng.pick(SIGNER_KEYS),
                messageHash: cryptoUtilsLib.hash(rng.hex(rng.int(0, 128))),
            }),
            ({ key, messageHash }) => {
                const signature = key.sign(Buffer.from(messageHash, 'hex')).toString('hex');
                assert.equal(
                    cryptoUtilsLib.verifySignature(
                        messageHash,
                        signature,
                        key.publicKey.toString('hex'),
                    ),
                    true,
                );
            },
        );
    });

    it('any single-character corruption of the signature is rejected', () => {
        forAll(
            { name: 'signature-corruption', seed: 0xbadc0de, runs: 300 },
            (rng) => {
                const key = rng.pick(SIGNER_KEYS);
                const messageHash = cryptoUtilsLib.hash(rng.hex(32));
                const signature = key.sign(Buffer.from(messageHash, 'hex')).toString('hex');
                const index = rng.int(0, signature.length - 1);
                const hexChars = '0123456789abcdef'.replace(signature[index], '');
                const corrupted =
                    signature.slice(0, index) +
                    hexChars[rng.int(0, hexChars.length - 1)] +
                    signature.slice(index + 1);
                return { messageHash, corrupted, publicKey: key.publicKey.toString('hex') };
            },
            ({ messageHash, corrupted, publicKey }) => {
                assert.equal(cryptoUtilsLib.verifySignature(messageHash, corrupted, publicKey), false);
            },
        );
    });

    it('a signature never verifies under a different message hash', () => {
        forAll(
            { name: 'signature-message-binding', seed: 0x1234, runs: 200 },
            (rng) => {
                const key = rng.pick(SIGNER_KEYS);
                const messageHash = cryptoUtilsLib.hash('m' + rng.hex(16));
                const otherHash = cryptoUtilsLib.hash('n' + rng.hex(16));
                return {
                    otherHash,
                    signature: key.sign(Buffer.from(messageHash, 'hex')).toString('hex'),
                    publicKey: key.publicKey.toString('hex'),
                };
            },
            ({ otherHash, signature, publicKey }) => {
                assert.equal(cryptoUtilsLib.verifySignature(otherHash, signature, publicKey), false);
            },
        );
    });

    it('verifySignature never throws on random byte garbage', () => {
        forAll(
            { name: 'verify-garbage-total-function', seed: 0xdead, runs: 1000 },
            (rng) => ({
                hash: rng.bool() ? rng.hex(rng.int(0, 128)) : rng.unicode(rng.int(0, 20)),
                signature: rng.bool() ? rng.hex(rng.int(0, 256)) : rng.bytes(rng.int(0, 80)).toString('latin1'),
                publicKey: rng.bool() ? rng.hex(rng.int(0, 132)) : rng.unicode(rng.int(0, 10)),
            }),
            ({ hash, signature, publicKey }) => {
                let result;
                assert.doesNotThrow(() => {
                    result = cryptoUtilsLib.verifySignature(hash, signature, publicKey);
                });
                assert.equal(typeof result, 'boolean');
            },
        );
    });
});

describe('domain hash properties', () => {
    it('injective over schema-constrained (hex/decimal) field values', () => {
        // The p2p/HTTP schemas restrict every hashed string field to fixed-length
        // hex and numbers to decimals. Within that domain the encoding is
        // delimiter-free, so distinct field sets must produce distinct hashes.
        const seen = new Map();
        forAll(
            { name: 'domain-hash-injectivity', seed: 0xfeed, runs: 3000 },
            (rng) => ({
                from: rng.hex(66),
                to: rng.hex(66),
                amount: rng.amount(),
                timestamp: rng.int(0, 2_000_000_000),
            }),
            (fields) => {
                const digest = cryptoUtilsLib.generateDomainHash(
                    'transaction',
                    ['from', 'to', 'timestamp', 'amount'],
                    fields,
                );
                const canonical = JSON.stringify([fields.from, fields.to, fields.timestamp, fields.amount]);
                if (seen.has(digest)) {
                    assert.equal(seen.get(digest), canonical, 'two distinct transactions share a hash');
                }
                seen.set(digest, canonical);
            },
        );
    });

    it('param listing order never affects the digest', () => {
        forAll(
            { name: 'domain-hash-order-invariance', seed: 0x0ede4, runs: 500 },
            (rng) => {
                const obj = { a: rng.hex(8), b: rng.hex(8), c: String(rng.int(0, 1e9)) };
                return obj;
            },
            (obj) => {
                const orders = [
                    ['a', 'b', 'c'],
                    ['c', 'b', 'a'],
                    ['b', 'a', 'c'],
                ];
                const digests = orders.map((order) =>
                    cryptoUtilsLib.generateDomainHash('d', order, obj),
                );
                assert.equal(digests[0], digests[1]);
                assert.equal(digests[0], digests[2]);
            },
        );
    });
});
