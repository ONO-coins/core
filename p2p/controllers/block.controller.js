const blockDao = require('../../databases/postgres/dao/block.dao');
const balanceDao = require('../../databases/postgres/dao/balance.dao');
const blockTransactionDao = require('../../databases/postgres/dao/block-transaction.dao');
const blockGeneralController = require('../../controllers/block.controller');
const blockService = require('../../services/block.service');
const blockTransactionService = require('../../services/block-transaction.service');
const p2pActions = require('../p2p-actions');
const state = require('../../state');
const { logger } = require('../../managers/log.manager');
const { UniqueConstraintError } = require('sequelize');
const { ERROR_TYPES } = require('../../constructors/error.constructor');
const { BLOCKCHAIN_SETTINGS } = require('../../constants/app.constants');

/**
 * @typedef {import('databases/postgres/models/transaction.model').Transaction} Transaction
 * @typedef {import('services/block.service').BlockWithTransactions} BlockWithTransactions
 * @typedef {import('ws')} WebSocket
 */

/**
 * @param {BlockWithTransactions} blockData
 * @param {WebSocket} socket
 * @param {string} [senderKey]
 */
exports.onBlock = async (blockData, socket, senderKey) => {
    try {
        const isSyncing = state.getState(state.KEYS.SYNCING);
        if (isSyncing) return;

        const success = await blockGeneralController.onBlock(blockData);
        if (!success) return;

        state.setState(state.KEYS.LAST_VALID_EXTERNAL_BLOCK_DATE, new Date());

        const immutableBlockId = blockData.id - BLOCKCHAIN_SETTINGS.MAX_MUTABLE_BLOCK_COUNT;
        blockService.setImmutableBlockId(immutableBlockId);

        logger.info(`New valid block ${blockData.id} received`);
        p2pActions.broadcastBlock(blockData, [senderKey]);
    } catch (err) {
        logger.warn(`Block ${blockData?.id} error: ${err.message}`);

        if (err instanceof UniqueConstraintError) {
            await this.onBlock(blockData, socket, senderKey);
            return;
        }

        if (err.errorType === ERROR_TYPES.SYNC_ERROR) {
            const immutableBlockId = await blockService.getImmutableBlockId();
            const newImmutableBlockId =
                immutableBlockId - BLOCKCHAIN_SETTINGS.MAX_MUTABLE_BLOCK_COUNT;
            blockService.setImmutableBlockId(newImmutableBlockId);
            p2pActions.syncRequest(socket, immutableBlockId);
        }

        state.setState(state.KEYS.PROCESSING_BLOCK_ID, 0);
    }
};

/**
 * @param {Object} data
 * @param {number} data.lastBlockId
 * @param {WebSocket} socket
 */
exports.syncRequest = async (data, socket) => {
    logger.debug(`Sync request from ${data.lastBlockId}`);
    const chain = await blockDao.getBlocksFrom(data.lastBlockId);
    p2pActions.sendChain(socket, chain);
};

/**
 * @param {Array<BlockWithTransactions>} chain
 * @param {WebSocket} socket
 */
exports.onChain = async (chain, socket) => {
    if (!chain.length) return;

    const isSyncing = state.getState(state.KEYS.SYNCING);
    if (isSyncing) return;

    state.setState(state.KEYS.SYNCING, true);

    try {
        const chainValidationResult = await blockTransactionService.validateChain(chain);
        if (!chainValidationResult.valid) throw new Error(chainValidationResult.error);

        await blockTransactionDao.removeSinceBlockId(chainValidationResult.initialBlockId);
        await balanceDao.flushBalancesFromBlock(chainValidationResult.initialBlockId);

        for (let i = 0; i < chain.length; i++) {
            await blockGeneralController.onBlock(chain[i]);
        }

        const lastBlock = chain[chain.length - 1];

        if (chain.length < BLOCKCHAIN_SETTINGS.SYNCHRONIZATION_BATCH) {
            state.setState(state.KEYS.SYNCING, false);
            logger.info(`Chain synchronized!`);
            return;
        }

        state.setState(state.KEYS.SYNCING, false);

        logger.info(`Chain synchronizing... Last block id: ${lastBlock.id}`);
        p2pActions.broadcastSyncRequest(lastBlock.id);
    } catch (error) {
        logger.warn(`Chain error: ${error}`);
        state.setState(state.KEYS.PROCESSING_BLOCK_ID, 0);
        state.setState(state.KEYS.SYNCING, false);
    }
};
