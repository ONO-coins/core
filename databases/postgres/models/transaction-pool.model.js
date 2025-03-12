const TRANSACTION_POOL = require('../../../constants/models/transaction-pool.constants');
const TRANSACTION = require('../../../constants/models/transaction.constants');
const { foreignKey } = require('../../../lib/postgres-helper.lib');

/**
 * @typedef {import('sequelize').Sequelize} Sequelize
 * @typedef {import('sequelize').DataTypes} DataTypes
 * @typedef {import('sequelize').Model} Model
 * @typedef {import('sequelize').ModelStatic<Model> & { associate?: (models: any) => void }} ModelDef
 */

/**
 * @typedef {Object} TransactionPool
 * @property {number} id
 * @property {string} transactionId
 * @property {Date} createdAt
 * @property {Date} updatedAt
 */

/**
 * @param {Sequelize} sequelize
 * @param {DataTypes} dataTypes
 * @returns {ModelDef}
 */
module.exports = (sequelize, dataTypes) => {
    /** @type {ModelDef} */
    const TransactionPool = sequelize.define(
        TRANSACTION_POOL.MODEL_NAME,
        {
            id: {
                type: dataTypes.BIGINT,
                primaryKey: true,
                autoIncrement: true,
            },
            transactionHash: {
                type: dataTypes.STRING(64),
                references: {
                    model: TRANSACTION.TABLE_NAME,
                    key: 'hash',
                },
            },
        },
        {
            tableName: TRANSACTION_POOL.TABLE_NAME,
            underscored: true,
            timestamps: true,
        },
    );

    /**
     * @param {Object} models
     */
    TransactionPool.associate = (models) => {
        models[TRANSACTION_POOL.MODEL_NAME].belongsTo(models[TRANSACTION.MODEL_NAME], {
            foreignKey: 'transactionHash',
            as: TRANSACTION.MODEL_NAME,
        });
    };

    return TransactionPool;
};
