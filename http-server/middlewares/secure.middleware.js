/**
 * @typedef {import('express').Request} Request
 * @typedef {import('express').Response} Response
 * @typedef {import('express').NextFunction} NextFunction
 */

/**
 * @param {Request} req
 * @param {Response} res
 * @param {NextFunction} next
 */
exports.checkAccess = (req, res, next) => {
    if (process.env.ALLOW_SECURE_ROUTES !== 'true')
        return next(new Error('Secure router is turned off'));
    if (process.env.SECURE_ROUTES_AUTHORIZATION_HEADER !== req.headers.authorization)
        return next(new Error('Access denied'));

    return next();
};
