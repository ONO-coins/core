const blockDao = require('../databases/postgres/dao/block.dao');
const blockTransactionDao = require('../databases/postgres/dao/block-transaction.dao');
const blockService = require('./block.service');
const transactionService = require('./transaction.service');
const { BLOCKCHAIN_SETTINGS } = require('../constants/app.constants');
const state = require('../state');
const wallet = require('../wallet');

/**
 * @typedef {import('databases/postgres/models/transaction.model').Transaction} Transaction
 * @typedef {import('databases/postgres/models/block.model').Block} Block
 */

/**
 * @typedef {Block & {transactions: Array<Transaction>}} BlockWithTransactions
 */

/**
 * @param {BlockWithTransactions} block
 * @returns {Promise<{valid: boolean, error?: string}>}
 */
exports.validateBlock = async (block) => {
    const { transactions, ...blockWithoutTransactions } = block;

    const hashValid = blockService.checkBlockHash(block);
    if (!hashValid) return { valid: false, error: `Block ${block.id} has invalid hash.` };

    const signatureValid = blockService.checkBlockSignature(block);
    if (!signatureValid) return { valid: false, error: `Block ${block.id} has invalid signature` };

    const previousHashValid = await blockService.checkBlockPreviousHash(blockWithoutTransactions);
    if (!previousHashValid)
        return { valid: false, error: `Block ${block.id} has invalid previous block hash` };

    const validTarget = await blockService.checkBlockTarget(block);
    if (!validTarget) return { valid: false, error: `Block ${block.id} has invalid target` };

    const transactionsCheck = await transactionService.validateTransactions(transactions);
    if (!transactionsCheck.valid) return transactionsCheck;

    return { valid: true };
};

/**
 *
 * @param {Array<BlockWithTransactions>} chain
 * @returns {{sum: number, count: number}}
 */
exports.calculateTransactionStats = (chain) => {
    const transactionSet = new Set();
    let sum = 0;
    for (let i = 0; i < chain.length; i++) {
        const chainBlockTransactions = chain[i].transactions;
        for (let j = 0; j < chainBlockTransactions.length; j++) {
            const chainBlockTransaction = chainBlockTransactions[j];
            transactionSet.add(chainBlockTransaction.from);
            sum += chainBlockTransaction.amount;
        }
    }
    return { sum, count: transactionSet.size };
};

/**
 * @param {Array<BlockWithTransactions>} chain
 * @returns {Promise<{valid: boolean, error?: string, initialBlockId?: number}>}
 */
exports.validateChain = async (chain) => {
    if (chain.length > BLOCKCHAIN_SETTINGS.SYNCHRONIZATION_BATCH)
        return { valid: false, error: 'Incoming chain is too long' };

    const initialChainHash = chain[0].previousHash;
    const initialBlock = await blockDao.getByHash(initialChainHash);
    if (!initialBlock) return { valid: false, error: 'Immutable block does not found' };

    const immutableBlockId = state.getState(state.KEYS.IMMUTABLE_BLOCK_ID);
    if (initialBlock.id < immutableBlockId)
        return { valid: false, error: 'Cant change immutable blocks' };

    const publicKey = wallet.getDefaultPublicKey();
    const lastBlock = await blockDao.getLastExternalBlock(publicKey);
    const lastChainId = chain[chain.length - 1].id;
    if (lastChainId <= lastBlock.id)
        return { valid: false, error: 'Incoming chain is shorter than ours' };

    const chainTransactionStats = this.calculateTransactionStats(chain);
    const uniqueTransactionsCount =
        await blockTransactionDao.uniqueAddressTransactionCountFromBlockId(initialBlock.id);
    if (uniqueTransactionsCount > chainTransactionStats.count)
        return { valid: false, error: 'Incoming chain has less transaction count' };

    const transactionSum = await blockTransactionDao.transactionSumFromBlockId(initialBlock.id);
    if (transactionSum > chainTransactionStats.sum)
        return { valid: false, error: 'Incoming chain has less transaction sum' };

    return { valid: true, initialBlockId: initialBlock.id };
};

/**
 * @param {BlockWithTransactions} block
 * @returns {Promise<boolean>}
 */
exports.compareBlockTransactionSum = async (block) => {
    const blockTransactionStats = this.calculateTransactionStats([block]);
    const uniqueTransactionsSum = await blockTransactionDao.transactionSumFromBlockId(block.id - 1);
    return uniqueTransactionsSum <= blockTransactionStats.sum;
};
