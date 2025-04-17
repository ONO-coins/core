const Big = require('big.js');
const balanceDao = require('../databases/postgres/dao/balance.dao');
const transactionDao = require('../databases/postgres/dao/transaction.dao');
const sharedBalanceService = require('./shared/balance.service');
const database = require('../databases/postgres');
const { BLOCKCHAIN_SETTINGS } = require('../constants/app.constants');

const sequelize = database.getSequelize();

/**
 * @typedef {import('databases/postgres/models/transaction.model').Transaction} Transaction
 * @typedef {import('services/block-transaction.service').BlockWithTransactions} BlockWithTransactions
 * @typedef {import('databases/postgres/models/balance.model').Balance} Balance
 * @typedef {import('sequelize').Transaction} DatabaseTransaction
 */

/**
 * @param {string} address
 * @param {number} amount
 * @param {number} burned
 * @param {number} blockId
 * @param {DatabaseTransaction} [databaseTransaction]
 * @returns {Promise<Balance>}
 */
exports.changeOrCreateBalance = async (address, amount, burned, blockId, databaseTransaction) => {
    const exists = await balanceDao.getBalance(address, databaseTransaction);
    if (exists) {
        if (exists.affectedBlockId === blockId) {
            const { balance, burnedBalance } = await sharedBalanceService.calculateBalace(
                address,
                databaseTransaction,
            );
            const record = await balanceDao.updateBalances(
                address,
                balance,
                burnedBalance,
                databaseTransaction,
            );
            return record;
        } else {
            const record = await balanceDao.changeBalance(
                address,
                amount,
                burned,
                blockId,
                databaseTransaction,
            );
            return record;
        }
    } else {
        const { balance, burnedBalance } = await sharedBalanceService.calculateBalace(
            address,
            databaseTransaction,
        );
        const newRecord = await balanceDao.create(
            address,
            balance,
            burnedBalance,
            blockId,
            databaseTransaction,
        );
        return newRecord;
    }
};

/**
 * @param {Transaction} transaction
 * @param {number} blockId
 * @param {DatabaseTransaction} [databaseTransaction]
 */
exports.updateByTransaction = async (transaction, blockId, databaseTransaction) => {
    const senderBalanceChange = -transaction.amount - transaction.fee;
    const burned = transaction.to === BLOCKCHAIN_SETTINGS.BURN_ADDRESS ? transaction.amount : 0;
    await this.changeOrCreateBalance(
        transaction.from,
        senderBalanceChange,
        burned,
        blockId,
        databaseTransaction,
    );
    await this.changeOrCreateBalance(
        transaction.to,
        transaction.amount,
        0,
        blockId,
        databaseTransaction,
    );
};

/**
 * @param {BlockWithTransactions} block
 * @param {DatabaseTransaction} [databaseTransaction]
 */
exports.updateByBlock = async (block, databaseTransaction) => {
    let fees = 0;
    for (let i = 0; i < block.transactions.length; i++) {
        await this.updateByTransaction(block.transactions[i], block.id, databaseTransaction);
        fees += new Big(block.transactions[i].fee).toNumber();
    }
    await this.changeOrCreateBalance(block.publicKey, fees, 0, block.id, databaseTransaction);
};

/**
 * @param {string} address
 * @param {number} blockId
 * @returns {Promise<number>}
 */
exports.getBurnedBalance = async (address, blockId) => {
    const balanceRecord = await balanceDao.getBalance(address);
    if (balanceRecord) return balanceRecord.burned;

    const databaseTransaction = await sequelize.transaction();
    const balance = await transactionDao.calculateBalance(address, databaseTransaction);
    const burnedBalance = await transactionDao.calculateBurnedBalance(address, databaseTransaction);
    await balanceDao.create(address, balance, burnedBalance, blockId, databaseTransaction);
    await databaseTransaction.commit();

    return burnedBalance;
};
