const factories = require('../helpers/factories');
const keys = require('../helpers/keys');
const { INITIAL_BLOCK } = require('../../constants/app.constants');

/**
 * Builds valid successor blocks whose hit provably beats the ticket, so
 * onBlock's consensus check passes with REAL proof-of-burn math (never mocked).
 *
 * Strategy: give the forger a large confirmed burn, then choose a timestamp far
 * enough past the parent that hit = prevTarget * burned * elapsed exceeds the
 * 9-hex-digit ticket (< 16^9). All other fields are produced honestly by the
 * shared factories, so the block passes every validator in validateBlock.
 */
class ChainBuilder {
    /**
     * @param {ReturnType<import('../helpers/ledger').createLedger>} ledger
     * @param {number} genesisTimestamp
     */
    constructor(ledger, genesisTimestamp) {
        this.ledger = ledger;
        this.parent = {
            id: INITIAL_BLOCK.id,
            hash: INITIAL_BLOCK.hash,
            target: INITIAL_BLOCK.target,
            timestamp: genesisTimestamp,
            generationSignature: INITIAL_BLOCK.generationSignature,
        };
    }

    /**
     * Confirms a burn for `key` inside `blockId` so it counts toward forging
     * weight at that height.
     * @param {import('hdkey')} key
     * @param {number} amount
     * @param {number} blockId
     * @param {number} timestamp
     */
    seedBurn(key, amount, blockId, timestamp) {
        const store = this.ledger.getStore();
        const burn = factories.makeTransaction({
            fromKey: key,
            to: '000000000000000000000000000000000000000000000000000000000000000000',
            amount,
            timestamp,
        });
        store.transactions.set(burn.hash, burn);
        store.blockTransactions.push({
            id: store.nextBlockTransactionId++,
            transactionHash: burn.hash,
            blockId,
        });
        return burn;
    }

    /**
     * Produces (but does not persist) a valid block on top of the current
     * parent. Elapsed time is chosen so the hit beats any ticket.
     * @param {Object} [opts]
     * @param {import('hdkey')} [opts.forgerKey]
     * @param {Array<Object>} [opts.transactions]
     * @param {number} [opts.elapsed]
     * @returns {Object}
     */
    makeNext({ forgerKey = keys.forger, transactions = [], elapsed = 604_800 } = {}) {
        return factories.makeBlock({
            parent: this.parent,
            forgerKey,
            timestamp: this.parent.timestamp + elapsed,
            transactions,
        });
    }

    /**
     * Advances the builder's notion of the canonical tip to `block` (call after
     * a block is accepted, so the next block builds on it).
     * @param {Object} block
     */
    advanceTo(block) {
        this.parent = {
            id: block.id,
            hash: block.hash,
            target: block.target,
            timestamp: block.timestamp,
            generationSignature: block.generationSignature,
        };
    }
}

module.exports = { ChainBuilder };
