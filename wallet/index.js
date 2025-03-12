const Wallet = require('../constructors/wallet.constructor');
const loggerManager = require('../managers/log.manager');

exports.init = async () => {
    this.wallet = new Wallet(loggerManager.logger);
    await this.wallet.init();
};

exports.getWallet = () => {
    return this.wallet;
};

exports.getDefaultPrivateKey = () => {
    const defaultAddress = this.wallet.getDefaultAdress();
    return defaultAddress.privateKey;
};

/**
 * @returns {string}
 */
exports.getDefaultPublicKey = () => {
    const defaultAddress = this.wallet.getDefaultAdress();
    return defaultAddress.publicKey.toString('hex');
};
