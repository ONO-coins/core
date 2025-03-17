const WebSocket = require('ws');
const p2pSockets = require('./p2p-sockets');
const p2pHandlers = require('./p2p-handlers');
const state = require('../state');
const { logger } = require('../managers/log.manager');
const { NODE_ID_HEADER, SELF_CONNECTION_ERROR_CODE } = require('../constants/p2p.constants');

/**
 * @typedef {import('ws').WebSocket & { _socket: import('net').Socket }} WebSocketWithSocket
 * @typedef {import('http2').Http2ServerRequest} Http2ServerRequest
 */

/**
 * @param {WebSocketWithSocket} socket
 * @param {Http2ServerRequest} request
 * @returns {void}
 */
function serverConnectionHandler(socket, request) {
    const urlParams = new URLSearchParams(request.url.split('?')[1]);
    const nodeId = request.headers[NODE_ID_HEADER] || urlParams.get(NODE_ID_HEADER);

    if (!nodeId) {
        logger.info(`No node id provided.`);
        socket.close();
        return;
    }

    if (nodeId === state.id()) {
        logger.info(`Trying connect to ourselves. Aborting connection.`);
        socket.close(SELF_CONNECTION_ERROR_CODE, 'Self-connection detected');
        return;
    }

    const sockets = p2pSockets.getSockets();
    const id = String(nodeId);
    if (sockets.has(id)) {
        logger.info(`We are already connected to ${id}, preventing double connection.`);
        socket.close();
        return;
    }

    sockets.set(id, socket);
    p2pHandlers.socketConnected(socket, id, true);

    socket.on('close', (code) => {
        if (code !== SELF_CONNECTION_ERROR_CODE) sockets.delete(id);
        p2pHandlers.socketDisconnected(socket, id);
    });
}

/**
 * @returns {void}
 */
exports.init = () => {
    const port = Number(process.env.P2P_PORT);
    const server = new WebSocket.Server({ port, maxPayload: 12 * 1024 * 1024 });

    server.on('connection', serverConnectionHandler);
    logger.info(`P2P listening on port ${port}`);
};
