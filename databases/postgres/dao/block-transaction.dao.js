const { Op } = require('sequelize');
const { MODEL_NAME } = require('../../../constants/models/block-transaction.constants');
const database = require('..');
const blockTransaction = database.getModel(MODEL_NAME);
const postgresHelperLib = require('../../../lib/postgres-helper.lib');
const sequelize = database.getSequelize();
const Sequelize = require('sequelize');

/**
 * @typedef {import('../models/transaction.model').Transaction} Transaction
 * @typedef {import('../models/block-transaction.model').BlockTransaction} BlockTransaction
 * @typedef {import('../models/transaction-pool.model').TransactionPool} TransactionPool
 * @typedef {import('sequelize').Transaction} DatabaseTransaction
 */

/**
 * @param {Array<string>} transactionHashes
 * @param {number} blockId
 * @param {DatabaseTransaction} [databaseTransaction]
 * @returns {Promise<Array<TransactionPool>>}
 */
exports.bulkCreate = async (transactionHashes, blockId, databaseTransaction) => {
    const blockTransactionsData = transactionHashes.map((transactionHash) => ({
        transactionHash,
        blockId,
    }));
    const blockTransactions = await blockTransaction.bulkCreate(
        blockTransactionsData,
        postgresHelperLib.databaseTransactionParams(databaseTransaction),
    );
    return blockTransactions;
};

/**
 * @param {Array<string>} transactionHashes
 * @param {number} blockId
 * @param {DatabaseTransaction} [databaseTransaction]
 * @returns {Promise<BlockTransaction|null>}
 */
exports.getOneInOtherBlock = async (transactionHashes, blockId, databaseTransaction) => {
    const exists = await blockTransaction.findOne({
        where: { transactionHash: { [Op.in]: transactionHashes }, blockId: { [Op.lt]: blockId } },
        ...postgresHelperLib.databaseTransactionParams(databaseTransaction),
    });
    return exists;
};

/**
 * @typedef {Object} TransactionTotalResult
 * @property {number|null} total
 */

/**
 * @param {number} blockId
 * @returns {Promise<number>}
 */
exports.transactionSumFromBlockId = async (blockId) => {
    const query = `
        SELECT SUM(t.amount) AS total
        FROM block_transactions bt
        JOIN transactions t ON bt.transaction_hash = t.hash
        WHERE bt.block_id > :blockId;
    `;

    /** @type {Array<TransactionTotalResult>} */
    const [results] = await sequelize.query(query, {
        type: Sequelize.QueryTypes.SELECT,
        replacements: { blockId },
    });

    return results.total || 0;
};

/**
 * @param {number} blockId
 * @returns {Promise<number>}
 */
exports.uniqueAddressTransactionCountFromBlockId = async (blockId) => {
    const query = `
        SELECT COUNT(distinct t.from) AS total
        FROM block_transactions bt
        JOIN transactions t ON bt.transaction_hash = t.hash
        WHERE bt.block_id > :blockId;
    `;

    /** @type {Array<TransactionTotalResult>} */
    const [results] = await sequelize.query(query, {
        type: Sequelize.QueryTypes.SELECT,
        replacements: { blockId },
    });

    return results.total || 0;
};

/**
 * @param {number} blockId
 * @param {DatabaseTransaction} [databaseTransaction]
 * @returns {Promise<void>}
 */
exports.removeSinceBlockId = async (blockId, databaseTransaction) => {
    const query = `
        DELETE FROM "transactions"
        WHERE "hash" IN (
            SELECT "transaction_hash"
            FROM "block_transactions"
            WHERE "block_id" > :blockId
        );

        DELETE FROM "block_transactions"
        WHERE "block_id" > :blockId;

        DELETE FROM "blocks"
        WHERE "id" > :blockId;
        `;

    /** @type {Array<TransactionTotalResult>} */
    const results = await sequelize.query(query, {
        type: Sequelize.QueryTypes.SELECT,
        replacements: { blockId },
        ...postgresHelperLib.databaseTransactionParams(databaseTransaction),
    });
};
