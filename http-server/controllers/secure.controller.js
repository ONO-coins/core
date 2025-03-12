const balanceDao = require('../../databases/postgres/dao/balance.dao');
const blockTransactionDao = require('../../databases/postgres/dao/block-transaction.dao');
const state = require('../../state');
const { BLOCKCHAIN_SETTINGS } = require('../../constants/app.constants');

/**
 * @typedef {import('express').Request} Request
 * @typedef {import('express').Response} Response
 */

/**
 * @param {Request} req
 * @param {Response} res
 */
exports.removeChainTo = async (req, res) => {
    const blockId = Number(req.params.blockId);
    await blockTransactionDao.removeSinceBlockId(blockId);
    await balanceDao.flushBalancesFromBlock(blockId);
    state.setImmutableBlockId(blockId - BLOCKCHAIN_SETTINGS.MAX_MUTABLE_BLOCK_COUNT);
    res.json({ blockId });
};
