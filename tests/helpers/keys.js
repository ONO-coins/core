const HDKey = require('hdkey');

/**
 * Deterministic test key material. The master seed is a fixed constant, so all
 * addresses, public keys and signatures in the suite are reproducible run to
 * run. The derivation path mirrors the production mainnet path so the fixtures
 * exercise the exact key shapes (33-byte compressed pubkeys) the protocol uses.
 *
 * NEVER use this seed outside tests.
 */
const TEST_MASTER_SEED_HEX =
    '5eed05eed05eed05eed05eed05eed05eed05eed05eed05eed05eed05eed05eed' +
    '05eed05eed05eed05eed05eed05eed05eed05eed05eed05eed05eed05eed05ee';

const root = HDKey.fromMasterSeed(Buffer.from(TEST_MASTER_SEED_HEX, 'hex'));

const HD_PATH = "m/44'/2909'/0'/0";

/**
 * @param {number} index
 * @returns {import('hdkey')}
 */
function keyAt(index) {
    return root.derive(`${HD_PATH}/${index}`);
}

/**
 * @param {import('hdkey')} key
 * @returns {string} 66-char compressed public key hex
 */
function pub(key) {
    return key.publicKey.toString('hex');
}

const forger = keyAt(0);
const alice = keyAt(1);
const bob = keyAt(2);
const carol = keyAt(3);
const mallory = keyAt(4);

module.exports = {
    TEST_MASTER_SEED_HEX,
    keyAt,
    pub,
    forger,
    alice,
    bob,
    carol,
    mallory,
    FORGER_PUB: pub(forger),
    ALICE_PUB: pub(alice),
    BOB_PUB: pub(bob),
    CAROL_PUB: pub(carol),
    MALLORY_PUB: pub(mallory),
};
