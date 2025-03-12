const bip39 = require('bip39');
const HDKey = require('hdkey');
const path = require('path');
const fs = require('fs');

class Wallet {
    #hdWallet;
    #logger;
    #HD_PATH;

    constructor(logger) {
        this.#logger = logger;
        this.#HD_PATH = process.env.TESTNET === 'true' ? "m/44'/2909'/1'/0" : "m/44'/2909'/0'/0";
    }

    /**
     * @returns {Promise<Buffer>}
     */
    async #getOrCreateSeedBuffer() {
        const secretPath = path.join(process.cwd(), '/secrets/secret.txt');
        try {
            const seed = fs.readFileSync(secretPath, 'utf8');
            return Buffer.from(seed, 'hex');
        } catch (err) {
            this.#logger.warn(
                `You dont have any secret. New one will be generated on path: ${secretPath}`,
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
            fs.appendFileSync(secretPath, seedBuffer.toString('hex'));
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

    getDefaultAdress() {
        return this.generateAddress(0);
    }
}

module.exports = Wallet;
