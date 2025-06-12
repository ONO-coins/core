const p2pSockets = require('./p2p-sockets');
const p2pRouter = require('./p2p-router');
const p2pActions = require('./p2p-actions');
const peerService = require('../services/peer.service');
const state = require('../state');
const { logger } = require('../managers/log.manager');

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
        const nodeId = state.getState(state.KEYS.NODE_ID);
        p2pActions.sendId(socket, nodeId);
    } else {
        await peerService.clientConnection(socketKey);
    }
};

/**
 * @param {WebSocket} socket
 * @param {string} socketKey
 * @returns {Promise<void>}
 */
exports.socketDisconnected = async (socket, socketKey) => {
    const disconnectionTime = new Date();
    p2pSockets.delete(socketKey);
    const sockets = p2pSockets.getSockets();
    logger.info(`Socket ${socketKey} closed, Connections count: ${sockets.size}`);
    await peerService.disconnect(socketKey, disconnectionTime);
};
