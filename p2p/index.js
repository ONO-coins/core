const p2pServer = require('./p2p-server');
const p2pClient = require('./p2p-client');
const p2pValidator = require('./p2p-validator');
const blockController = require('./controllers/block.controller');
const { logger } = require('../managers/log.manager');
const { STATUS_BROADCAST_INTERVAL } = require('../constants/p2p.constants');

/**
 * @returns {void}
 */
exports.init = () => {
    p2pValidator.init();
    p2pServer.init();
    p2pClient.init();

    // Periodically advertise our chain tip so peers continuously reconcile and a
    // node that drifted behind catches up without waiting for a stray block (S6).
    setInterval(() => {
        blockController.broadcastStatus().catch((error) => logger.warn(`Status broadcast: ${error}`));
    }, STATUS_BROADCAST_INTERVAL);
};
