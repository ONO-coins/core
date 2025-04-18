const transactionDao = require('../../databases/postgres/dao/transaction.dao');

/**
 * @typedef {import('databases/postgres/models/transaction.model').Transaction} Transaction
 * @typedef {import('services/block-transaction.service').BlockWithTransactions} BlockWithTransactions
 * @typedef {import('databases/postgres/models/balance.model').Balance} Balance
 * @typedef {import('sequelize').Transaction} DatabaseTransaction
 */

/**
 * @param {string} address
 * @param {DatabaseTransaction} [databaseTransaction]
 * @returns {Promise<{balance: number, burnedBalance: number}>}
 */
exports.calculateBalance = async (address, databaseTransaction) => {
    const balance = await transactionDao.calculateBalance(address, databaseTransaction);
    const burnedBalance = await transactionDao.calculateBurnedBalance(address, databaseTransaction);
    return { balance, burnedBalance };
};
