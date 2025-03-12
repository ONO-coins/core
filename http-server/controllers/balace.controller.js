const balanceDao = require('../../databases/postgres/dao/balance.dao');

/**
 * @typedef {import('express').Request} Request
 * @typedef {import('express').Response} Response
 */

/**
 * @param {Request} req
 * @param {Response} res
 */
exports.getBalance = async (req, res) => {
    const balanceRecord = await balanceDao.getBalance(req.params.address);
    res.json(balanceRecord);
};
