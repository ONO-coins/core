const blockService = require('../services/block.service');
const forgerService = require('../services/forger.service');
const blockTransactionService = require('../services/block-transaction.service');
const balanceService = require('../services/balance.service');
const database = require('../databases/postgres');
const transactionDao = require('../databases/postgres/dao/transaction.dao');
const transactionPoolDao = require('../databases/postgres/dao/transaction-pool.dao');
const blockTransactionDao = require('../databases/postgres/dao/block-transaction.dao');
const blockDao = require('../databases/postgres/dao/block.dao');
const sharedBlockService = require('../services/shared/block.service');
const state = require('../state');
const { BLOCK_ID_ACTIONS } = require('../constants/app.constants');

const sequelize = database.getSequelize();

/**
 * @typedef {import('databases/postgres/models/transaction.model').Transaction} Transaction
 * @typedef {import('services/block-transaction.service').BlockWithTransactions} BlockWithTransactions
 */

/**
 * @param {BlockWithTransactions} blockData
 * @returns {Promise<boolean>}
 */
exports.onBlock = async (blockData) => {
    const processingBlockId = state.getState(state.KEYS.PROCESSING_BLOCK_ID);
    if (blockData.id === processingBlockId) return false;

    state.setState(state.KEYS.PROCESSING_BLOCK_ID, blockData.id);

    const validTimers = blockService.checkNewBlockTimings(blockData);
    if (!validTimers) throw new Error('Invalid block timings');

    // check if block exists or we are too far away
    const existingCheck = await blockService.checkNewBlockId(blockData);
    if (existingCheck === BLOCK_ID_ACTIONS.NEED_REPLACE) {
        const validSum = await blockTransactionService.compareBlockTransactionSum(blockData);
        if (!validSum) throw new Error(`Block already exists.`);

        const validHit = await sharedBlockService.compareHit(blockData);
        if (!validHit) throw new Error(`Block already exists.`);

        await sharedBlockService.removeChainSince(blockData.id - 1);
    }

    // Check consensus
    const consensusValid = await forgerService.verifyBlockHit(blockData);
    if (!consensusValid) throw new Error('Block with invalid consensus');

    // validate block
    const blockValidationResult = await blockTransactionService.validateBlock(blockData);
    if (!blockValidationResult.valid) throw new Error(blockValidationResult.error);

    const databaseTransaction = await sequelize.transaction();
    const { transactions, ...blockWithoutTransactions } = blockData;

    try {
        // check if existed transactions are in other block
        const transactionHashes = transactions.map((transaction) => transaction.hash);
        const existsInBlock = await blockTransactionDao.getOneInOtherBlock(
            transactionHashes,
            blockData.id,
        );
        if (existsInBlock) {
            throw new Error(
                `Transaction ${existsInBlock.transactionHash} already in block ${existsInBlock.blockId}`,
            );
        }

        // save new transactions
        await transactionDao.bulkUpsert(transactions, databaseTransaction);

        // change balances records
        await balanceService.updateByBlock(blockData, databaseTransaction);

        // save new block
        await blockDao.create(blockWithoutTransactions, databaseTransaction);

        // add transaction to new block
        await blockTransactionDao.bulkCreate(transactionHashes, blockData.id, databaseTransaction);

        // remove block transactions from transaction pool
        await transactionPoolDao.dropTransactions(transactionHashes, databaseTransaction);

        await databaseTransaction.commit();
        return true;
    } catch (err) {
        state.setState(state.KEYS.PROCESSING_BLOCK_ID, 0);
        await databaseTransaction.rollback();
        throw err;
    }
};
