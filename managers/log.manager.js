const logger = require('pino').default();
const { LOG_LEVELS } = require('../constants/log.constants');

/**
 * @typedef {import('pino').Logger} Logger
 * @typedef {import('express').Request} Request
 * @typedef {import('express').Response} Response
 * @typedef {import('express').NextFunction} NextFunction
 */

/** @type {Logger} */
exports.logger = logger;

/**
 * @param {string} level
 */
exports.setLevel = (level) => {
    logger.level = level;
    logger.info(`Log level is set to: ${logger.level}`);
};

exports.setInitialLevel = () => {
    this.setLevel(process.env.LOG_LEVEL || LOG_LEVELS.TRACE);
};

/**
 * @param {Request} req
 * @param {Response} res
 * @param {NextFunction} next
 */
exports.middleware = (req, res, next) => {
    const start = new Date();
    const originalSend = res.send;

    res.send = function (body) {
        const delay = new Date().getTime() - start.getTime();
        const requestData = {
            method: req.method,
            statusCode: res.statusCode,
            path: req.originalUrl,
            delay,
        };
        if (res.statusCode === 200) logger.info({ msg: req.originalUrl, requestData });
        if (res.statusCode > 200 && res.statusCode <= 404)
            logger.warn({ msg: req.originalUrl, requestData });
        if (res.statusCode > 404) logger.error({ msg: req.originalUrl, requestData });
        originalSend.call(this, body);
        return this;
    };
    next();
};
