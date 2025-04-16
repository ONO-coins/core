const p2pActions = require('../p2p-actions');

/**
 * @typedef {import('ws')} WebSocket
 */

/**
 * @param {WebSocket} socket
 */
exports.onPing = async (socket) => {
    p2pActions.sendPong(socket);
};
