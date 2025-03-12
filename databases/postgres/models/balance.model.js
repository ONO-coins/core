const BALANCE = require('../../../constants/models/balance.constants');

/**
 * @typedef {import('sequelize').Sequelize} Sequelize
 * @typedef {import('sequelize').DataTypes} DataTypes
 * @typedef {import('sequelize').Model} Model
 * @typedef {import('sequelize').ModelStatic<Model> & { associate?: (models: any) => void }} ModelDef
 */

/**
 * @typedef {Object} Balance
 * @property {string} address
 * @property {number} balance
 * @property {number} burned
 * @property {number} affectedBlockId
 * @property {number} createdAt
 * @property {number} updatedAt
 */

/**
 * @param {Sequelize} sequelize
 * @param {DataTypes} dataTypes
 * @returns {ModelDef}
 */
module.exports = (sequelize, dataTypes) => {
    /** @type {ModelDef} */
    const Balance = sequelize.define(
        BALANCE.MODEL_NAME,
        {
            address: {
                type: dataTypes.STRING(66),
                primaryKey: true,
            },
            balance: {
                type: dataTypes.DECIMAL(27, 18),
                defaultValue: 0,
            },
            burned: {
                type: dataTypes.DECIMAL(27, 18),
                defaultValue: 0,
            },
            affectedBlockId: {
                type: dataTypes.BIGINT,
                allowNull: false,
            },
        },
        {
            tableName: BALANCE.TABLE_NAME,
            underscored: true,
            timestamps: true,
        },
    );

    return Balance;
};
