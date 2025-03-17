const { MODEL_NAME, PEER_TYPES } = require('../../../constants/models/peer.constants');
const { Op } = require('sequelize');
const database = require('..');
const peer = database.getModel(MODEL_NAME);
const postgresHelperLib = require('../../../lib/postgres-helper.lib');

/**
 * @typedef {import('databases/postgres/models/peer.model').Peer} Peer
 * @typedef {import('sequelize').Transaction} DatabaseTransaction
 */

/**
 * @typedef {Object} PeerUpdate
 * @property {string} [nodeType]
 * @property {Date} [lastSeen]
 * @property {boolean} [connected]
 * @property {number} [messageFrequency]
 */

/**
 * @param {Peer} peerData
 * @param {DatabaseTransaction} [databaseTransaction]
 * @returns {Promise<Peer>}
 */
exports.create = async (peerData, databaseTransaction) => {
    const newRecord = await peer.create(
        peerData,
        postgresHelperLib.databseTransactionParams(databaseTransaction),
    );
    return newRecord;
};

/**
 * @param {string} key
 * @param {DatabaseTransaction} [databaseTransaction]
 * @returns {Promise<Peer|null>}
 */
exports.findByKey = async (key, databaseTransaction) => {
    const record = await peer.findOne({
        where: { key },
        ...postgresHelperLib.databseTransactionParams(databaseTransaction),
    });
    return record;
};

/**
 * @param {string} key
 * @param {PeerUpdate} data
 * @param {DatabaseTransaction} [databaseTransaction]
 * @returns {Promise<Peer|null>}
 */
exports.updateByKey = async (key, data, databaseTransaction) => {
    const updatedRecord = await peer.update(data, {
        where: { key },
        ...postgresHelperLib.databseTransactionParams(databaseTransaction),
    });
    return updatedRecord;
};

/**
 * @param {Object} params
 * @param {PeerUpdate} data
 * @param {DatabaseTransaction} [databaseTransaction]
 * @returns {Promise<Peer|null>}
 */
exports.update = async (params, data, databaseTransaction) => {
    const updatedRecord = await peer.update(data, {
        where: params,
        ...postgresHelperLib.databseTransactionParams(databaseTransaction),
    });
    return updatedRecord;
};

/**
 * @param {number} number
 * @returns {Promise<Array<Peer>>}
 */
exports.getServers = async (number) => {
    const records = await peer.findAll({
        where: { nodeType: PEER_TYPES.SERVER, connected: { [Op.not]: false } },
        limit: number,
        order: [['lastSeen', 'ASC']],
    });
    return records;
};
