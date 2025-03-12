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

exports.init = async () => {
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

    const port = process.env.HTTP_PORT;
    app.set('port', port);

    const server = http.createServer(app);
    server.listen(port);
    server.on('error', (error) => onError(error, port));
    server.on('listening', onListening(server));
};
