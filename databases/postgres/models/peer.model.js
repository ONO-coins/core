const PEER = require('../../../constants/models/peer.constants');

/**
 * @typedef {import('sequelize').Sequelize} Sequelize
 * @typedef {import('sequelize').DataTypes} DataTypes
 * @typedef {import('sequelize').Model} Model
 * @typedef {import('sequelize').ModelStatic<Model> & { associate?: (models: any) => void }} ModelDef
 */

/**
 * @typedef {Object} Peer
 * @property {string} key
 * @property {string} nodeType
 * @property {Date} lastSeen
 * @property {boolean} connected
 * @property {number} messageFrequency
 */

/**
 * @param {Sequelize} sequelize
 * @param {DataTypes} dataTypes
 * @returns {ModelDef}
 */
module.exports = (sequelize, dataTypes) => {
    /** @type {ModelDef} */
    const Peer = sequelize.define(
        PEER.MODEL_NAME,
        {
            key: {
                type: dataTypes.STRING(512),
                primaryKey: true,
            },
            lastSeen: {
                type: dataTypes.DATE,
                allowNull: false,
            },
            connected: {
                type: dataTypes.BOOLEAN,
                allowNull: false,
            },
            nodeType: {
                type: dataTypes.ENUM(...Object.values(PEER.PEER_TYPES)),
                allowNull: false,
            },
            messageFrequency: {
                type: dataTypes.FLOAT,
                defaultValue: PEER.FREQUENCY.MAX,
                allowNull: false,
            },
        },
        {
            tableName: PEER.TABLE_NAME,
            underscored: true,
            timestamps: false,
        },
    );

    return Peer;
};
