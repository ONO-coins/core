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
        state.setState(state.KEYS.FORGER_PREDICTED_TIMESTAMP, 0);

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
            state.setState(state.KEYS.SYNCHRONIZED, false);
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
    // Always answer, even with an empty chain: that tells the requester it has
    // reached our tip and lets it finalize, instead of waiting forever when a sync
    // ends on an exact batch boundary (review S6).
    p2pActions.sendChain(socket, chain);
};

/**
 * @param {Array<BlockWithTransactions>} chain
 * @param {WebSocket} socket
 */
exports.onChain = async (chain, socket) => {
    const synchronized = state.getState(state.KEYS.SYNCHRONIZED);
    if (synchronized) return;

    const chainProcessing = state.getState(state.KEYS.CHAIN_PROCESSING);
    if (chainProcessing) return;

    // An empty chain means the peer has nothing beyond our request point: we have
    // reached its tip, so finish syncing. This resolves the batch-boundary wedge
    // where a sync ending on an exact batch multiple never finalized (review S6).
    if (!chain.length) {
        state.setState(state.KEYS.SYNCING, false);
        state.setState(state.KEYS.SYNCHRONIZED, true);
        logger.info(`Chain synchronized!`);
        return;
    }

    state.setState(state.KEYS.SYNCING, true);
    state.setState(state.KEYS.CHAIN_PROCESSING, true);

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
            state.setState(state.KEYS.CHAIN_PROCESSING, false);
            state.setState(state.KEYS.SYNCHRONIZED, true);
            logger.info(`Chain synchronized!`);
            return;
        }

        state.setState(state.KEYS.CHAIN_PROCESSING, false);

        // Continue with the same peer we are syncing from, so a peer that is itself
        // behind cannot prematurely end our sync with an empty answer (review S6).
        logger.info(`Chain synchronizing... Last block id: ${lastBlock.id}`);
        p2pActions.syncRequest(socket, lastBlock.id);
    } catch (error) {
        logger.warn(`Chain error: ${error}`);
        state.setState(state.KEYS.PROCESSING_BLOCK_ID, 0);
        state.setState(state.KEYS.CHAIN_PROCESSING, false);
        state.setState(state.KEYS.SYNCING, false);
        // Settle the attempt. If we are still behind, the next status handshake or
        // block broadcast re-triggers sync; leaving SYNCHRONIZED false would wedge
        // us in a perpetually "not synced" state (review S6).
        state.setState(state.KEYS.SYNCHRONIZED, true);
    }
};

/**
 * React to a peer's advertised chain tip. If the peer is ahead, or at our height
 * but on a different block, pull its chain from our mutable boundary and let
 * validateChain decide by cumulative difficulty (review S6).
 * @param {{lastBlockId: number, lastBlockHash: string}} data
 * @param {WebSocket} socket
 */
exports.onStatus = async (data, socket) => {
    if (state.getState(state.KEYS.SYNCING)) return;

    const lastBlock = await blockDao.getLastBlock();
    if (!lastBlock) return;

    const peerAhead = data.lastBlockId > lastBlock.id;
    const tipDiverged =
        data.lastBlockId === lastBlock.id && data.lastBlockHash !== lastBlock.hash;
    if (!peerAhead && !tipDiverged) return;

    state.setState(state.KEYS.SYNCHRONIZED, false);
    const immutableBlockId = state.getState(state.KEYS.IMMUTABLE_BLOCK_ID);
    p2pActions.syncRequest(socket, immutableBlockId);
};

/**
 * Advertise our current chain tip to one peer (used on connect).
 * @param {WebSocket} socket
 */
exports.sendStatus = async (socket) => {
    const lastBlock = await blockDao.getLastBlock();
    if (!lastBlock) return;
    p2pActions.sendStatus(socket, { lastBlockId: lastBlock.id, lastBlockHash: lastBlock.hash });
};

/**
 * Advertise our current chain tip to all peers (periodic gossip).
 */
exports.broadcastStatus = async () => {
    const lastBlock = await blockDao.getLastBlock();
    if (!lastBlock) return;
    p2pActions.broadcastStatus({ lastBlockId: lastBlock.id, lastBlockHash: lastBlock.hash });
};
