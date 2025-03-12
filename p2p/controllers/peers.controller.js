const p2pSockets = require('../p2p-sockets');
const p2pActions = require('../p2p-actions');
const p2pClient = require('../p2p-client');
const peerService = require('../../services/peer.service');
const { logger } = require('../../managers/log.manager');

/**
 * @typedef {import('ws')} WebSocket
 */

/**
 * @param {{number: number}} peerRequest
 * @param {WebSocket} socket
 */
exports.sharePeers = async (peerRequest, socket) => {
    const peers = await peerService.getPeers(peerRequest.number);
    if (!peers.length) return;
    p2pActions.sendPeers(socket, peers);
};

/**
 * @param {Array<string>} peers
 * @returns {void}
 */
exports.onPeers = (peers) => {
    p2pClient.connectToPears(peers);
};

/**
 * @param {{peer: string}} data
 * @param {string} [sernderKey]
 * @returns {Promise<void>}
 */
exports.onGossip = async (data, sernderKey) => {
    const existed = await peerService.checkAddress(data.peer);
    if (existed) return;

    p2pClient.connectToPear(data.peer, true);
    p2pActions.broadcastPeer(data.peer, [sernderKey]);
};

/**
 * @param {{id: string}} data
 * @param {WebSocket} socket
 * @returns {void}
 */
exports.onId = (data, socket) => {
    if (p2pSockets.checkId(data.id)) {
        logger.info(`Peer ${data.id} is already connected. Preventing double connection...`);
        socket.close();
    }
};
