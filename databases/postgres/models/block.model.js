const BLOCK = require('../../../constants/models/block.constants');
const BLOCK_TRANSACTION = require('../../../constants/models/block-transaction.constants');
const TRANSACTION = require('../../../constants/models/transaction.constants');
const { foreignKey } = require('../../../lib/postgres-helper.lib');

/**
 * @typedef {import('sequelize').Sequelize} Sequelize
 * @typedef {import('sequelize').DataTypes} DataTypes
 * @typedef {import('sequelize').Model} Model
 * @typedef {import('sequelize').ModelStatic<Model> & { associate?: (models: any) => void }} ModelDef
 */

/**
 * @typedef {Object} Block
 * @property {number} id
 * @property {number} timestamp
 * @property {number} target
 * @property {string} hash
 * @property {string} previousHash
 * @property {string} publicKey
 * @property {string} signature
 */

/**
 * @param {Sequelize} sequelize
 * @param {DataTypes} dataTypes
 * @returns {ModelDef}
 */
module.exports = (sequelize, dataTypes) => {
    /** @type {ModelDef} */
    const Block = sequelize.define(
        BLOCK.MODEL_NAME,
        {
            id: {
                type: dataTypes.BIGINT,
                primaryKey: true,
            },
            timestamp: {
                type: dataTypes.BIGINT,
                allowNull: false,
            },
            target: {
                type: dataTypes.INTEGER,
                allowNull: false,
            },
            hash: {
                type: dataTypes.STRING(64),
                allowNull: false,
            },
            previousHash: {
                type: dataTypes.STRING(64),
                allowNull: false,
            },
            publicKey: {
                type: dataTypes.STRING(66),
                allowNull: false,
            },
            signature: {
                type: dataTypes.STRING(128),
                allowNull: false,
            },
        },
        {
            tableName: BLOCK.TABLE_NAME,
            underscored: true,
            timestamps: false,
        },
    );

    /**
     * @param {Object} models
     */
    Block.associate = (models) => {
        models[BLOCK.MODEL_NAME].belongsToMany(models[TRANSACTION.MODEL_NAME], {
            through: BLOCK_TRANSACTION.MODEL_NAME,
            foreignKey: foreignKey(BLOCK.MODEL_NAME),
            as: 'transactions',
        });
    };

    return Block;
};
