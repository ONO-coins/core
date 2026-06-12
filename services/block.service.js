const Big = require('big.js');
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
 * @typedef {import('services/block-transaction.service').BlockWithTransactions} BlockWithTransactions
 * @typedef {import('hdkey')} HDNode
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
    const transactionsHashString = transactionHashes.join(',');
    const hash = cryptoUtilsLib.generateDomainHash('block', HASH_PARAMS, {
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
 * Deterministic, non-grindable forging seed: each block's generation signature is
 * derived only from its parent's generation signature and the forger's (fixed)
 * public key. Because the forger contributes nothing it can vary, it cannot grind
 * the value to bias who forges next — unlike the old scheme that seeded the lottery
 * from the previous block's freely-chosen ECDSA signature (crypto review).
 * @param {string} previousGenerationSignature
 * @param {string} publicKey
 * @returns {string}
 */
exports.generateGenerationSignature = (previousGenerationSignature, publicKey) => {
    return cryptoUtilsLib.generateDomainHash('generation', ['previous', 'publicKey'], {
        previous: previousGenerationSignature,
        publicKey,
    });
};

/**
 * Per-block chain work. A lower target is harder to forge, so it must contribute
 * more weight; MAX_TARGET / target makes the easiest block (target = MAX_TARGET)
 * worth ~1. Used to choose the canonical chain by cumulative work (review S3).
 * @param {number} target
 * @returns {Big}
 */
exports.blockDifficulty = (target) => {
    const value = Number(target);
    // A malicious chain could carry an out-of-range target; treat it as zero work
    // (so it can never out-weigh an honest chain) rather than dividing by zero.
    // Per-block validation (checkBlockTarget) rejects the block regardless.
    if (!Number.isFinite(value) || value < BLOCKCHAIN_SETTINGS.MIN_TARGET) return new Big(0);
    return new Big(BLOCKCHAIN_SETTINGS.MAX_TARGET).div(value);
};

/**
 * Total chain work of a list of blocks (e.g. the contested suffix since a common
 * ancestor). Forks only differ inside the mutable window, so this is always a
 * short list and never needs a stored cumulative column.
 * @param {Array<{target: number}>} blocks
 * @returns {Big}
 */
exports.cumulativeDifficulty = (blocks) => {
    return blocks.reduce((sum, block) => sum.plus(this.blockDifficulty(block.target)), new Big(0));
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
        generationSignature: this.generateGenerationSignature(
            lastBlock.generationSignature,
            publicKey,
        ),
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
        this.setImmutableBlockId(immutableBlockId);
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
            const amount = new Big(0).minus(transaction.amount).minus(transaction.fee).toNumber();
            await balanceDao.changeBalance(
                transaction.from,
                amount,
                transaction.amount,
                INITIAL_BLOCK.id,
            );
        }
    }

    this.setImmutableBlockId(INITIAL_BLOCK.id);
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
 * @param {Block} newBlock
 * @returns {boolean}
 */
exports.checkNewBlockTimings = (newBlock) => {
    const currentTimestamp = Math.round(Date.now() / 1000);
    if (currentTimestamp < newBlock.timestamp - BLOCKCHAIN_SETTINGS.MAX_TIMESTAMP_DIFF)
        return false;

    return true;
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
 * @param {number} id
 */
exports.setImmutableBlockId = async (id) => {
    const immutableBlockId = Math.max(0, id);
    state.setState(state.KEYS.IMMUTABLE_BLOCK_ID, immutableBlockId);
};

/**
 * A block must advance time past its parent. Without this, a forger can backdate
 * or stretch `elapsedTime` to inflate its hit and always win fork resolution
 * (review S4). Forging is only possible when elapsedTime > 0, so honest blocks
 * always satisfy this.
 * @param {Block} block
 * @returns {Promise<boolean>}
 */
exports.checkBlockTimestamp = async (block) => {
    const previousBlock = await blockDao.getById(block.id - 1);
    if (!previousBlock) return false;
    return block.timestamp > previousBlock.timestamp;
};

/**
 * @param {BlockWithTransactions} block
 * @returns {Promise<boolean>}
 */
exports.checkBlockTarget = async (block) => {
    const previousBlock = await blockDao.getById(block.id - 1);
    const target = this.createBlockTarget(previousBlock, block.timestamp);
    return target === block.target;
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

/**
 * The generation signature is fully determined by the parent's generation signature
 * and the forger's public key, so we recompute and compare rather than trusting the
 * field — this is what makes the forging seed unforgeable and non-grindable.
 * @param {Block} block
 * @returns {Promise<boolean>}
 */
exports.checkBlockGenerationSignature = async (block) => {
    const previousBlock = await blockDao.getById(block.id - 1);
    if (!previousBlock) return false;
    const expected = this.generateGenerationSignature(
        previousBlock.generationSignature,
        block.publicKey,
    );
    return block.generationSignature === expected;
};
