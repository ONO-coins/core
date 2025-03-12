const blockRouter = require('./block.router');
const balanceRouter = require('./balance.router');
const transactionRouter = require('./transaction.router');
const peerRouter = require('./peer.router');
const secureRouter = require('./secure.router');
const secureMiddleware = require('../middlewares/secure.middleware');

/**
 * @typedef {import('express').Express} Express
 */

/**
 * @param {Express} app
 * @returns {void}
 */
exports.init = (app) => {
    app.use('/block', blockRouter);
    app.use('/balance', balanceRouter);
    app.use('/transaction', transactionRouter);
    app.use('/peer', peerRouter);
    app.use('/secure', secureMiddleware.checkAccess, secureRouter);
};
