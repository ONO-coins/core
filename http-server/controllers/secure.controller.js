const sharedBlockService = require('../../services/shared/block.service');
const p2pSockets = require('../../p2p/p2p-sockets');

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

/**
 * @param {Request} req
 * @param {Response} res
 */
exports.stats = async (req, res) => {
    const socketConnections = p2pSockets.getKeys();
    res.json({ socketConnections });
};
