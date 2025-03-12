const transactionGeneralController = require('../../controllers/transaction.controller');
const { logger } = require('../../managers/log.manager');

/**
 * @typedef {import('databases/postgres/models/transaction.model').Transaction} Transaction
 */

/**
 * @param {Transaction} transactionData
 * @param {string} [sernderKey]
 */
exports.onTransaction = async (transactionData, sernderKey) => {
    try {
        await transactionGeneralController.newTransaction(transactionData, sernderKey);
    } catch (err) {
        logger.warn(`Transaction hash: ${transactionData?.hash}.\n ${err.message}`);
    }
};
