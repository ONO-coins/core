const forgerService = require('../forger.service');
const blockDao = require('../../databases/postgres/dao/block.dao');
const balanceDao = require('../../databases/postgres/dao/balance.dao');
const blockTransactionDao = require('../../databases/postgres/dao/block-transaction.dao');
const state = require('../../state');
const { BLOCKCHAIN_SETTINGS } = require('../../constants/app.constants');

/**
 * @typedef {import('databases/postgres/models/block.model').Block} Block
 */

/**
 * @param {Block} block
 * @returns {Promise<boolean>}
 */
exports.compareHit = async (block) => {
    const previousBlock = await blockDao.getById(block.id - 1);
    const externalHit = await forgerService.calcHit(
        previousBlock,
        block.timestamp,
        block.publicKey,
    );

    const ourBlock = await blockDao.getById(block.id);
    const ourHit = await forgerService.calcHit(
        previousBlock,
        ourBlock.timestamp,
        ourBlock.publicKey,
    );

    return externalHit > ourHit;
};

/**
 * @param {number} blockId
 */
exports.removeChainSince = async (blockId) => {
    await blockTransactionDao.removeSinceBlockId(blockId);
    await balanceDao.flushBalancesFromBlock(blockId);
    state.setImmutableBlockId(blockId - BLOCKCHAIN_SETTINGS.MAX_MUTABLE_BLOCK_COUNT);
};
