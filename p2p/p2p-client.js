const WebSocket = require('ws');
const utilsLib = require('../lib/utils.lib');
const p2pSockets = require('./p2p-sockets');
const p2pHandlers = require('./p2p-handlers');
const p2pActions = require('./p2p-actions');
const peerService = require('../services/peer.service');
const state = require('../state');
const { logger } = require('../managers/log.manager');
const {
    AVERAGE_PEERS_COUNT,
    NODE_ID_HEADER,
    MIN_PEERS_COUNT,
    DEFAULT_PEERS_RECONNECTION_TIMEOUT,
    SELF_CONNECTION_ERROR_CODE,
} = require('../constants/p2p.constants');

let reconnectTimeout = null;

exports.reconnect = async () => {
    const peers = await peerService.getPeers(AVERAGE_PEERS_COUNT);
    this.connectToPears(peers);
};

/**
 * @param {string} address
 * @param {boolean} [gossip]
 * @returns {void}
 */
exports.connectToPear = (address, gossip) => {
    const sockets = p2pSockets.getSockets();
    const peer = utilsLib.toWsAddress(address);
    if (sockets.has(peer)) {
        logger.info(`We are already connected to ${peer}, preventing double connection.`);
        return;
    }

    const socket = new WebSocket(peer, {
        headers: {
            [NODE_ID_HEADER]: state.id(),
        },
    });
    sockets.set(peer, socket);

    socket.on('open', () => {
        // @ts-ignore
        p2pHandlers.socketConnected(socket, peer, false);
        if (gossip) p2pActions.broadcastPeer(address);
    });
    socket.on('error', (error) => {
        logger.warn(`Connection problems with peer ${peer}`);
        sockets.delete(peer);
    });
    socket.on('close', (code) => {
        if (code !== SELF_CONNECTION_ERROR_CODE) sockets.delete(peer);
        p2pHandlers.socketDisconnected(socket, peer);
        if (sockets.size < MIN_PEERS_COUNT) {
            if (reconnectTimeout) clearTimeout(reconnectTimeout);
            reconnectTimeout = setTimeout(this.reconnect, DEFAULT_PEERS_RECONNECTION_TIMEOUT);
        }
    });
};

/**
 * @param {Array<string>} peers
 * @returns {void}
 */
exports.connectToPears = (peers) => {
    const sockets = p2pSockets.getSockets();
    if (Array.isArray(peers)) {
        peers.forEach((peer) => {
            for (const socket of sockets.values()) {
                if (socket.url === peer) return;
            }
            this.connectToPear(peer);
        });
    } else {
        this.connectToPear(peers);
    }
};

/**
 * @returns {void}
 */
exports.init = () => {
    if (!process.env.DEFAULT_PEERS) return;
    try {
        const defaultPeers = JSON.parse(process.env.DEFAULT_PEERS);
        this.connectToPears(defaultPeers);
    } catch (error) {
        logger.error(error);
    }
};
