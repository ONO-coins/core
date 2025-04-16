const p2pSockets = require('./p2p-sockets');
const { P2P_MESSAGE_TYPES, AVERAGE_PEERS_COUNT } = require('../constants/p2p.constants');

/**
 * @typedef {import('databases/postgres/models/transaction.model').Transaction} Transaction
 * @typedef {import('databases/postgres/models/block.model').Block} Block
 * @typedef {import('services/block.service').BlockWithTransactions} BlockWithTransactions
 * @typedef {import('ws')} WebSocket
 */

/**
 * @param {WebSocket} socket
 * @returns {void}
 */
exports.askForPeers = (socket) => {
    const sockets = p2pSockets.getSockets();
    if (sockets.size < AVERAGE_PEERS_COUNT) {
        const number = AVERAGE_PEERS_COUNT - sockets.size;
        socket.send(JSON.stringify({ type: P2P_MESSAGE_TYPES.PEERS_REQUEST, data: { number } }));
    }
};

/**
 * @param {WebSocket} socket
 * @param {string} id
 * @returns {void}
 */
exports.sendId = (socket, id) => {
    socket.send(JSON.stringify({ type: P2P_MESSAGE_TYPES.ID, data: { id } }));
};

/**
 * @param {Transaction} transaction
 * @param {Array<string>} ignoreKeys
 */
exports.broadcastTransaction = (transaction, ignoreKeys) => {
    p2pSockets.broadcastMessage(P2P_MESSAGE_TYPES.NEW_TRANSACTION, transaction, ignoreKeys);
};

/**
 * @param {Block & {transactions: Array<Transaction>}} block
 * @param {Array<string>} [ignoreKeys]
 */
exports.broadcastBlock = (block, ignoreKeys = []) => {
    p2pSockets.broadcastMessage(P2P_MESSAGE_TYPES.NEW_BLOCK, block, ignoreKeys);
};

/**
 * @param {number} lastBlockId
 */
exports.broadcastSyncRequest = (lastBlockId) => {
    p2pSockets.broadcastMessage(P2P_MESSAGE_TYPES.SYNC_REQUEST, { lastBlockId });
};

/**
 * @param {string} peer
 * @param {Array<string>} [ignoreKeys]
 */
exports.broadcastPeer = (peer, ignoreKeys = []) => {
    p2pSockets.broadcastMessage(P2P_MESSAGE_TYPES.PEER_GOSSIP, { peer }, ignoreKeys);
};

/**
 * @param {WebSocket} socket
 * @param {number} lastBlockId
 */
exports.syncRequest = (socket, lastBlockId) => {
    socket.send(JSON.stringify({ type: P2P_MESSAGE_TYPES.SYNC_REQUEST, data: { lastBlockId } }));
};

/**
 * @param {WebSocket} socket
 * @param {Array<BlockWithTransactions>} chain
 */
exports.sendChain = (socket, chain) => {
    socket.send(JSON.stringify({ type: P2P_MESSAGE_TYPES.CHAIN, data: chain }));
};

/**
 * @param {WebSocket} socket
 * @param {Array<string>} peers
 */
exports.sendPeers = (socket, peers) => {
    socket.send(JSON.stringify({ type: P2P_MESSAGE_TYPES.PEERS_RESPONSE, data: peers }));
};

/**
 * @param {WebSocket} socket
 * @returns {void}
 */
exports.sendPong = (socket) => {
    socket.send(JSON.stringify({ type: P2P_MESSAGE_TYPES.PONG }));
};
