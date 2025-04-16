/**
 * @enum {string}
 */
exports.P2P_MESSAGE_TYPES = {
    NEW_TRANSACTION: 'NEW_TRANSACTION',
    NEW_BLOCK: 'NEW_BLOCK',
    SYNC_REQUEST: 'SYNC_REQUEST',
    CHAIN: 'CHAIN',
    PEERS_REQUEST: 'PEERS_REQUEST',
    PEERS_RESPONSE: 'PEERS_RESPONSE',
    PEER_GOSSIP: 'PEER_GOSSIP',
    PING: 'PING',
    PONG: 'PONG',
    ID: 'ID',
};

exports.DEFAULT_PEERS_RECONNECTION_TIMEOUT = 10_000;
exports.AVERAGE_PEERS_COUNT = 20;
exports.MIN_PEERS_COUNT = 2;
exports.BLOCK_LAG_FOR_RECONNECT = 120_000;
exports.NODE_ID_HEADER = 'node-id';
exports.NETWORK_LAG = 5_000;
exports.SELF_CONNECTION_ERROR_CODE = 4001;
