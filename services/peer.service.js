const peerDao = require('../databases/postgres/dao/peer.dao');
const database = require('../databases/postgres');
const utilsLib = require('../lib/utils.lib');
const state = require('../state');
const { Op } = require('sequelize');
const { PEER_TYPES, FREQUENCY } = require('../constants/models/peer.constants');
const { P2P_MESSAGE_TYPES } = require('../constants/p2p.constants');

const sequelize = database.getSequelize();

/**
 * @typedef {import('databases/postgres/models/peer.model').Peer} Peer
 * @typedef {import('sequelize').Transaction} DatabaseTransaction
 * @typedef {import('ws').RawData} RawData
 * @typedef {typeof PEER_TYPES[keyof typeof PEER_TYPES]} nodeType
 * @typedef {typeof P2P_MESSAGE_TYPES[keyof typeof P2P_MESSAGE_TYPES]} mesasgeType
 */

/**
 * @param {string} key
 * @param {nodeType} type
 * @returns {Promise<Peer>}
 */
exports.peerConnection = async (key, type) => {
    const commonPart = {
        lastSeen: new Date(),
        connected: true,
        nodeType: type,
    };
    const databaseTransaction = await sequelize.transaction();
    const existed = await peerDao.findByKey(key, databaseTransaction);
    if (existed) {
        const updatedRecord = await peerDao.updateByKey(key, commonPart);
        await databaseTransaction.commit();
        return updatedRecord;
    } else {
        const newRecord = await peerDao.create(
            {
                key,
                messageFrequency: FREQUENCY.DEFAULT,
                ...commonPart,
            },
            databaseTransaction,
        );
        await databaseTransaction.commit();
        return newRecord;
    }
};

/**
 * @param {string} key
 * @returns {Promise<Peer>}
 */
exports.serverConnection = async (key) => {
    return this.peerConnection(key, PEER_TYPES.CLIENT);
};

/**
 * @param {string} key
 * @returns {Promise<Peer>}
 */
exports.clientConnection = async (key) => {
    return this.peerConnection(key, PEER_TYPES.SERVER);
};

/**
 * @param {string} key
 * @param {Date} disconnectionTime
 * @returns {Promise<void>}
 */
exports.disconnect = async (key, disconnectionTime) => {
    await peerDao.update(
        { key, lastSeen: { [Op.lt]: disconnectionTime } },
        { connected: false, lastSeen: new Date() },
    );
};

/**
 * @param {number} number
 * @returns {Promise<Array<string>>}
 */
exports.getPeers = async (number) => {
    const records = await peerDao.getServers(number);
    return records.map((record) => record.key);
};

/**
 * @param {string} address
 * @returns {Promise<boolean>}
 */
exports.checkAddress = async (address) => {
    const wsAddress = utilsLib.toWsAddress(address);
    const existed = await peerDao.findByKey(wsAddress);
    return existed ? true : false;
};

exports.init = async () => {
    await peerDao.update({}, { connected: false });
};

/**
 * @param {string} key
 * @param {mesasgeType} messageType
 * @returns {Promise<boolean>}
 */
exports.messageEvent = async (key, messageType) => {
    if (state.isSyncing()) return;

    const databaseTransaction = await sequelize.transaction();
    const peer = await peerDao.findByKey(key, databaseTransaction);
    if (!peer) {
        await databaseTransaction.commit();
        return false;
    }

    const interval = new Date().getTime() - peer.lastSeen.getTime();
    const newFrequency =
        (peer.messageFrequency * (FREQUENCY.MESSAGES_COUNT - 1) + interval) /
        FREQUENCY.MESSAGES_COUNT;
    await peerDao.update(
        { key },
        { lastSeen: new Date(), messageFrequency: Math.min(newFrequency, FREQUENCY.DEFAULT) },
        databaseTransaction,
    );
    await databaseTransaction.commit();

    const minAllowedFrequency =
        messageType === P2P_MESSAGE_TYPES.SYNC_REQUEST ? FREQUENCY.SYNCING_MIN : FREQUENCY.MIN;
    return peer.messageFrequency < minAllowedFrequency;
};

/**
 * @param {RawData} message
 * @returns {{parsed: boolean, parsedMessage?: Object}}
 */
exports.parseMessage = (message) => {
    try {
        const parsedMessage = JSON.parse(message.toString());
        return { parsed: true, parsedMessage };
    } catch {
        return { parsed: false };
    }
};
