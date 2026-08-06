const Big = require('big.js');
const cryptoUtilsLib = require('../../lib/crypto-utils.lib');
const { BLOCKCHAIN_SETTINGS, HASH_PARAMS } = require('../../constants/app.constants');

/**
 * Independent protocol construction for tests.
 *
 * These factories deliberately re-implement transaction/block assembly using
 * only the crypto primitives (not the services), for two reasons:
 *  1. The services require the DAO layer at require time, which needs either a
 *     live database or module mocks — factories must be loadable everywhere.
 *  2. It gives the suite an INDEPENDENT implementation to compare against the
 *     production one (see the "independent implementation" tests): if either
 *     side drifts, the comparison test fails.
 *
 * All signing goes through the real hdkey/secp256k1 path (RFC6979,
 * deterministic, low-S), so signatures produced here are honest protocol
 * signatures — no protocol logic is mocked.
 *
 * @typedef {import('hdkey')} HDNode
 */

const TRANSACTION_HASH_PARAMS = ['from', 'to', 'timestamp', 'amount'];
const TRANSACTION_FEE_PERCENT = '0.0001';
const MAX_TRANSACTION_FEE = 0.01;

/**
 * Independent fee computation (decimal-exact via big.js, capped).
 * @param {number} amount
 * @returns {number}
 */
function expectedFee(amount) {
    const fee = new Big(amount).times(TRANSACTION_FEE_PERCENT).toNumber();
    return Math.min(fee, MAX_TRANSACTION_FEE);
}

/**
 * Builds a fully valid, honestly signed transaction.
 * @param {Object} opts
 * @param {HDNode} opts.fromKey
 * @param {string} opts.to 66-char pubkey hex
 * @param {number} opts.amount
 * @param {number} opts.timestamp seconds
 * @param {number} [opts.fee] override to build an invalid-fee transaction
 * @returns {{from: string, to: string, amount: number, fee: number, timestamp: number, hash: string, signature: string}}
 */
function makeTransaction({ fromKey, to, amount, timestamp, fee }) {
    const transaction = {
        from: fromKey.publicKey.toString('hex'),
        to,
        timestamp,
        amount,
        fee: fee ?? expectedFee(amount),
    };
    transaction.hash = cryptoUtilsLib.generateDomainHash(
        'transaction',
        TRANSACTION_HASH_PARAMS,
        transaction,
    );
    transaction.signature = fromKey.sign(Buffer.from(transaction.hash, 'hex')).toString('hex');
    return transaction;
}

/**
 * Independent re-implementation of the retargeting rule:
 * candidate = floor(parentTarget * elapsed / 10), clamped to
 * [max(parent/2, MIN_TARGET), min(2*parent, MAX_TARGET)].
 * @param {{target: number, timestamp: number}} parent
 * @param {number} timestamp
 * @returns {number}
 */
function expectedTarget(parent, timestamp) {
    const maxTarget = Math.min(2 * parent.target, BLOCKCHAIN_SETTINGS.MAX_TARGET);
    const minTarget = Math.max(Math.floor(parent.target / 2), BLOCKCHAIN_SETTINGS.MIN_TARGET);
    const elapsed = timestamp - parent.timestamp;
    const candidate = Math.floor(
        (parent.target * elapsed) / BLOCKCHAIN_SETTINGS.BLOCK_AVERAGE_TIME_SECONDS,
    );
    return Math.min(Math.max(minTarget, candidate), maxTarget);
}

/**
 * Independent block hash: sorted transaction hashes joined by ',' then the
 * domain hash over HASH_PARAMS.
 * @param {Object} block
 * @returns {string}
 */
function blockHash(block) {
    const transactionsHashString = block.transactions
        .map((transaction) => transaction.hash)
        .toSorted()
        .join(',');
    return cryptoUtilsLib.generateDomainHash('block', HASH_PARAMS, {
        ...block,
        transactionsHashString,
    });
}

/**
 * Builds a fully valid, honestly signed block on top of `parent`.
 * Any field can be overridden AFTER hashing/signing via `tamper`, or BEFORE via
 * explicit opts (to build blocks that are internally consistent but wrong).
 * @param {Object} opts
 * @param {Object} opts.parent parent block (id, hash, target, timestamp, generationSignature)
 * @param {HDNode} opts.forgerKey
 * @param {number} opts.timestamp
 * @param {Array<Object>} [opts.transactions]
 * @param {number} [opts.target] override (default: correct retarget)
 * @param {string} [opts.generationSignature] override (default: correct)
 * @param {string} [opts.previousHash] override (default: parent.hash)
 * @param {number} [opts.id] override (default: parent.id + 1)
 * @returns {Object} block with transactions attached
 */
function makeBlock({
    parent,
    forgerKey,
    timestamp,
    transactions = [],
    target,
    generationSignature,
    previousHash,
    id,
}) {
    const publicKey = forgerKey.publicKey.toString('hex');
    const block = {
        id: id ?? parent.id + 1,
        previousHash: previousHash ?? parent.hash,
        publicKey,
        timestamp,
        target: target ?? expectedTarget(parent, timestamp),
        generationSignature:
            generationSignature ??
            cryptoUtilsLib.generateDomainHash('generation', ['previous', 'publicKey'], {
                previous: parent.generationSignature,
                publicKey,
            }),
        transactions,
    };
    block.hash = blockHash(block);
    block.signature = forgerKey.sign(Buffer.from(block.hash, 'hex')).toString('hex');
    return block;
}

module.exports = {
    TRANSACTION_HASH_PARAMS,
    MAX_TRANSACTION_FEE,
    expectedFee,
    expectedTarget,
    blockHash,
    makeTransaction,
    makeBlock,
};
