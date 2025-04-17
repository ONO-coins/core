const wallet = require('../../wallet');
const transactionDao = require('../../databases/postgres/dao/transaction.dao');
const transactionService = require('../../services/transaction.service');
const transactionGeneralController = require('../../controllers/transaction.controller');
const { TOTAL_COUNT_HEADER } = require('../../constants/headers.constants.js');
const { BLOCKCHAIN_SETTINGS } = require('../../constants/app.constants');

/**
 * @typedef {import('express').Request} Request
 * @typedef {import('express').Response} Response
 */

/**
 * @param {Request} req
 * @param {Response} res
 */
exports.init = async (req, res) => {
    const transaction = await transactionGeneralController.newTransaction(req.body);
    res.json(transaction);
};

/**
 * @param {Request} req
 * @param {Response} res
 */
exports.getByAddress = async (req, res) => {
    const {
        limit = BLOCKCHAIN_SETTINGS.SYNCHRONIZATION_BATCH,
        skip = 0,
        order = 'DESC',
        ...filters
    } = req.query;

    const transactions = await transactionDao.getByAddress(
        req.params.address,
        Number(limit),
        Number(skip),
        String(order),
        filters,
    );
    const count = await transactionDao.countByAddress(req.params.address);
    res.set(TOTAL_COUNT_HEADER, String(count));
    res.json(transactions);
};

/**
 * @param {Request} req
 * @param {Response} res
 */
exports.getByHash = async (req, res) => {
    const transaction = await transactionDao.getByHash(req.params.hash);
    res.json(transaction);
};

/**
 * @param {Request} req
 * @param {Response} res
 */
exports.countByAddress = async (req, res) => {
    const count = await transactionDao.countByAddress(req.params.address);
    res.json({ count });
};
