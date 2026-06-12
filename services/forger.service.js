const Big = require('big.js');
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
 * The hit can exceed Number.MAX_SAFE_INTEGER (previousTarget * burned * elapsed),
 * so it is computed and compared with big.js — otherwise two nodes can round
 * differently and disagree on a close fork decision (review M1).
 * @param {Block} latestBlock
 * @param {number} timestamp
 * @param {string} publicKey
 * @returns {Promise<Big>}
 */
exports.calcHit = async (latestBlock, timestamp, publicKey) => {
    const previousTarget = Number(latestBlock.target);
    const forgerBalance = await balanceService.getBurnedBalance(publicKey, latestBlock.id);
    if (forgerBalance < BLOCKCHAIN_SETTINGS.MIN_FORGER_BALANCE) return new Big(0);

    const elapsedTime = timestamp - latestBlock.timestamp;
    return new Big(previousTarget).times(forgerBalance).times(elapsedTime);
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

    return hit.gt(target);
};

/**
 * @param {Block} block
 * @returns {Promise<boolean>}
 */
exports.verifyBlockHit = async (block) => {
    const lastBlock = await blockDao.getById(block.id - 1);
    return this.verifyHit(lastBlock, block.timestamp, block.publicKey);
};

/**
 * @param {Block} latestBlock
 * @param {string} publicKey
 * @returns {Promise<number>}
 */
exports.predictForgingTimestamp = async (latestBlock, publicKey) => {
    const target = this.calcTarget(latestBlock, publicKey);
    const previousTarget = Number(latestBlock.target);
    const forgerBalance = await balanceService.getBurnedBalance(publicKey, latestBlock.id);
    const divisor = new Big(previousTarget).times(forgerBalance);
    if (divisor.eq(0)) return Infinity;
    const nextTimestamp = new Big(target).div(divisor).plus(latestBlock.timestamp);
    return Math.ceil(nextTimestamp.toNumber());
};
