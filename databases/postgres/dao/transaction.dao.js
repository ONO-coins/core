const { Op } = require('sequelize');
const { MODEL_NAME } = require('../../../constants/models/transaction.constants');
const {
    MODEL_NAME: BLOCK_TRANSACTION_MODEL_NAME,
} = require('../../../constants/models/block-transaction.constants');
const database = require('..');
const sequelize = database.getSequelize();
const transaction = database.getModel(MODEL_NAME);
const postgresHelperLib = require('../../../lib/postgres-helper.lib');
const { BLOCKCHAIN_SETTINGS } = require('../../../constants/app.constants');

/**
 * @typedef {import('../models/transaction.model').Transaction} Transaction
 * @typedef {import('sequelize').Transaction} DatabaseTransaction
 */

/**
 * @param {string} hash
 * @param {DatabaseTransaction} [databaseTransaction]
 * @returns {Promise<Transaction?>}
 */
exports.findOne = async (hash, databaseTransaction) => {
    const record = await transaction.findOne({
        where: { hash },
        ...postgresHelperLib.databseTransactionParams(databaseTransaction),
    });
    return record?.toJSON();
};

/**
 * @param {Transaction} transactionData
 * @param {DatabaseTransaction} [databaseTransaction]
 * @returns {Promise<Transaction>}
 */
exports.create = async (transactionData, databaseTransaction) => {
    const newTransaction = await transaction.create(
        transactionData,
        postgresHelperLib.databseTransactionParams(databaseTransaction),
    );
    return newTransaction.toJSON();
};

/**
 * @param {Transaction} transactionData
 * @returns {Promise<Transaction>}
 */
exports.upsert = async (transactionData) => {
    const databaseTransaction = await sequelize.transaction();
    const existedTransaction = await transaction.findOne({
        where: { hash: transactionData.hash },
        ...postgresHelperLib.databseTransactionParams(databaseTransaction),
    });

    if (existedTransaction) {
        await databaseTransaction.commit();
        return existedTransaction.toJSON();
    }

    const newTransaction = await transaction.create(
        transactionData,
        postgresHelperLib.databseTransactionParams(databaseTransaction),
    );
    await databaseTransaction.commit();
    return newTransaction.toJSON();
};

/**
 * @param {Array<string>} transactionHashes
 * @param {DatabaseTransaction} [databaseTransaction]
 * @returns {Promise<Array<Transaction>>}
 */
exports.findByHashes = async (transactionHashes, databaseTransaction) => {
    const existedTransactions = await transaction.findAll({
        where: { hash: { [Op.in]: transactionHashes } },
        ...postgresHelperLib.databseTransactionParams(databaseTransaction),
    });
    return existedTransactions;
};

/**
 * @param {Array<Transaction>} transactionsData
 * @param {DatabaseTransaction} [databaseTransaction]
 * @returns {Promise<Array<Transaction>>}
 */
exports.bulkCreate = async (transactionsData, databaseTransaction) => {
    const createdTransactions = await transaction.bulkCreate(
        transactionsData,
        postgresHelperLib.databseTransactionParams(databaseTransaction),
    );
    return createdTransactions;
};

/**
 * @param {Array<Transaction>} transactions
 * @param {DatabaseTransaction} [databaseTransaction]
 * @returns {Promise<Array<Transaction>>}
 */
exports.bulkUpsert = async (transactions, databaseTransaction) => {
    const transactionHashes = transactions.map((transaction) => transaction.hash);
    const existedTransactions = await transaction.findAll({
        attributes: ['hash'],
        where: { hash: { [Op.in]: transactionHashes } },
        ...postgresHelperLib.databseTransactionParams(databaseTransaction),
    });
    const existingHashedSet = new Set(existedTransactions.map((record) => record.hash));
    const newTransactionsData = transactions.filter(
        (transaction) => !existingHashedSet.has(transaction.hash),
    );
    const createdTransactions = await transaction.bulkCreate(
        newTransactionsData,
        postgresHelperLib.databseTransactionParams(databaseTransaction),
    );
    return createdTransactions;
};

