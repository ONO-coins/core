const balanceService = require('./balance.service');
const blockDao = require('../databases/postgres/dao/block.dao');
const cryptoUtilsLib = require('../lib/crypto-utils.lib');
const { BLOCKCHAIN_SETTINGS } = require('../constants/app.constants');

/**
 * @typedef {import('databases/postgres/models/block.model').Block} Block
 */

/**
 * @param {Block} latestBlock
 * @param {string} publicKey
 * @returns {number}
 */
exports.calcTarget = (latestBlock, publicKey) => {
    const signatureWithPublicKey = latestBlock.signature + publicKey;
    const hash = cryptoUtilsLib.hash(signatureWithPublicKey);
    return parseInt(hash.substring(0, 9), 16);
};

/**
 * @param {Block} latestBlock
 * @param {number} timestamp
 * @param {string} publicKey
 * @returns {Promise<number>}
 */
exports.calcHit = async (latestBlock, timestamp, publicKey) => {
    const previousTarget = Number(latestBlock.target);
    const forgerBalance = await balanceService.getBurnedBalance(publicKey, latestBlock.id);
    if (forgerBalance < BLOCKCHAIN_SETTINGS.MIN_FORGER_BALANCE) return 0;

    const elapsedTime = timestamp - latestBlock.timestamp;
    return previousTarget * forgerBalance * elapsedTime;
};

/**
 * @param {Block} latestBlock
 * @param {number} timestamp
 * @param {string} publicKey
 * @returns {Promise<boolean>}
 */
exports.verifyHit = async (latestBlock, timestamp, publicKey) => {
    const target = this.calcTarget(latestBlock, publicKey);
    const hit = await this.calcHit(latestBlock, timestamp, publicKey);

    return target < hit;
};

/**
 * @param {Block} block
 * @returns {Promise<boolean>}
 */
exports.verifyBlockHit = async (block) => {
    const lastBlock = await blockDao.getById(block.id - 1);
    return this.verifyHit(lastBlock, block.timestamp, block.publicKey);
};
