const p2pSockets = require('./p2p-sockets');
const p2pRouter = require('./p2p-router');
const p2pActions = require('./p2p-actions');
const peerService = require('../services/peer.service');
const state = require('../state');
const { logger } = require('../managers/log.manager');
const { NETWORK_LAG } = require('../constants/p2p.constants');

/**
 * @typedef {import('ws').WebSocket} WebSocket
 * @typedef {WebSocket & { _socket: import('net').Socket }} WebSocketWithSocket
 */

/**
 * @param {WebSocketWithSocket} socket
 * @param {string} socketKey
 * @param {boolean} [serverConnection]
 * @returns {Promise<void>}
 */
exports.socketConnected = async (socket, socketKey, serverConnection) => {
    const sockets = p2pSockets.getSockets();
    logger.info(`Socket ${socketKey} connected, current connections count: ${sockets.size}`);
    p2pRouter.messageHandler(socket, socketKey);
    p2pActions.askForPeers(socket);
    if (serverConnection) {
        await peerService.serverConnection(socketKey);
        p2pActions.sendId(socket, state.id());
    } else {
        await peerService.clientConnection(socketKey);
    }
};

/**
 * @param {WebSocket} socket
 * @param {string} socketKey
 * @returns {void}
 */
exports.socketDisconnected = (socket, socketKey) => {
    const disconnectionTime = new Date();
    const sockets = p2pSockets.getSockets();
    logger.info(`Socket ${socketKey} closed, Connections count: ${sockets.size}`);
    setTimeout(async () => {
        await peerService.disconnect(socketKey, disconnectionTime);
    }, NETWORK_LAG);
};
