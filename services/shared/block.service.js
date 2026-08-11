const blockDao = require('../../databases/postgres/dao/block.dao');
const balanceDao = require('../../databases/postgres/dao/balance.dao');
const blockTransactionDao = require('../../databases/postgres/dao/block-transaction.dao');
const state = require('../../state');
const { BLOCKCHAIN_SETTINGS } = require('../../constants/app.constants');

/**
 * @typedef {import('databases/postgres/models/block.model').Block} Block
 */

/**
 * Decide whether an external block should replace our stored block at the same
 * height. Both share a parent, so the heavier one is the harder-to-forge (lower
 * target) block; ties are broken by the lexicographically smaller hash so every
 * node converges on the same winner. Unlike the old hit comparison, this depends
 * only on signed, in-block fields — not the mutable balance cache (review S3/S5).
 * @param {Block} block
 * @returns {Promise<boolean>}
 */
exports.compareBlockDifficulty = async (block) => {
    const ourBlock = await blockDao.getById(block.id);
    if (!ourBlock) return true;

    if (block.target < ourBlock.target) return true;
    if (block.target === ourBlock.target) return block.hash < ourBlock.hash;
    return false;
};

/**
 * @param {number} blockId
 * @param {import('sequelize').Transaction} [databaseTransaction]
 */
exports.removeChainSince = async (blockId, databaseTransaction) => {
    await blockTransactionDao.removeSinceBlockId(blockId, databaseTransaction);
    await balanceDao.flushBalancesFromBlock(blockId, databaseTransaction);

    const immutableBlockId = Math.max(0, blockId - BLOCKCHAIN_SETTINGS.MAX_MUTABLE_BLOCK_COUNT);
    state.setState(state.KEYS.IMMUTABLE_BLOCK_ID, immutableBlockId);
};
