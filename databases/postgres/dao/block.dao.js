const { Op } = require('sequelize');
const { MODEL_NAME } = require('../../../constants/models/block.constants');
const block = require('../index').getModel(MODEL_NAME);
const postgresHelperLib = require('../../../lib/postgres-helper.lib');
const { BLOCKCHAIN_SETTINGS } = require('../../../constants/app.constants');

/**
 * @typedef {import('../models/block.model').Block} Block
 * @typedef {import('services/block.service').BlockWithTransactions} BlockWithTransactions
 * @typedef {import('sequelize').Model} Model
 * @typedef {import('sequelize').Transaction} DatabaseTransaction
 */

/**
 * @returns {Promise<Block|null>}
 */
exports.getLastBlock = async () => {
    const lastBlock = await block.findOne({
        where: {},
        order: [['id', 'DESC']],
    });
    if (lastBlock) {
        return lastBlock.toJSON();
    } else {
        return null;
    }
};

/**
 * @param {string} publicKey
 * @returns {Promise<Block|null>}
 */
exports.getLastExternalBlock = async (publicKey) => {
    const lastBlock = await block.findOne({
        where: { publicKey: { [Op.ne]: publicKey } },
        order: [['id', 'DESC']],
    });
    if (lastBlock) {
        return lastBlock.toJSON();
    } else {
        return null;
    }
};

/**
 * @param {number} id
 * @returns {Promise<Block|null>}
 */
exports.getById = async (id) => {
    const record = await block.findOne({
        where: { id },
    });
    if (record) {
        return record.toJSON();
    } else {
        return null;
    }
};

/**
 * @param {number} id
 * @returns {Promise<BlockWithTransactions|null>}
 */
exports.getByIdWithTransactions = async (id) => {
    const record = await block.findOne({
        where: { id },
        include: [
            {
                association: 'transactions',
                through: { attributes: [] },
            },
        ],
    });
    if (record) {
        const blockObject = record.toJSON();
        return postgresHelperLib.formatBlockNumbers(blockObject);
    } else {
        return null;
    }
};

/**
 * @param {string} hash
 * @returns {Promise<Block|null>}
 */
exports.getByHash = async (hash) => {
    const record = await block.findOne({
        where: { hash },
    });
    if (record) {
        return record.toJSON();
    } else {
        return null;
    }
};

/**
 * @param {Block} blockData
 * @param {DatabaseTransaction} [databaseTransaction]
 * @returns {Promise<Block>}
 */
exports.create = async (blockData, databaseTransaction) => {
    const newBlock = await block.create(
        blockData,
        postgresHelperLib.databseTransactionParams(databaseTransaction),
    );
    return newBlock;
};

/**
 * @param {number} fromId
 * @param {number} [limit]
 * @returns {Promise<Array<BlockWithTransactions>>}
 */
exports.getBlocksFrom = async (fromId, limit = BLOCKCHAIN_SETTINGS.SYNCHRONIZATION_BATCH) => {
    const records = await block.findAll({
        where: { id: { [Op.gt]: fromId } },
        order: [['id', 'ASC']],
        limit,
        include: [
            {
                association: 'transactions',
                through: { attributes: [] },
            },
        ],
    });
    return records.map((record) => {
        const blockObject = record.toJSON();
        return postgresHelperLib.formatBlockNumbers(blockObject);
    });
};

/**
 * @param {number} limit
 * @returns {Promise<number>}
 */
exports.getAverageTarget = async (limit = 10) => {
    const records = await block.findAll({
        where: {},
        attributes: ['target'],
        order: [['id', 'DESC']],
        limit,
        raw: true,
        nest: true,
    });
    const sum = records.reduce((sum, record) => (sum += record.target), 0);
    return sum / records.length;
};
