require('../helpers/env');
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const bip39 = require('bip39');
const HDKey = require('hdkey');
const Wallet = require('../../constructors/wallet.constructor');

/**
 * Wallet key lifecycle. A wallet bug is catastrophic and silent: it either
 * derives the wrong address (funds sent to a key nobody controls) or destroys
 * an existing seed (funds unrecoverable). These tests use a REAL temp directory
 * and the REAL bip39/hdkey/scrypt path — no crypto is mocked.
 */

const silentLogger = { warn() {}, info() {}, error() {}, fatal() {}, debug() {} };

/** cwd-relative SECRET_PATH is how the wallet resolves the seed file. */
let tmpDir;
let originalCwd;

/** A known 64-byte seed (hex) → fully deterministic derivations. */
const KNOWN_SEED_HEX =
    '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f' +
    '202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f';

function setSecretFile(relPath, contents) {
    fs.writeFileSync(path.join(tmpDir, relPath), contents);
}

before(() => {
    originalCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ono-wallet-'));
    process.chdir(tmpDir);
});

after(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
    for (const file of fs.readdirSync(tmpDir)) fs.rmSync(path.join(tmpDir, file), { force: true });
    process.env.TESTNET = 'false';
    delete process.env.SECRET_PASSPHRASE;
    process.env.SECRET_PATH = 'secret.txt';
});

describe('seed derivation (mainnet)', () => {
    it('derives addresses deterministically from a known seed', async () => {
        setSecretFile('secret.txt', KNOWN_SEED_HEX);
        const wallet = new Wallet(silentLogger);
        await wallet.init();

        // Independent derivation via hdkey using the documented mainnet path.
        const expected = HDKey.fromMasterSeed(Buffer.from(KNOWN_SEED_HEX, 'hex')).derive(
            "m/44'/2909'/0'/0/0",
        );
        const actual = wallet.getDefaultAddress();
        assert.equal(actual.publicKey.toString('hex'), expected.publicKey.toString('hex'));
        assert.equal(actual.privateKey.toString('hex'), expected.privateKey.toString('hex'));
    });

    it('produces a 33-byte compressed public key (66 hex chars — the protocol address shape)', async () => {
        setSecretFile('secret.txt', KNOWN_SEED_HEX);
        const wallet = new Wallet(silentLogger);
        await wallet.init();
        const pub = wallet.getDefaultAddress().publicKey.toString('hex');
        assert.match(pub, /^0[23][0-9a-f]{64}$/, 'not a compressed secp256k1 public key');
    });

    it('derives distinct keys per index, and index 0 is the default', async () => {
        setSecretFile('secret.txt', KNOWN_SEED_HEX);
        const wallet = new Wallet(silentLogger);
        await wallet.init();
        const a0 = wallet.generateAddress(0).publicKey.toString('hex');
        const a1 = wallet.generateAddress(1).publicKey.toString('hex');
        const a2 = wallet.generateAddress(2).publicKey.toString('hex');
        assert.equal(wallet.getDefaultAddress().publicKey.toString('hex'), a0);
        assert.notEqual(a0, a1);
        assert.notEqual(a1, a2);
    });
});

describe('testnet vs mainnet derivation separation', () => {
    it('the same seed yields DIFFERENT keys on testnet and mainnet (path isolation)', async () => {
        // Cross-network key reuse would let a testnet signature move mainnet
        // funds; the HD path must diverge.
        setSecretFile('secret.txt', KNOWN_SEED_HEX);

        process.env.TESTNET = 'false';
        const mainnet = new Wallet(silentLogger);
        await mainnet.init();

        process.env.TESTNET = 'true';
        const testnet = new Wallet(silentLogger);
        await testnet.init();
        process.env.TESTNET = 'false';

        assert.notEqual(
            mainnet.getDefaultAddress().publicKey.toString('hex'),
            testnet.getDefaultAddress().publicKey.toString('hex'),
        );
        // Testnet must match its documented path m/44'/2909'/1'/0/0.
        const expectedTestnet = HDKey.fromMasterSeed(Buffer.from(KNOWN_SEED_HEX, 'hex')).derive(
            "m/44'/2909'/1'/0/0",
        );
        assert.equal(
            testnet.getDefaultAddress().publicKey.toString('hex'),
            expectedTestnet.publicKey.toString('hex'),
        );
    });
});

