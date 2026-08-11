const bip39 = require('bip39');
const HDKey = require('hdkey');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const ENCRYPTED_PREFIX = 'enc:';

class Wallet {
    #hdWallet;
    #logger;
    #HD_PATH;

    constructor(logger) {
        this.#logger = logger;
        this.#HD_PATH = process.env.TESTNET === 'true' ? "m/44'/2909'/1'/0" : "m/44'/2909'/0'/0";
    }

    /**
     * AES-256-GCM with a scrypt-derived key. Layout: salt(16) || iv(12) || tag(16) || ct.
     * @param {string} seedHex
     * @param {string} passphrase
     * @returns {string}
     */
    #encryptSeed(seedHex, passphrase) {
        const salt = crypto.randomBytes(16);
        const iv = crypto.randomBytes(12);
        const key = crypto.scryptSync(passphrase, salt, 32);
        const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
        const ciphertext = Buffer.concat([cipher.update(Buffer.from(seedHex, 'hex')), cipher.final()]);
        const tag = cipher.getAuthTag();
        return ENCRYPTED_PREFIX + Buffer.concat([salt, iv, tag, ciphertext]).toString('hex');
    }

    /**
     * @param {string} fileContent
     * @param {string} passphrase
     * @returns {Buffer}
     */
    #decryptSeed(fileContent, passphrase) {
        const data = Buffer.from(fileContent.slice(ENCRYPTED_PREFIX.length), 'hex');
        const salt = data.subarray(0, 16);
        const iv = data.subarray(16, 28);
        const tag = data.subarray(28, 44);
        const ciphertext = data.subarray(44);
        const key = crypto.scryptSync(passphrase, salt, 32);
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    }

    /**
     * @returns {Promise<Buffer>}
     */
    async #getOrCreateSeedBuffer() {
        const secretLocalPath = process.env.SECRET_PATH
            ? process.env.SECRET_PATH
            : '/secrets/secret.txt';
        const secretPath = path.join(process.cwd(), secretLocalPath);
        const passphrase = process.env.SECRET_PASSPHRASE;
        try {
            const fileContent = fs.readFileSync(secretPath, 'utf8').trim();
            if (fileContent.startsWith(ENCRYPTED_PREFIX)) {
                if (!passphrase) {
                    throw new Error('Seed is encrypted but SECRET_PASSPHRASE is not set');
                }
                return this.#decryptSeed(fileContent, passphrase);
            }
            return Buffer.from(fileContent, 'hex');
        } catch (err) {
            // Only generate a brand-new wallet when the file truly does not exist.
            // Any other read/decrypt failure must NOT overwrite an existing seed
            // (e.g. a wrong passphrase) — that would destroy the key irrecoverably.
            if (err.code !== 'ENOENT') throw err;

            this.#logger.warn(
                `You don't have any secret. New one will be generated on path: ${secretPath}`,
            );
            const mnemonic = bip39.generateMnemonic();
            this.#logger.warn('----------------------------------------------');
            this.#logger.warn('IMPORTANT! We have just generated a new wallet!');
            this.#logger.warn(
                "This is your mnemonic phrase. Save this phrase in a safe place so you don't lose access to your wallet",
            );
            this.#logger.warn('Your mnemonic phrase:');
            this.#logger.warn(mnemonic);
            this.#logger.warn('----------------------------------------------');

            const seedBuffer = await bip39.mnemonicToSeed(mnemonic);
            const seedHex = seedBuffer.toString('hex');
            const toWrite = passphrase ? this.#encryptSeed(seedHex, passphrase) : seedHex;
            // 0o600: readable/writable only by the owner.
            fs.writeFileSync(secretPath, toWrite, { mode: 0o600 });
            return seedBuffer;
        }
    }

    async init() {
        const seedBuffer = await this.#getOrCreateSeedBuffer();
        this.#hdWallet = HDKey.fromMasterSeed(seedBuffer);
    }

    /**
     * @param {number} index
     */
    generateAddress(index) {
        const address = this.#hdWallet.derive(`${this.#HD_PATH}/${index}`);
        return address;
    }

    getDefaultAddress() {
        return this.generateAddress(0);
    }
}

module.exports = Wallet;
