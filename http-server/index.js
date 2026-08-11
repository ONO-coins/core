const express = require('express');
const cors = require('cors');
const http = require('http');
const path = require('path');
const OpenApiValidator = require('express-openapi-validator');
const errorManager = require('../managers/error.manager');
const logManager = require('../managers/log.manager');
const { TOTAL_COUNT_HEADER } = require('../constants/headers.constants.js');

/**
 * @param {http.Server} server
 * @returns {() => void}
 */
function onListening(server) {
    return () => {
        const addr = server.address();
        const bind = typeof addr === 'string' ? 'pipe ' + addr : 'port ' + addr.port;
        logManager.logger.info('HTTP listening on ' + bind);
    };
}

/**
 * @param {NodeJS.ErrnoException} error
 * @param {string|number} port
 * @throws {NodeJS.ErrnoException}
 * @returns {void}
 */
function onError(error, port) {
    if (error.syscall !== 'listen') {
        throw error;
    }

    const bind = typeof port === 'string' ? 'Pipe ' + port : 'Port ' + port;

    switch (error.code) {
        case 'EACCES':
            logManager.logger.fatal(bind + ' requires elevated privileges');
            process.exit(1);
            break;
        case 'EADDRINUSE':
            logManager.logger.fatal(bind + ' is already in use');
            process.exit(1);
            break;
        default:
            throw error;
    }
}

/**
 * Builds the fully-wired Express app (middleware → OpenAPI validation → routers
 * → error handlers) WITHOUT binding a socket. Extracted from init() so the API
 * can be exercised in-process by tests; init() below is unchanged in behaviour.
 * @returns {import('express').Express}
 */
exports.createApp = () => {
    const app = express();
    app.use(logManager.middleware);
    app.use(cors({ exposedHeaders: [TOTAL_COUNT_HEADER] }));
    app.use(express.json());
    app.use(express.urlencoded({ extended: false }));

    const apiSpec = path.join(__dirname, 'openapi.yaml');
    app.use(OpenApiValidator.middleware({ apiSpec }));

    const router = require('./router');
    router.init(app);

    app.use(errorManager.notFound);
    app.use(errorManager.errorHandler);
    return app;
};

exports.init = async () => {
    const app = this.createApp();

    const port = process.env.HTTP_PORT;
    app.set('port', port);

    const server = http.createServer(app);
    server.listen(port);
    server.on('error', (error) => onError(error, port));
    server.on('listening', onListening(server));
};
