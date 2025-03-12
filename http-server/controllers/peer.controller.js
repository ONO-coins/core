const peerService = require('../../services/peer.service');
const p2pClient = require('../../p2p/p2p-client');

/**
 * @typedef {import('express').Request} Request
 * @typedef {import('express').Response} Response
 */

/**
 * @param {Request} req
 * @param {Response} res
 */
exports.addPeer = async (req, res) => {
    const existed = await peerService.checkAddress(req.body.address);
    if (existed) throw new Error('We already know this peer');

    p2pClient.connectToPear(req.body.address, true);
    res.json(req.body);
};
