const { v4: uuidv4 } = require('uuid');

const stateStorage = {};

exports.KEYS = {
    FORGING: 'forging',
    SYNCING: 'syncing',
    PROCESSING_BLOCK_ID: 'processingBlockId',
    LAST_VALID_EXTERNAL_BLOCK_DATE: 'lastValidExternalBlockDate',
    IMMUTABLE_BLOCK_ID: 'immutableBlockId',
    NODE_ID: 'nodeId',
};

/**
 * @param {string} key
 * @param {any} value
 */
exports.setState = (key, value) => {
    stateStorage[key] = value;
};

/**
 * @param {string} key
 * @returns {any}
 */
exports.getState = (key) => {
    return stateStorage[key];
};

exports.init = () => {
    stateStorage[this.KEYS.NODE_ID] = uuidv4();
    stateStorage[this.KEYS.FORGING] = process.env.FORGING === 'true';
    stateStorage[this.KEYS.SYNCING] = false;
    stateStorage[this.KEYS.LAST_VALID_EXTERNAL_BLOCK_DATE] = new Date();
    stateStorage[this.KEYS.IMMUTABLE_BLOCK_ID] = 0;
};
