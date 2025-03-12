const blockDao = require('../../databases/postgres/dao/block.dao');

/**
 * @typedef {import('express').Request} Request
 * @typedef {import('express').Response} Response
 */

/**
 * @param {Request} req
 * @param {Response} res
 */
exports.getOne = async (req, res) => {
    const block = await blockDao.getByIdWithTransactions(Number(req.params.id));
    res.json(block);
};

/**
 * @param {Request} req
 * @param {Response} res
 */
exports.getChain = async (req, res) => {
    const chain = await blockDao.getBlocksFrom(
        Number(req.query.fromId) - 1,
        Number(req.query.limit) || undefined,
    );
    res.json(chain);
};
