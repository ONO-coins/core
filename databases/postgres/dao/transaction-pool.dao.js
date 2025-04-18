const { Op, QueryTypes } = require('sequelize');
const { MODEL_NAME } = require('../../../constants/models/transaction-pool.constants');
const {
    TABLE_NAME: TRANSACTION_TABLE_NAME,
} = require('../../../constants/models/transaction.constants');
const {
    TABLE_NAME: TRANSACTION_POOL_TABLE_NAME,
} = require('../../../constants/models/transaction-pool.constants');
const database = require('..');
const sequelize = database.getSequelize();
const transactionPool = database.getModel(MODEL_NAME);
const postgresHelperLib = require('../../../lib/postgres-helper.lib');

/**
 * @typedef {import('../models/transaction.model').Transaction} Transaction
 * @typedef {import('../models/transaction-pool.model').TransactionPool} TransactionPool
 * @typedef {import('sequelize').Transaction} DatabaseTransaction
 */

/**
 * @param {string} transactionHash
 * @returns {Promise<TransactionPool>}
 */
exports.upsert = async (transactionHash) => {
    const databaseTransaction = await sequelize.transaction();
    const existedPoolTransaction = await transactionPool.findOne({
        where: { transactionHash },
        transaction: databaseTransaction,
    });

    if (existedPoolTransaction) {
        databaseTransaction.commit();
        return existedPoolTransaction.toJSON();
    }

    const newPoolTransaction = await transactionPool.create(
        { transactionHash },
        {
            transaction: databaseTransaction,
        },
    );
    databaseTransaction.commit();
    return newPoolTransaction.toJSON();
};

/**
 * @param {number} count
 * @param {DatabaseTransaction} [databaseTransaction]
 * @returns {Promise<Array<Transaction>>}
 */
exports.getTransactions = async (count, databaseTransaction) => {
    const query = `
        SELECT DISTINCT ON ("t"."from") "t".*
        FROM ${TRANSACTION_POOL_TABLE_NAME} AS "tp"
        JOIN ${TRANSACTION_TABLE_NAME} AS "t" ON "tp"."transaction_hash" = "t"."hash"
        ORDER BY "t"."from", "t"."timestamp" DESC
        LIMIT :count;
    `;

    /** @type {Array<Transaction>} */
    const records = await sequelize.query(query, {
        type: QueryTypes.SELECT,
        replacements: { count },
        transaction: databaseTransaction,
    });

    return records;
};

/**
 * @param {Array<string>} transactionHashes
 * @param {DatabaseTransaction} databaseTransaction
 */
exports.dropTransactions = async (transactionHashes, databaseTransaction) => {
    await transactionPool.destroy({
        where: { transactionHash: { [Op.in]: transactionHashes } },
        ...postgresHelperLib.databaseTransactionParams(databaseTransaction),
    });
};

/**
 * @returns {Promise<void>}
 */
exports.clear = async () => {
    await transactionPool.destroy({
        where: {},
    });
};
