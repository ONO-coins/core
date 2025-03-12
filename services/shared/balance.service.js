const transactionDao = require('../../databases/postgres/dao/transaction.dao');

/**
 * @typedef {import('databases/postgres/models/transaction.model').Transaction} Transaction
 * @typedef {import('services/block-transaction.servise').BlockWithTransactions} BlockWithTransactions
 * @typedef {import('databases/postgres/models/balance.model').Balance} Balance
 * @typedef {import('sequelize').Transaction} DatabaseTransaction
 */

/**
 * @param {string} address
 * @param {DatabaseTransaction} [databaseTransaction]
 * @returns {Promise<{balance: number, burnedBalance: number}>}
 */
exports.calculateBalace = async (address, databaseTransaction) => {
    const balance = await transactionDao.calculateBalance(address, databaseTransaction);
    const burnedBalance = await transactionDao.calculateBurnedBalance(address, databaseTransaction);
    return { balance, burnedBalance };
};
