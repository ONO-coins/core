const TRANSACTION = require('../../../constants/models/transaction.constants');
const BLOCK = require('../../../constants/models/block.constants');
const BLOCK_TRANSACTION = require('../../../constants/models/block-transaction.constants');
const { foreignKey } = require('../../../lib/postgres-helper.lib');

/**
 * @typedef {import('sequelize').Sequelize} Sequelize
 * @typedef {import('sequelize').DataTypes} DataTypes
 * @typedef {import('sequelize').Model} Model
 * @typedef {import('sequelize').ModelStatic<Model> & { associate?: (models: any) => void }} ModelDef
 */

/**
 * @typedef {Object} BlockTransaction
 * @property {number} id
 * @property {number} blockId
 * @property {string} transactionHash
 */

/**
 * @param {Sequelize} sequelize
 * @param {DataTypes} dataTypes
 * @returns {ModelDef}
 */
module.exports = (sequelize, dataTypes) => {
    /** @type {ModelDef} */
    const BlockTransaction = sequelize.define(
        BLOCK_TRANSACTION.MODEL_NAME,
        {
            id: {
                type: dataTypes.BIGINT,
                primaryKey: true,
                autoIncrement: true,
            },
            transactionHash: {
                type: dataTypes.STRING(64),
                unique: true,
                references: {
                    model: TRANSACTION.TABLE_NAME,
                    key: 'hash',
                },
            },
            [foreignKey(BLOCK.MODEL_NAME)]: {
                type: dataTypes.BIGINT,
                references: {
                    model: BLOCK.TABLE_NAME,
                    key: 'id',
                },
            },
        },
        {
            tableName: BLOCK_TRANSACTION.TABLE_NAME,
            underscored: true,
            timestamps: false,
        },
    );

    return BlockTransaction;
};
