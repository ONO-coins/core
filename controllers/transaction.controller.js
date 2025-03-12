const transactionService = require('../services/transaction.servise');
const transactionPoolDao = require('../databases/postgres/dao/transaction-pool.dao');
const p2pActions = require('../p2p/p2p-actions');

/**
 * @typedef {import('databases/postgres/models/transaction.model').Transaction} Transaction
 */

/**
 * @param {Transaction} transactionData
 * @param {string} [sernderKey]
 * @returns {Promise<Transaction>}
 */
exports.newTransaction = async (transactionData, sernderKey) => {
    const validBalance = await transactionService.validateTransaction(transactionData);
    if (!validBalance) throw new Error(validBalance.error);

    const transaction = await transactionService.newTransaction(transactionData);

    await transactionPoolDao.upsert(transaction.hash);
    p2pActions.broadcastTransaction(transaction, [sernderKey]);
    return transaction;
};
