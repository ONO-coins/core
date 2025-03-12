const { SyncError } = require('../constructors/error.constructor');
const blockService = require('../services/block.service');
const forgerService = require('../services/forger.service');
const blockTransactionService = require('../services/block-transaction.servise');
const balanceService = require('../services/balance.service');
const database = require('../databases/postgres');
const transactionDao = require('../databases/postgres/dao/transaction.dao');
const transactionPoolDao = require('../databases/postgres/dao/transaction-pool.dao');
const blockTransactionDao = require('../databases/postgres/dao/block-transaction.dao');
const blockDao = require('../databases/postgres/dao/block.dao');

const sequelize = database.getSequelize();

/**
 * @typedef {import('databases/postgres/models/transaction.model').Transaction} Transaction
 * @typedef {import('services/block-transaction.servise').BlockWithTransactions} BlockWithTransactions
 */

/**
 * @param {BlockWithTransactions} blockData
 */
exports.onBlock = async (blockData) => {
    // check if block exists or we are too far away
    const existingCheck = await blockService.checkNewBlockId(blockData.id);
    if (existingCheck.exists) throw new Error(`Block already exists.`);
    if (existingCheck.needSync) throw new SyncError(`Block is too far away. Need sync.`);

    // Check consensus
    const consensusValid = await forgerService.verifyBlockHit(blockData);
    if (!consensusValid) throw new Error('Block with invalid consensus');

    // validate block
    const blockValidationResilt = await blockTransactionService.validateBlock(blockData);
    if (!blockValidationResilt.valid) throw new Error(blockValidationResilt.error);

    const databaseTransaction = await sequelize.transaction();
    const { transactions, ...blockWithoutTransactions } = blockData;

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

    // remove block transactions from transactionpool
    await transactionPoolDao.dropTransactions(transactionHashes, databaseTransaction);

    await databaseTransaction.commit();
};
