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
    #externalBlockDate;
    #chainProcessing;
    #id;
    #processingBlock;

    constructor() {
        this.#forging = process.env.FORGING === 'true';
        this.#syncing = false;
        this.#synchronized = false;
        this.#chainProcessing = false;
        this.#id = uuidv4();
        this.#externalBlockDate = new Date();
    }

    validBlock() {
        this.#externalBlockDate = new Date();
    }

    lastValidBlockDate() {
        return this.#externalBlockDate;
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

    /**
     * @param {number} id
     */
    setProcessindBlock(id) {
        this.#processingBlock = id;
    }

    getProcessindBlock() {
        return this.#processingBlock;
    }
}

module.exports = new State();
