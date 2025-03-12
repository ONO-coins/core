const { Op } = require('sequelize');
const { MODEL_NAME } = require('../../../constants/models/balance.constants');
const database = require('..');
const balanceModel = database.getModel(MODEL_NAME);
const postgresHelperLib = require('../../../lib/postgres-helper.lib');

/**
 * @typedef {import('databases/postgres/models/balance.model').Balance} Balance
 * @typedef {import('sequelize').Transaction} DatabaseTransaction
 */

/**
 * @param {string} address
 * @param {number} amount
 * @param {number} burned
 * @param {number} affectedBlockId
 * @param {DatabaseTransaction} [databaseTransaction]
 * @returns {Promise<Balance>}
 */
exports.changeBalance = async (address, amount, burned, affectedBlockId, databaseTransaction) => {
    await balanceModel.update(
        { affectedBlockId },
        { where: { address }, ...postgresHelperLib.databseTransactionParams(databaseTransaction) },
    );
    if (burned !== 0) {
        await balanceModel.increment('burned', {
            by: burned,
            where: { address },
            ...postgresHelperLib.databseTransactionParams(databaseTransaction),
        });
    }
    const result = await balanceModel.increment('balance', {
        by: amount,
        where: { address },
        ...postgresHelperLib.databseTransactionParams(databaseTransaction),
    });
    return result;
};

/**
 * @param {string} address
 * @param {number} balance
 * @param {number} burned
 * @param {DatabaseTransaction} [databaseTransaction]
 * @returns {Promise<Balance>}
 */
exports.updateBalances = async (address, balance, burned, databaseTransaction) => {
    const updated = await balanceModel.update(
        { balance, burned },
        {
            where: { address },
            returning: true,
            ...postgresHelperLib.databseTransactionParams(databaseTransaction),
        },
    );
    return updated[1];
};

/**
 * @param {string} address
 * @param {DatabaseTransaction} [databaseTransaction]
 * @returns {Promise<Balance>}
 */
exports.getBalance = async (address, databaseTransaction) => {
    const record = await balanceModel.findOne({
        where: { address },
        ...postgresHelperLib.databseTransactionParams(databaseTransaction),
    });
    return record;
};

/**
 * @param {string} address
 * @param {number} amount
 * @param {number} burned
 * @param {number} affectedBlockId
 * @param {DatabaseTransaction} [databaseTransaction]
 * @returns {Promise<Balance>}
 */
exports.create = async (address, amount, burned, affectedBlockId, databaseTransaction) => {
    const newRecord = await balanceModel.create(
        { address, balance: amount, burned, affectedBlockId },
        postgresHelperLib.databseTransactionParams(databaseTransaction),
    );
    return newRecord;
};

/**
 * @param {number} blockId
 * @param {DatabaseTransaction} [databaseTransaction]
 * @returns {Promise<void>}
 */
exports.flushBalancesFromBlock = async (blockId, databaseTransaction) => {
    await balanceModel.destroy({
        where: { affectedBlockId: { [Op.gt]: blockId } },
        ...postgresHelperLib.databseTransactionParams(databaseTransaction),
    });
};
