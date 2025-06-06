const blockService = require('../services/block.service');
const balanceService = require('../services/balance.service');
const forgerService = require('../services/forger.service');
const database = require('../databases/postgres');
const blockDao = require('../databases/postgres/dao/block.dao');
const blockTransactionDao = require('../databases/postgres/dao/block-transaction.dao');
const transactionPoolDao = require('../databases/postgres/dao/transaction-pool.dao');
const p2pActions = require('../p2p/p2p-actions');
const state = require('../state');
const { logger } = require('../managers/log.manager');
const { wallet } = require('../wallet');
const { BLOCKCHAIN_SETTINGS } = require('../constants/app.constants');

const sequelize = database.getSequelize();
const keyPir = wallet.getDefaultAddress();
const publicKey = wallet.getDefaultAddress().publicKey.toString('hex');

/**
 * @typedef {import('databases/postgres/models/transaction.model').Transaction} Transaction
 * @typedef {import('databases/postgres/models/block.model').Block} Block
 * @typedef {import('services/block-transaction.service').BlockWithTransactions} BlockWithTransactions
 * @typedef {import('hdkey')} HDNode
 */

/**
 * @param {Block} lastBlock
 * @param {number} timestamp
 * @returns {Promise<BlockWithTransactions>}
 */
const generateBlock = async (lastBlock, timestamp) => {
    const databaseTransaction = await sequelize.transaction();
    try {
        const transactions = await transactionPoolDao.getTransactions(
            BLOCKCHAIN_SETTINGS.MAX_TRANSACTION_PER_BLOCK,
        );
        const newBlock = blockService.generateBlock(
            lastBlock,
            publicKey,
            timestamp,
            transactions,
            keyPir,
        );
        const { transactions: removed, ...newBlockData } = newBlock;
        await blockDao.create(newBlockData, databaseTransaction);
        const transactionHashes = transactions.map((transaction) => transaction.hash);
        await blockTransactionDao.bulkCreate(transactionHashes, newBlock.id, databaseTransaction);
        await balanceService.updateByBlock(newBlock, databaseTransaction);
        await transactionPoolDao.dropTransactions(transactionHashes, databaseTransaction);
        await databaseTransaction.commit();
        return newBlock;
    } catch (err) {
        logger.error(err);
        await databaseTransaction.rollback();
    }
};

/**
 * @returns {Boolean}
 */
exports.isForging = () => {
    const forging = state.getState(state.KEYS.FORGING);
    const syncing = state.getState(state.KEYS.SYNCING);
    return forging && !syncing;
};

/**
 * @param {number} currentTimestamp
 * @returns {Boolean}
 */
exports.checkPredictedTime = (currentTimestamp) => {
    const nextTimestamp = state.getState(state.KEYS.FORGER_PREDICTED_TIMESTAMP);
    return nextTimestamp > currentTimestamp;
};

exports.forge = async () => {
    if (!this.isForging()) return;

    const timestamp = Math.round(Date.now() / 1000);
    if (this.checkPredictedTime(timestamp)) return;

    try {
        const lastBlock = await blockDao.getLastBlock();
        const processingBlockId = state.getState(state.KEYS.PROCESSING_BLOCK_ID);
        if (lastBlock.id + 1 === processingBlockId) return;

        const hitVerified = await forgerService.verifyHit(lastBlock, timestamp, publicKey);

        if (!hitVerified) {
            const nextTimestamp = await forgerService.predictForgingTimestamp(lastBlock, publicKey);
            state.setState(state.KEYS.FORGER_PREDICTED_TIMESTAMP, nextTimestamp);
            return;
        }

        logger.info(`Creating new block...`);
        const newBlock = await generateBlock(lastBlock, timestamp);
        if (newBlock) {
            logger.info(`New block ${newBlock.id} created`);
            p2pActions.broadcastBlock(newBlock);
        }
    } catch (err) {
        logger.error(err);
    }
};

exports.start = async () => {
    logger.info('Forger started. A message will be provided if a new block is forged.');
    if (!this.isForging()) return;
    setInterval(this.forge, 1000);
};