/**
 * @param {string} address
 * @param {DatabaseTransaction} [databaseTransaction]
 * @returns {Promise<number>}
 */
exports.calculateBalance = async (address, databaseTransaction) => {
    const debit =
        (await transaction.sum('amount', {
            where: { to: address },
            include: [
                { association: BLOCK_TRANSACTION_MODEL_NAME, required: true, attributes: [] },
            ],
            ...postgresHelperLib.databseTransactionParams(databaseTransaction),
        })) || 0;
    const credit =
        (await transaction.sum('amount', {
            where: { from: address },
            include: [
                { association: BLOCK_TRANSACTION_MODEL_NAME, required: true, attributes: [] },
            ],
            ...postgresHelperLib.databseTransactionParams(databaseTransaction),
        })) || 0;
    const fee =
        (await transaction.sum('fee', {
            where: { from: address },
            include: [
                { association: BLOCK_TRANSACTION_MODEL_NAME, required: true, attributes: [] },
            ],
            ...postgresHelperLib.databseTransactionParams(databaseTransaction),
        })) || 0;
    return debit - credit - fee;
};

/**
 * @param {string} address
 * @param {DatabaseTransaction} [databaseTransaction]
 * @returns {Promise<number>}
 */
exports.calculateBurnedBalance = async (address, databaseTransaction) => {
    const burnedBalance =
        (await transaction.sum('amount', {
            where: { from: address, to: BLOCKCHAIN_SETTINGS.BURN_ADDRESS },
            include: [
                { association: BLOCK_TRANSACTION_MODEL_NAME, required: true, attributes: [] },
            ],
            ...postgresHelperLib.databseTransactionParams(databaseTransaction),
        })) || 0;
    return burnedBalance;
};

/**
 * @typedef {Object} GetByAddressFilters
 * @property {number} [maxId]
 * @property {string} [direction]
 * @property {string} [hash]
 */

/**
 * @param {string} address
 * @param {number} [limit]
 * @param {number} [offset]
 * @param {string} [order]
 * @param {GetByAddressFilters} [filters]
 * @returns {Promise<Array<Transaction>>}
 */
exports.getByAddress = async (
    address,
    limit = BLOCKCHAIN_SETTINGS.SYNCHRONIZATION_BATCH,
    offset = 0,
    order = 'DESC',
    filters,
) => {
    const idQuery = filters.maxId ? { where: { id: { [Op.lt]: filters.maxId } } } : {};
    const where = filters.direction
        ? { [filters.direction]: address }
        : { [Op.or]: [{ from: address }, { to: address }] };
    if (filters.hash) where.hash = filters.hash;

    const records = await transaction.findAll({
        where,
        order: [['blockTransaction', 'id', order]],
        include: [
            {
                association: BLOCK_TRANSACTION_MODEL_NAME,
                ...idQuery,
                required: true,
                attributes: ['id', 'blockId'],
            },
        ],
        limit,
        offset,
    });
    return records.map((transaction) => {
        const transactionObject = transaction.toJSON();
        return postgresHelperLib.formatTransactionNumbers(transactionObject);
    });
};

/**
 * @param {string} address
 * @returns {Promise<number>}
 */
exports.countByAddress = async (address) => {
    const count = await transaction.count({
        where: { [Op.or]: [{ from: address }, { to: address }] },
    });
    return count || 0;
};

/**
 * @param {string} hash
 * @returns {Promise<Transaction>}
 */
exports.getByHash = async (hash) => {
    const record = await transaction.findOne({
        where: { hash },
        include: [
            {
                association: BLOCK_TRANSACTION_MODEL_NAME,
                required: true,
                attributes: ['blockId'],
            },
        ],
    });
    return record;
};

/**
 * @param {string} address
 * @returns {Promise<number>}
 */
exports.countByAddress = async (address) => {
    const count = await transaction.count({
        where: { [Op.or]: [{ from: address }, { to: address }] },
        order: [['blockTransaction', 'id', 'DESC']],
        include: [
            {
                association: BLOCK_TRANSACTION_MODEL_NAME,
                required: true,
                attributes: [],
            },
        ],
    });
    return count;
};
