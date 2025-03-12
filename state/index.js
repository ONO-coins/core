const { v4: uuidv4 } = require('uuid');
const { BLOCKCHAIN_SETTINGS } = require('../constants/app.constants');

/**
 * @typedef {Object} BlockStats
 * @property {number} invalidBlocksRov
 * @property {number} avarageInvalidDelay
 * @property {number} avarageInvalidTarget
 * @property {Date} lastBlockTime
 */

class State {
    #forging;
    #syncing;
    #synchronized;
    #immutableBlockId;
    #blockStats;
    #chainProcessing;
    #id;

    constructor() {
        this.#forging = process.env.FORGING === 'true';
        this.#syncing = false;
        this.#synchronized = false;
        this.#chainProcessing = false;
        this.#id = uuidv4();
        this.#initBlockStats();
    }

    #initBlockStats() {
        this.#blockStats = {
            invalidBlocksRov: 0,
            avarageInvalidDelay: 0,
            avarageInvalidTarget: 0,
            lastBlockTime: new Date(),
            highest: 0,
            timeout: this.#blockStatsTimeout(),
        };
    }

    #blockStatsTimeout() {
        return setTimeout(() => this.#initBlockStats(), 60000);
    }

    /**
     * @param {number} blockTarget
     * @param {number} blockId
     */
    invalidBlock(blockTarget, blockId) {
        if (this.#blockStats.highest) {
            if (blockId - this.#blockStats.highest !== 1) return;
            clearTimeout(this.#blockStats.timeout);
            this.#blockStats.highest++;
            this.#blockStats.timeout = this.#blockStatsTimeout();
        } else {
            this.#blockStats.highest = blockId;
        }

        this.#blockStats.invalidBlocksRov += 1;
        const delay = new Date().getTime() - this.#blockStats.lastBlockTime.getTime();

        this.#blockStats.avarageInvalidDelay =
            (this.#blockStats.avarageInvalidDelay *
                (BLOCKCHAIN_SETTINGS.INVALID_BLOCKS_COUNT_TRESHOLD - 1) +
                delay) /
            BLOCKCHAIN_SETTINGS.INVALID_BLOCKS_COUNT_TRESHOLD;

        this.#blockStats.avarageInvalidTarget =
            (this.#blockStats.avarageInvalidTarget *
                (BLOCKCHAIN_SETTINGS.INVALID_BLOCKS_COUNT_TRESHOLD - 1) +
                blockTarget) /
            BLOCKCHAIN_SETTINGS.INVALID_BLOCKS_COUNT_TRESHOLD;

        this.#blockStats.lastBlockTime = new Date();
    }

    /**
     * @param {number} id
     */
    validBlock(id) {
        this.#blockStats.invalidBlocksRov = 0;
        this.#immutableBlockId = Math.max(id - BLOCKCHAIN_SETTINGS.MAX_MUTABLE_BLOCK_COUNT, 0);
    }

    /**
     * @returns {BlockStats}
     */
    invalidBlockStats() {
        return this.#blockStats;
    }

    isForging() {
        return this.#forging;
    }

    startForging() {
        this.#forging = process.env.FORGING === 'true';
    }

    stopForging() {
        this.#forging = false;
    }

    isSyncing() {
        return this.#syncing;
    }

    startSync() {
        this.#syncing = true;
        this.#synchronized = false;
        this.#forging = false;
    }

    stopSync() {
        this.#syncing = false;
    }

    isSynchronized() {
        return this.#synchronized;
    }

    setSynchronized() {
        this.#synchronized = true;
    }

    /**
     * @param {number} id
     */
    setImmutableBlockId(id) {
        this.#immutableBlockId = Math.max(0, id);
    }

    getImmutableBlockId() {
        return this.#immutableBlockId;
    }

    chainProcessing() {
        return this.#chainProcessing;
    }

    stopChainProcessing() {
        this.#chainProcessing = false;
    }

    startChainProcessing() {
        this.#chainProcessing = true;
    }

    id() {
        return this.#id;
    }
}

module.exports = new State();
