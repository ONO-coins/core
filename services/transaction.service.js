const Big = require('big.js');
const cryptoUtilsLib = require('../lib/crypto-utils.lib');
const transactionDao = require('../databases/postgres/dao/transaction.dao');
const balanceDao = require('../databases/postgres/dao/balance.dao');
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
    newTransaction.hash = cryptoUtilsLib.generateDomainHash(
        'transaction',
        HASH_PARAMS,
        newTransaction,
    );
    newTransaction.signature = keyPair
        .sign(Buffer.from(newTransaction.hash, 'hex'))
        .toString('hex');
    return newTransaction;
};

exports.validateHash = (transaction) => {
    const hash = cryptoUtilsLib.generateDomainHash('transaction', HASH_PARAMS, transaction);
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
 * Guards against non-positive amounts and negative fees. Without this a signed
 * transaction with a negative amount flips the balance signs in
 * balance.service.updateByTransaction, letting the sender credit themselves and
 * debit the recipient (see security review C1).
 * @param {Transaction} transaction
 * @returns {{valid: boolean, error?: string}}
 */
exports.validateAmount = (transaction) => {
    let amount;
    let fee;
    try {
        amount = new Big(transaction.amount);
        fee = new Big(transaction.fee);
    } catch (error) {
        return { valid: false, error: 'Invalid transaction amount or fee' };
    }
    if (amount.lte(0)) return { valid: false, error: 'Transaction amount must be positive' };
    if (fee.lt(0)) return { valid: false, error: 'Transaction fee must not be negative' };
    return { valid: true };
};

/**
 * Pure read: validation must not mutate state. The previous version wrote the
 * balance cache here, which ran during block validation (outside the block's
 * atomic transaction) and could throw a spurious unique-constraint error when two
 * validations raced to create the same row (review M4). Uses `>=` so a sender can
 * spend its entire balance, and big.js to avoid float comparison drift.
 * @param {Transaction} transaction
 * @returns {Promise<boolean>}
 */
exports.validateTransactionBalance = async (transaction) => {
    const required = new Big(transaction.amount).plus(transaction.fee);

    const balanceRecord = await balanceDao.getBalance(transaction.from);
    if (balanceRecord) return new Big(balanceRecord.balance).gte(required);

    // No cache row (e.g. flushed by a reorg): fall back to the authoritative
    // on-chain balance instead of assuming zero.
    const { balance } = await sharedBalanceService.calculateBalance(transaction.from);
    return new Big(balance).gte(required);
};

/**
 * @param {Transaction} transaction
 * @returns {Promise<{valid: boolean, error?: string}>}
 */
exports.validateTransaction = async (transaction) => {
    const validAmount = this.validateAmount(transaction);
    if (!validAmount.valid) return validAmount;

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
        const transactionCheck = await this.validateTransaction(transactions[i]);
        if (!transactionCheck.valid) return transactionCheck;
    }
    return { valid: true };
};
