const { P2P_MESSAGE_TYPES } = require('../constants/p2p.constants');
const transactionController = require('./controllers/transaction.controller');
const blockController = require('./controllers/block.controller');
const peersController = require('./controllers/peers.controller');
const pingController = require('./controllers/ping.controller');
const peerService = require('../services/peer.service');
const p2pValidator = require('./p2p-validator');
const { logger } = require('../managers/log.manager');

/**
 * @typedef {import('ws').WebSocket & { _socket: import('net').Socket }} WebSocketWithSocket
 */

/**
 * @param {WebSocketWithSocket} socket
 * @param {string} key
 */
exports.messageHandler = (socket, key) => {
    socket.on('message', async (message) => {
        const { parsed, parsedMessage } = peerService.parseMessage(message);
        if (!parsed) {
            socket.close();
            return;
        }

        const spamming = await peerService.messageEvent(key, parsedMessage.type);
        if (spamming) {
            logger.debug(`socket ${key} ignored because of spam`);
            socket.close();
            return;
        }

        const valid = p2pValidator.validateMessage(parsedMessage);
        if (!valid) {
            logger.warn(`invalid message ${parsedMessage.type} from socket key ${key}`);
            return;
        }

        switch (parsedMessage.type) {
            case P2P_MESSAGE_TYPES.NEW_TRANSACTION:
                await transactionController.onTransaction(parsedMessage.data, key);
                break;
            case P2P_MESSAGE_TYPES.NEW_BLOCK:
                await blockController.onBlock(parsedMessage.data, socket, key);
                break;
            case P2P_MESSAGE_TYPES.SYNC_REQUEST:
                await blockController.syncRequest(parsedMessage.data, socket);
                break;
            case P2P_MESSAGE_TYPES.CHAIN:
                await blockController.onChain(parsedMessage.data, socket);
                break;
            case P2P_MESSAGE_TYPES.PEERS_REQUEST:
                await peersController.sharePeers(parsedMessage.data, socket);
                break;
            case P2P_MESSAGE_TYPES.PEERS_RESPONSE:
                peersController.onPeers(parsedMessage.data);
                break;
            case P2P_MESSAGE_TYPES.ID:
                peersController.onId(parsedMessage.data, socket);
                break;
            case P2P_MESSAGE_TYPES.PEER_GOSSIP:
                await peersController.onGossip(parsedMessage.data, key);
                break;
            case P2P_MESSAGE_TYPES.PING:
                pingController.onPing(socket);
                break;
            default:
                logger.warn('Invalid message type');
        }
    });
};
