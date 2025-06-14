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
    BLOCK_LAG_FOR_RECONNECT,
    NODE_ID_HEADER,
    DEFAULT_PEERS_RECONNECTION_TIMEOUT,
    SELF_CONNECTION_ERROR_CODE,
} = require('../constants/p2p.constants');

/**
 * @returns {boolean}
 */
exports.needReconnect = () => {
    const defaultPeers = JSON.parse(process.env.DEFAULT_PEERS);
    if (!defaultPeers.length) return false;

    const wsAddresses = defaultPeers.map((address) => utilsLib.toWsAddress(address));
    const connectedServers = p2pSockets.getServerKeys();
    const isConnectedToDefaultServer = connectedServers.some((server) =>
        wsAddresses.includes(server),
    );
    if (isConnectedToDefaultServer) return false;

    const lastValidBlockDate = state.getState(state.KEYS.LAST_VALID_EXTERNAL_BLOCK_DATE);
    const now = new Date();
    const dif = now.getTime() - lastValidBlockDate.getTime();
    if (dif < BLOCK_LAG_FOR_RECONNECT) return false;

    return true;
};

exports.reconnect = async () => {
    const needReconnect = this.needReconnect();
    if (!needReconnect) return;

    logger.debug(`Reconnecting to peers. current size: ${p2pSockets.getSize()}`);
    const databasePeers = await peerService.getPeers(AVERAGE_PEERS_COUNT);
    const filteredDatabasePeers = utilsLib.filterLocalUrls(databasePeers);
    const defaultPeers = JSON.parse(process.env.DEFAULT_PEERS);
    const peers = [...new Set([...filteredDatabasePeers, ...defaultPeers])];
    this.connectToPears(peers);
};

setInterval(this.reconnect, DEFAULT_PEERS_RECONNECTION_TIMEOUT);

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
            [NODE_ID_HEADER]: state.getState(state.KEYS.NODE_ID),
        },
    });
    sockets.set(peer, socket);

    let pingInterval;

    socket.on('open', () => {
        // @ts-ignore
        p2pHandlers.socketConnected(socket, peer, false);
        if (gossip) p2pActions.broadcastPeer(address);
        pingInterval = setInterval(() => {
            socket.ping();
        }, 30000);
    });
    socket.on('error', (error) => {
        logger.warn(`Connection problems with peer ${peer}`);
        sockets.delete(peer);
    });
    socket.on('close', async () => {
        clearInterval(pingInterval);
        await p2pHandlers.socketDisconnected(socket, peer);
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
