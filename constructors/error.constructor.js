/**
 * @enum {string}
 */
const ERROR_TYPES = {
    SYNC_ERROR: 'SyncError',
};

class SyncError extends Error {
    /**
     * @param {string} message
     */
    constructor(message) {
        super(message);
        this.errorType = ERROR_TYPES.SYNC_ERROR;
    }
}

module.exports = {
    ERROR_TYPES,
    SyncError,
};
