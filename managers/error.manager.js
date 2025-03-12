const createError = require('http-errors');
const { logger } = require('./log.manager');

/**
 * @typedef {import('express').Request} Request
 * @typedef {import('express').Response} Response
 * @typedef {import('express').NextFunction} NextFunction
 * @typedef {import('express-openapi-validator/dist/framework/types').HttpError} HttpError
 */

/**
 * @param {Request} req
 * @param {Response} res
 * @param {NextFunction} next
 */
exports.notFound = (req, res, next) => next(createError(404));

/**
 * @param {HttpError} err
 * @param {Request} req
 * @param {Response} res
 * @param {NextFunction} next
 */
exports.errorHandler = (err, req, res, next) => {
    res.locals.message = err.message;
    if (err.status !== 404) logger.error(err);
    res.status(err.status || 400);
    res.json({ error: err.message });
};

/**
 * @param {(req: Request, res: Response) => Promise<void>} handler
 * @returns {(req: Request, res: Response, next: NextFunction) => void}
 */
exports.errorCatcher = (handler) => (req, res, next) => handler(req, res).catch(next);

/**
 * @param {string} template
 * @param {Array<string>} values
 * @returns {string}
 */
exports.replacePlaceholders = (template, values) => {
    let i = 0;
    return template.replace(/\?\?/g, () => values[i++]);
};
