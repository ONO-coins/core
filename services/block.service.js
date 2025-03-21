const state = require('../state');
const blockDao = require('../databases/postgres/dao/block.dao');
const transactionDao = require('../databases/postgres/dao/transaction.dao');
const blockTransactionDao = require('../databases/postgres/dao/block-transaction.dao');
const balanceDao = require('../databases/postgres/dao/balance.dao');
const cryptoUtilsLib = require('../lib/crypto-utils.lib');
const wallet = require('../wallet');
const { SyncError } = require('../constructors/error.constructor');
const {
    BLOCKCHAIN_SETTINGS,
    INITIAL_BLOCK,
    INITIAL_TRANSACTIONS,
    INITIAL_TRANSACTIONS_TESTNET,
    HASH_PARAMS,
    BLOCK_ID_ACTIONS,
} = require('../constants/app.constants');

/**
 * @typedef {import('databases/postgres/models/transaction.model').Transaction} Transaction
 * @typedef {import('databases/postgres/models/block.model').Block} Block
 * @typedef {import('services/block-transaction.servise').BlockWithTransactions} BlockWithTransactions
 * @typedef {import('hdkey')} HDNode
 * @typedef {import('state').BlockStats} BlockStats
 */

/**
 * @param {Object} block
 * @param {number} block.id
 * @param {string} block.publicKey
 * @param {number} block.timestamp
 * @param {number} block.target
 * @param {Array<Transaction>} block.transactions
 * @returns {string}
 */
exports.generateHash = (block) => {
    const transactionHashes = block.transactions.map((transaction) => transaction.hash).toSorted();
    const transactionsHashString = transactionHashes.join('');
    const hash = cryptoUtilsLib.generateHashFromObjectParams(HASH_PARAMS, {
        ...block,
        transactionsHashString,
    });
    return hash;
};

/**
 * @param {Object} block
 * @param {number} block.id
 * @param {string} block.publicKey
 * @param {number} block.timestamp
 * @param {number} block.target
 * @param {string} block.hash
 * @param {Array<Transaction>} block.transactions
 * @param {HDNode} keyPair
 * @returns {string}
 */
exports.generateSignature = (block, keyPair) => {
    return keyPair.sign(Buffer.from(block.hash, 'hex')).toString('hex');
};

/**
 * @param {Block} lastBlock
 * @param {number} timestamp
 * @returns {number}
 */
exports.createBlockTarget = (lastBlock, timestamp) => {
    const maxTarget = Math.min(2 * lastBlock.target, BLOCKCHAIN_SETTINGS.MAX_TARGET);
    const minTarget = Math.max(Math.floor(lastBlock.target / 2), BLOCKCHAIN_SETTINGS.MIN_TARGET);
    const elapsedTime = timestamp - lastBlock.timestamp;
    const candidate = Math.floor(
        (lastBlock.target * elapsedTime) / BLOCKCHAIN_SETTINGS.BLOCK_AVERAGE_TIME_SECONDS,
    );
    const target = Math.min(Math.max(minTarget, candidate), maxTarget);
    return target;
};

/**
 * @param {Block} lastBlock
 * @param {string} publicKey
 * @param {number} timestamp
 * @param {Array<Transaction>} transactions
 * @param {HDNode} keyPair
 * @returns {BlockWithTransactions}
 */
exports.generateBlock = (lastBlock, publicKey, timestamp, transactions, keyPair) => {
    const newBlock = {
        id: lastBlock.id + 1,
        previousHash: lastBlock.hash,
        publicKey: publicKey,
        timestamp: timestamp,
        target: this.createBlockTarget(lastBlock, timestamp),
        transactions,
    };
    newBlock.hash = this.generateHash(newBlock);
    // @ts-ignore
    newBlock.signature = this.generateSignature(newBlock, keyPair);
    // @ts-ignore
    return newBlock;
};

/**
 * @returns {Promise<void>}
 */
exports.init = async () => {
    const lastBlock = await blockDao.getLastBlock();
    if (lastBlock) {
        const immutableBlockId = await this.getImmutableBlockId();
        state.setImmutableBlockId(immutableBlockId);
        return;
    }

    const initialTransaction =
        process.env.TESTNET === 'true' ? INITIAL_TRANSACTIONS_TESTNET : INITIAL_TRANSACTIONS;

    await blockDao.create(INITIAL_BLOCK);
    await transactionDao.bulkCreate(initialTransaction);

    const transactionHashes = initialTransaction.map((transaction) => transaction.hash);
    await blockTransactionDao.bulkCreate(transactionHashes, INITIAL_BLOCK.id);

    for (let i = 0; i < initialTransaction.length; i++) {
        const transaction = initialTransaction[i];
        await balanceDao.create(transaction.to, transaction.amount, 0, INITIAL_BLOCK.id);
        if (transaction.to === BLOCKCHAIN_SETTINGS.BURN_ADDRESS) {
            const amount = -transaction.amount - transaction.fee;
            await balanceDao.changeBalance(
                transaction.from,
                amount,
                transaction.amount,
                INITIAL_BLOCK.id,
            );
        }
    }

    state.setImmutableBlockId(INITIAL_BLOCK.id);
};

/**
 * @param {Block} newBlock
 * @returns {Promise<string>}
 */
exports.checkNewBlockId = async (newBlock) => {
    const lastBlock = await blockDao.getLastBlock();
    if (lastBlock.id === newBlock.id) return BLOCK_ID_ACTIONS.NEED_REPLACE;
    if (lastBlock.id > newBlock.id) {
        if (newBlock.target < lastBlock.target)
            throw new SyncError(`Block is more difficult. Try to sync`);
        throw new Error(`Block already exists.`);
    }
    const lag = newBlock.id - lastBlock.id;
    if (lag > 1) throw new SyncError(`Block is too far away. Need sync.`);
    return BLOCK_ID_ACTIONS.NO_ACTION_NEED;
};

/**
 * @returns {Promise<number>}
 */
exports.getImmutableBlockId = async () => {
    const publicKey = wallet.getDefaultPublicKey();
    const lastBlock = await blockDao.getLastExternalBlock(publicKey);
    return Math.max(0, lastBlock.id - BLOCKCHAIN_SETTINGS.MAX_MUTABLE_BLOCK_COUNT);
};

/**
 * @param {BlockWithTransactions} block
 * @returns {boolean}
 */
exports.checkBlockHash = (block) => {
    const hash = this.generateHash(block);
    return hash === block.hash;
};

/**
 * @param {Block} block
 * @returns {Promise<boolean>}
 */
exports.checkBlockPreviousHash = async (block) => {
    const previousBlock = await blockDao.getById(block.id - 1);
    return block.previousHash === previousBlock?.hash;
};

/**
 * @param {BlockWithTransactions} block
 * @returns {boolean}
 */
exports.checkBlockSignature = (block) => {
    return cryptoUtilsLib.verifySignature(block.hash, block.signature, block.publicKey);
};
