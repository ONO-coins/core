const transactionGeneralController = require('../../controllers/transaction.controller');
const { logger } = require('../../managers/log.manager');

/**
 * @typedef {import('databases/postgres/models/transaction.model').Transaction} Transaction
 */

/**
 * @param {Transaction} transactionData
 * @param {string} [senderKey]
 */
exports.onTransaction = async (transactionData, senderKey) => {
    try {
        await transactionGeneralController.newTransaction(transactionData, senderKey);
    } catch (err) {
        logger.warn(`Transaction hash: ${transactionData?.hash}.\n ${err.message}`);
    }
};