describe('first-run generation', () => {
    it('generates a NEW seed when none exists and persists it with 0o600 perms', async () => {
        assert.equal(fs.existsSync(path.join(tmpDir, 'secret.txt')), false);
        const wallet = new Wallet(silentLogger);
        await wallet.init();

        const filePath = path.join(tmpDir, 'secret.txt');
        assert.equal(fs.existsSync(filePath), true, 'seed was not persisted');
        // 0o600: no group/other access to the private seed.
        const mode = fs.statSync(filePath).mode & 0o777;
        assert.equal(mode, 0o600, `seed perms ${mode.toString(8)} are not 0600`);

        // The persisted seed must reproduce the same wallet on reload.
        const pubBefore = wallet.getDefaultAddress().publicKey.toString('hex');
        const reloaded = new Wallet(silentLogger);
        await reloaded.init();
        assert.equal(reloaded.getDefaultAddress().publicKey.toString('hex'), pubBefore);
    });

    it('persists a plaintext hex seed when no passphrase is set (round-trips through bip39)', async () => {
        const wallet = new Wallet(silentLogger);
        await wallet.init();
        const contents = fs.readFileSync(path.join(tmpDir, 'secret.txt'), 'utf8').trim();
        assert.match(contents, /^[0-9a-f]{128}$/, 'plaintext seed is not 64 raw hex bytes');
        assert.equal(contents.startsWith('enc:'), false);
    });
});

describe('encrypted seed (AES-256-GCM, scrypt)', () => {
    it('round-trips: an encrypted seed written with a passphrase reloads to the same keys', async () => {
        process.env.SECRET_PASSPHRASE = 'correct horse battery staple';
        const first = new Wallet(silentLogger);
        await first.init();
        const pub = first.getDefaultAddress().publicKey.toString('hex');

        const stored = fs.readFileSync(path.join(tmpDir, 'secret.txt'), 'utf8').trim();
        assert.equal(stored.startsWith('enc:'), true, 'seed was not stored encrypted');
        assert.doesNotMatch(stored, new RegExp(KNOWN_SEED_HEX), 'plaintext seed leaked to disk');

        const second = new Wallet(silentLogger);
        await second.init();
        assert.equal(second.getDefaultAddress().publicKey.toString('hex'), pub);
    });

    it('an encrypted seed without SECRET_PASSPHRASE fails loudly (does not silently regenerate)', async () => {
        process.env.SECRET_PASSPHRASE = 'passphrase-A';
        await new Wallet(silentLogger).init();
        const encrypted = fs.readFileSync(path.join(tmpDir, 'secret.txt'), 'utf8');

        delete process.env.SECRET_PASSPHRASE;
        const wallet = new Wallet(silentLogger);
        await assert.rejects(() => wallet.init(), /encrypted but SECRET_PASSPHRASE is not set/);
        // The encrypted file MUST be intact — no regeneration, no fund loss.
        assert.equal(fs.readFileSync(path.join(tmpDir, 'secret.txt'), 'utf8'), encrypted);
    });

    it('CRITICAL: a WRONG passphrase must NOT overwrite the existing seed (fund-loss guard)', async () => {
        // The single most dangerous wallet bug: a decrypt failure that falls
        // through to "generate a new seed" destroys the user's keys forever.
        // init() must throw and leave the ciphertext byte-for-byte intact.
        process.env.SECRET_PASSPHRASE = 'the-real-passphrase';
        await new Wallet(silentLogger).init();
        const original = fs.readFileSync(path.join(tmpDir, 'secret.txt'), 'utf8');

        process.env.SECRET_PASSPHRASE = 'a-wrong-passphrase';
        const wallet = new Wallet(silentLogger);
        await assert.rejects(() => wallet.init(), 'wrong passphrase did not throw');
        assert.equal(
            fs.readFileSync(path.join(tmpDir, 'secret.txt'), 'utf8'),
            original,
            'WRONG PASSPHRASE OVERWROTE THE SEED — funds would be lost',
        );

        // And the correct passphrase still recovers the wallet afterwards.
        process.env.SECRET_PASSPHRASE = 'the-real-passphrase';
        const recovered = new Wallet(silentLogger);
        await recovered.init();
        assert.ok(recovered.getDefaultAddress().publicKey);
    });
});

describe('bip39 mnemonic invariants (library-level guarantees the wallet relies on)', () => {
    it('a validly generated mnemonic re-derives a stable seed; an invalid one is rejected', async () => {
        const mnemonic = bip39.generateMnemonic();
        assert.equal(bip39.validateMnemonic(mnemonic), true);
        const seedA = await bip39.mnemonicToSeed(mnemonic);
        const seedB = await bip39.mnemonicToSeed(mnemonic);
        assert.equal(seedA.toString('hex'), seedB.toString('hex'));

        // A tampered mnemonic (bad checksum) must not validate.
        const words = mnemonic.split(' ');
        words[0] = words[0] === 'abandon' ? 'ability' : 'abandon';
        assert.equal(bip39.validateMnemonic(words.join(' ')), false);
    });
});
