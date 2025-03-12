const p2pServer = require('./p2p-server');
const p2pClient = require('./p2p-client');
const p2pValidator = require('./p2p-validator');

/**
 * @returns {void}
 */
exports.init = () => {
    p2pValidator.init();
    p2pServer.init();
    p2pClient.init();
};
