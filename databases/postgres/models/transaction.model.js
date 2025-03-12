const TRANSACTION = require('../../../constants/models/transaction.constants');
const BLOCK_TRANSACTION = require('../../../constants/models/block-transaction.constants');

/**
 * @typedef {import('sequelize').Sequelize} Sequelize
 * @typedef {import('sequelize').DataTypes} DataTypes
 * @typedef {import('sequelize').Model} Model
 * @typedef {import('sequelize').ModelStatic<Model> & { associate?: (models: any) => void }} ModelDef
 */

/**
 * @typedef {Object} Transaction
 * @property {string} hash
 * @property {string} from
 * @property {string} to
 * @property {number} amount
 * @property {number} fee
 * @property {number} timestamp
 * @property {string} signature
 */

/**
 * @param {Sequelize} sequelize
 * @param {DataTypes} dataTypes
 * @returns {ModelDef}
 */
module.exports = (sequelize, dataTypes) => {
    /** @type {ModelDef} */
    const Transaction = sequelize.define(
        TRANSACTION.MODEL_NAME,
        {
            hash: {
                type: dataTypes.STRING(64),
                primaryKey: true,
            },
            from: {
                type: dataTypes.STRING(66),
                allowNull: false,
            },
            to: {
                type: dataTypes.STRING(66),
                allowNull: false,
            },
            amount: {
                type: dataTypes.DECIMAL(27, 18),
                allowNull: false,
            },
            fee: {
                type: dataTypes.DECIMAL(27, 18),
                allowNull: false,
            },
            timestamp: {
                type: dataTypes.BIGINT,
                allowNull: false,
            },
            signature: {
                type: dataTypes.STRING(128),
                allowNull: false,
            },
        },
        {
            tableName: TRANSACTION.TABLE_NAME,
            underscored: true,
            timestamps: false,
        },
    );

    /**
     * @param {Object} models
     */
    Transaction.associate = (models) => {
        models[TRANSACTION.MODEL_NAME].hasOne(models[BLOCK_TRANSACTION.MODEL_NAME], {
            foreignKey: 'transactionHash',
            as: BLOCK_TRANSACTION.MODEL_NAME,
        });
    };

    return Transaction;
};
