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
    // fromId is optional; default to 0 (from genesis). Without this guard a missing
    // fromId becomes NaN and reaches the query as `id > NaN`, which Postgres rejects.
    const fromId = Number(req.query.fromId);
    const startAfter = (Number.isInteger(fromId) ? fromId : 0) - 1;
    const chain = await blockDao.getBlocksFrom(startAfter, Number(req.query.limit) || undefined);
    res.json(chain);
};
