const sharedBlockService = require('../../services/shared/block.service');

/**
 * @typedef {import('express').Request} Request
 * @typedef {import('express').Response} Response
 */

/**
 * @param {Request} req
 * @param {Response} res
 */
exports.removeChainTo = async (req, res) => {
    const blockId = Number(req.params.blockId);
    await sharedBlockService.removeChainSince(blockId);
    res.json({ blockId });
};
