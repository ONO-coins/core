const Big = require('big.js');

/**
 *  @typedef {import('sequelize').Transaction} DatabaseTransaction
 *  @typedef {import('databases/postgres/dao/block.dao').BlockWithTransactions} BlockWithTransactions
 *  @typedef {import('databases/postgres/dao/transaction.dao').Transaction} Transaction
 */

/**
 * @param {string} name
 * @returns {string}
 */
exports.foreignKey = (name) => name + 'Id';

/**
 * @param {DatabaseTransaction} transaction
 * @returns {{transaction?: DatabaseTransaction}}
 */
exports.databseTransactionParams = (transaction) => {
    return transaction ? { transaction } : {};
};

/**
 * @param {Transaction} transaction
 * @returns {Transaction}
 */
exports.formatTransactionNumbers = (transaction) => {
    return {
        ...transaction,
        amount: new Big(transaction.amount).toNumber(),
        fee: new Big(transaction.fee).toNumber(),
    };
};

/**
 * @param {BlockWithTransactions} block
 * @returns {BlockWithTransactions}
 */
exports.formatBlockNumbers = (block) => {
    return {
        ...block,
        transactions: block.transactions.map(this.formatTransactionNumbers),
    };
};
