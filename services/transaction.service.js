const Big = require('big.js');
const cryptoUtilsLib = require('../lib/crypto-utils.lib');
const transactionDao = require('../databases/postgres/dao/transaction.dao');
const balanceDao = require('../databases/postgres/dao/balance.dao');
const blockDao = require('../databases/postgres/dao/block.dao');
const sharedBalanceService = require('./shared/balance.service');
const database = require('../databases/postgres');

/**
 * @typedef {import('databases/postgres/models/transaction.model').Transaction} Transaction
 */

const sequelize = database.getSequelize();

const HASH_PARAMS = ['from', 'to', 'timestamp', 'amount'];
const TRANSACTION_FEE_PERCENT = 0.0001;
const MAX_TRANSACTION_FEE = 0.01;

/**
 * @param {number} amount
 * @returns {number}
 */
exports.calculateFee = (amount) => {
    const fee = Big(amount).times(TRANSACTION_FEE_PERCENT).toNumber();
    return Math.min(fee, MAX_TRANSACTION_FEE);
};

exports.generateTransaction = (to, amount, keyPair) => {
    const newTransaction = {
        from: keyPair.publicKey.toString('hex'),
        timestamp: Math.round(Date.now() / 1000),
        to,
        amount,
        fee: this.calculateFee(amount),
    };
    newTransaction.hash = cryptoUtilsLib.generateHashFromObjectParams(HASH_PARAMS, newTransaction);
    newTransaction.signature = keyPair
        .sign(Buffer.from(newTransaction.hash, 'hex'))
        .toString('hex');
    return newTransaction;
};

exports.validateHash = (transaction) => {
    const hash = cryptoUtilsLib.generateHashFromObjectParams(HASH_PARAMS, transaction);
    return hash === transaction.hash;
};

exports.validateSignature = (transaction) => {
    return cryptoUtilsLib.verifySignature(
        transaction.hash,
        transaction.signature,
        transaction.from,
    );
};

exports.validateFee = (transaction) => {
    const fee = this.calculateFee(transaction.amount);
    return fee === transaction.fee;
};

/**
 * @param {Transaction} transaction
 * @returns {Promise<boolean>}
 */
exports.validateTransactionBalance = async (transaction) => {
    const balanceRecord = await balanceDao.getBalance(transaction.from);
    const amount = transaction.amount + transaction.fee;

    if (balanceRecord && balanceRecord.balance > amount) return true;

    const { balance, burnedBalance } = await sharedBalanceService.calculateBalace(transaction.from);
    const lastBlockId = await blockDao.getLastBlock();

    if (balanceRecord) {
        await balanceDao.updateBalances(transaction.from, balance, burnedBalance);
    } else {
        await balanceDao.create(transaction.from, balance, burnedBalance, lastBlockId.id);
    }

    return balance > amount;
};

/**
 * @param {Transaction} transaction
 * @returns {Promise<{valid: boolean, error?: string}>}
 */
exports.validateTransaction = async (transaction) => {
    const validHash = this.validateHash(transaction);
    if (!validHash) return { valid: false, error: 'Invalid transaction hash' };

    const validSignature = this.validateSignature(transaction);
    if (!validSignature) return { valid: false, error: 'Invalid transaction signature' };

    const validFee = this.validateFee(transaction);
    if (!validFee) return { valid: false, error: 'Invalid transaction fee' };

    const validSenderBalance = await this.validateTransactionBalance(transaction);
    if (!validSenderBalance) return { valid: false, error: 'Invalid transaction sender balance' };

    return { valid: true };
};

/**
 * @param {Transaction} transactionData
 * @returns {Promise<Transaction>}
 */
exports.newTransaction = async (transactionData) => {
    const databaseTransaction = await sequelize.transaction();
    const existedTransaction = await transactionDao.findOne(
        transactionData.hash,
        databaseTransaction,
    );
    if (existedTransaction) {
        await databaseTransaction.commit();
        throw new Error('Transaction already exists in database');
    }

    const validationCheck = await this.validateTransaction(transactionData);
    if (!validationCheck.valid) {
        await databaseTransaction.commit();
        throw new Error(validationCheck.error);
    }

    const newTransaction = await transactionDao.create(transactionData, databaseTransaction);
    await databaseTransaction.commit();
    return newTransaction;
};

/**
 * @param {Array<Transaction>} transactions
 * @returns {{valid: boolean, error?: string}}
 */
exports.checkDuplicatedSender = (transactions) => {
    const senders = transactions.map((transaction) => transaction.from);
    const hasDuplicates = senders.some((sender, i) => senders.indexOf(sender) !== i);
    return hasDuplicates ? { valid: false, error: 'Possible double spend' } : { valid: true };
};

/**
 * @param {Array<Transaction>} transactions
 * @returns {Promise<{valid: boolean, error?: string}>}
 */
exports.validateTransactions = async (transactions) => {
    const hasDuplicates = this.checkDuplicatedSender(transactions);
    if (!hasDuplicates.valid) return hasDuplicates;

    for (let i = 0; i < transactions.length; i++) {
        const tranasactionCheck = await this.validateTransaction(transactions[i]);
        if (!tranasactionCheck.valid) return tranasactionCheck;
    }
    return { valid: true };
};
