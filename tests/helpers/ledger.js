const Big = require('big.js');
const path = require('node:path');
const { UniqueConstraintError } = require('sequelize');
const { BLOCKCHAIN_SETTINGS } = require('../../constants/app.constants');

/**
 * In-memory ledger implementing the exact DAO contracts of the postgres layer,
 * with REAL transaction semantics (snapshot on begin, restore on rollback).
 *
 * This is what lets the suite exercise the full consensus path
 * (controllers/block.controller.onBlock, chain validation, fork resolution,
 * balance application) end-to-end and deterministically, without a database —
 * while mocking ONLY the storage layer, never protocol logic.
 *
 * Fidelity notes (mirrors Postgres behaviour on purpose):
 *  - `transactions.hash`, `blocks.id`, `balances.address` are primary keys and
 *    `block_transactions.transaction_hash` is UNIQUE → inserts that violate
 *    them throw sequelize's UniqueConstraintError, like the real driver.
 *  - DECIMAL(27,18) columns come back from pg as exact decimal STRINGS; the
 *    harness stores balances as strings and does all arithmetic with big.js,
 *    exactly like SQL numeric arithmetic (no float drift in storage).
 *  - UPDATE/INCREMENT on a missing row silently affects 0 rows.
 */

const ROOT = path.join(__dirname, '..', '..');

/** @returns {string} big.js exact decimal string */
const dec = (value) => new Big(value).toString();

function createLedger() {
    /** Mutable store. Cloned wholesale for transaction snapshots. */
    let store = {
        /** @type {Map<number, Object>} id -> block row */
        blocks: new Map(),
        /** @type {Map<string, Object>} hash -> transaction row */
        transactions: new Map(),
        /** @type {Array<{id: number, transactionHash: string, blockId: number}>} */
        blockTransactions: [],
        /** @type {Map<string, {address: string, balance: string, burned: string, affectedBlockId: number}>} */
        balances: new Map(),
        /** @type {Set<string>} pooled transaction hashes */
        pool: new Set(),
        nextBlockTransactionId: 1,
    };

    const cloneStore = (s) => structuredClone(s);

    /** @type {Array<Object>} snapshot stack for open transactions */
    const snapshots = [];

    /**
     * Fault injection: names registered here make the corresponding DAO call
     * throw once (then auto-clear). Used to prove atomicity: a crash mid-apply
     * must leave the chain state untouched after rollback.
     * @type {Set<string>}
     */
    const faults = new Set();
    const maybeFault = (name) => {
        if (faults.has(name)) {
            faults.delete(name);
            throw new Error(`injected fault: ${name}`);
        }
    };

    const fakeSequelize = {
        transaction: async () => {
            snapshots.push(cloneStore(store));
            let settled = false;
            return {
                commit: async () => {
                    if (settled) throw new Error('Transaction already settled');
                    settled = true;
                    snapshots.pop();
                },
                rollback: async () => {
                    if (settled) throw new Error('Transaction already settled');
                    settled = true;
                    store = snapshots.pop();
                },
            };
        },
    };

    // ---- join helpers ------------------------------------------------------

    const includedTransactionRows = () =>
        store.blockTransactions
            .filter((bt) => store.transactions.has(bt.transactionHash))
            .map((bt) => ({ bt, tx: store.transactions.get(bt.transactionHash) }));

    const attachTransactions = (blockRow) => ({
        ...structuredClone(blockRow),
        transactions: includedTransactionRows()
            .filter(({ bt }) => bt.blockId === blockRow.id)
            .map(({ tx }) => ({
                ...structuredClone(tx),
                amount: new Big(tx.amount).toNumber(),
                fee: new Big(tx.fee).toNumber(),
            })),
    });

    // ---- DAO: block --------------------------------------------------------

    const blockDao = {
        getLastBlock: async () => {
            let last = null;
            for (const block of store.blocks.values()) {
                if (!last || block.id > last.id) last = block;
            }
            return last ? structuredClone(last) : null;
        },
        getLastExternalBlock: async (publicKey) => {
            let last = null;
            for (const block of store.blocks.values()) {
                if (block.publicKey === publicKey) continue;
                if (!last || block.id > last.id) last = block;
            }
            return last ? structuredClone(last) : null;
        },
        getById: async (id) => {
            const block = store.blocks.get(id);
            return block ? structuredClone(block) : null;
        },
        getByIdWithTransactions: async (id) => {
            const block = store.blocks.get(id);
            return block ? attachTransactions(block) : null;
        },
        getByHash: async (hash) => {
            for (const block of store.blocks.values()) {
                if (block.hash === hash) return structuredClone(block);
            }
            return null;
        },
        create: async (blockData) => {
            maybeFault('blockDao.create');
            if (store.blocks.has(blockData.id)) {
                throw new UniqueConstraintError({
                    message: `duplicate block id ${blockData.id}`,
                });
            }
            store.blocks.set(blockData.id, structuredClone(blockData));
            return structuredClone(blockData);
        },
        getBlocksFrom: async (fromId, limit = BLOCKCHAIN_SETTINGS.SYNCHRONIZATION_BATCH) => {
            return [...store.blocks.values()]
                .filter((block) => block.id > fromId)
                .sort((a, b) => a.id - b.id)
                .slice(0, limit)
                .map(attachTransactions);
        },
        getTargetsSince: async (blockId) => {
            return [...store.blocks.values()]
                .filter((block) => block.id > blockId)
                .sort((a, b) => a.id - b.id)
                .map((block) => ({ target: block.target }));
        },
        getAverageTarget: async (limit = 10) => {
            const targets = [...store.blocks.values()]
                .sort((a, b) => b.id - a.id)
                .slice(0, limit)
                .map((block) => block.target);
            return targets.reduce((sum, t) => sum + t, 0) / targets.length;
        },
    };

    // ---- DAO: transaction --------------------------------------------------

    const isInBlock = (hash) =>
        store.blockTransactions.some((bt) => bt.transactionHash === hash);

    const transactionDao = {
        findOne: async (hash) => {
            const record = store.transactions.get(hash);
            return record ? structuredClone(record) : undefined;
        },
        create: async (transactionData) => {
            if (store.transactions.has(transactionData.hash)) {
                throw new UniqueConstraintError({
                    message: `duplicate transaction ${transactionData.hash}`,
                });
            }
            store.transactions.set(transactionData.hash, structuredClone(transactionData));
            return structuredClone(transactionData);
        },
        upsert: async (transactionData) => {
            const existed = store.transactions.get(transactionData.hash);
            if (existed) return structuredClone(existed);
            return transactionDao.create(transactionData);
        },
        findByHashes: async (hashes) =>
            hashes
                .filter((hash) => store.transactions.has(hash))
                .map((hash) => structuredClone(store.transactions.get(hash))),
        bulkCreate: async (transactionsData) => {
            for (const transactionData of transactionsData) {
                await transactionDao.create(transactionData);
            }
            return structuredClone(transactionsData);
        },
        bulkUpsert: async (transactions) => {
            const created = [];
            for (const transaction of transactions) {
                if (!store.transactions.has(transaction.hash)) {
                    created.push(await transactionDao.create(transaction));
                }
            }
            return created;
        },
        calculateBalance: async (address) => {
            let debit = new Big(0);
            let credit = new Big(0);
            let fee = new Big(0);
            for (const { tx } of includedTransactionRows()) {
                if (tx.to === address) debit = debit.plus(tx.amount);
                if (tx.from === address) {
                    credit = credit.plus(tx.amount);
                    fee = fee.plus(tx.fee);
                }
            }
            return debit.minus(credit).minus(fee).toNumber();
        },
        calculateBurnedBalance: async (address) => {
            let burned = new Big(0);
            for (const { tx } of includedTransactionRows()) {
                if (tx.from === address && tx.to === BLOCKCHAIN_SETTINGS.BURN_ADDRESS) {
                    burned = burned.plus(tx.amount);
                }
            }
            return burned.toNumber();
        },
        calculateBurnedBalanceUpToBlock: async (address, maxBlockId) => {
            let burned = new Big(0);
            for (const { bt, tx } of includedTransactionRows()) {
                if (bt.blockId > maxBlockId) continue;
                if (tx.from === address && tx.to === BLOCKCHAIN_SETTINGS.BURN_ADDRESS) {
                    burned = burned.plus(tx.amount);
                }
            }
            return burned.toNumber();
        },
        getByAddress: async (address, limit = 30, offset = 0, order = 'DESC', filters = {}) => {
            let rows = includedTransactionRows().filter(
                ({ tx }) =>
                    (filters.direction
                        ? tx[filters.direction] === address
                        : tx.from === address || tx.to === address) &&
                    (!filters.hash || tx.hash === filters.hash) &&
                    (!filters.maxId || true),
            );
            if (filters.maxId) rows = rows.filter(({ bt }) => bt.id < filters.maxId);
            rows.sort((a, b) => (order === 'DESC' ? b.bt.id - a.bt.id : a.bt.id - b.bt.id));
            return rows.slice(offset, offset + limit).map(({ tx, bt }) => ({
                ...structuredClone(tx),
                amount: new Big(tx.amount).toNumber(),
                fee: new Big(tx.fee).toNumber(),
                blockTransaction: { id: bt.id, blockId: bt.blockId },
            }));
        },
        getByHash: async (hash) => {
            const bt = store.blockTransactions.find((row) => row.transactionHash === hash);
            if (!bt) return null;
            const tx = store.transactions.get(hash);
            return { ...structuredClone(tx), blockTransaction: { blockId: bt.blockId } };
        },
        countByAddress: async (address) =>
            includedTransactionRows().filter(
                ({ tx }) => tx.from === address || tx.to === address,
            ).length,
    };

    // ---- DAO: block-transaction ---------------------------------------------

    const blockTransactionDao = {
        bulkCreate: async (transactionHashes, blockId) => {
            maybeFault('blockTransactionDao.bulkCreate');
            for (const transactionHash of transactionHashes) {
                if (store.blockTransactions.some((bt) => bt.transactionHash === transactionHash)) {
                    throw new UniqueConstraintError({
                        message: `transaction ${transactionHash} already linked to a block`,
                    });
                }
                store.blockTransactions.push({
                    id: store.nextBlockTransactionId++,
                    transactionHash,
                    blockId,
                });
            }
            return [];
        },
        getOneInOtherBlock: async (transactionHashes, blockId) => {
            const hashes = new Set(transactionHashes);
            const found = store.blockTransactions.find(
                (bt) => hashes.has(bt.transactionHash) && bt.blockId < blockId,
            );
            return found ? structuredClone(found) : null;
        },
        transactionSumFromBlockId: async (blockId) => {
            let sum = new Big(0);
            for (const { bt, tx } of includedTransactionRows()) {
                if (bt.blockId > blockId) sum = sum.plus(tx.amount);
            }
            const total = sum.toNumber();
            return total || 0;
        },
        uniqueAddressTransactionCountFromBlockId: async (blockId) => {
            const senders = new Set();
            for (const { bt, tx } of includedTransactionRows()) {
                if (bt.blockId > blockId) senders.add(tx.from);
            }
            return senders.size;
        },
        removeSinceBlockId: async (blockId) => {
            const doomedHashes = new Set(
                store.blockTransactions
                    .filter((bt) => bt.blockId > blockId)
                    .map((bt) => bt.transactionHash),
            );
            for (const hash of doomedHashes) store.transactions.delete(hash);
            store.blockTransactions = store.blockTransactions.filter(
                (bt) => bt.blockId <= blockId,
            );
            for (const id of [...store.blocks.keys()]) {
                if (id > blockId) store.blocks.delete(id);
            }
        },
    };

    // ---- DAO: balance --------------------------------------------------------

    const balanceDao = {
        getBalance: async (address) => {
            const record = store.balances.get(address);
            return record ? structuredClone(record) : null;
        },
        create: async (address, amount, burned, affectedBlockId) => {
            maybeFault('balanceDao.create');
            if (store.balances.has(address)) {
                throw new UniqueConstraintError({ message: `duplicate balance ${address}` });
            }
            const record = {
                address,
                balance: dec(amount),
                burned: dec(burned),
                affectedBlockId,
            };
            store.balances.set(address, record);
            return structuredClone(record);
        },
        changeBalance: async (address, amount, burned, affectedBlockId) => {
            maybeFault('balanceDao.changeBalance');
            const record = store.balances.get(address);
            if (!record) return undefined; // UPDATE ... WHERE misses: 0 rows, no error
            record.affectedBlockId = affectedBlockId;
            if (burned !== 0) record.burned = new Big(record.burned).plus(burned).toString();
            record.balance = new Big(record.balance).plus(amount).toString();
            return structuredClone(record);
        },
        updateBalances: async (address, balance, burned) => {
            const record = store.balances.get(address);
            if (!record) return [];
            record.balance = dec(balance);
            record.burned = dec(burned);
            return [structuredClone(record)];
        },
        flushBalancesFromBlock: async (blockId) => {
            for (const [address, record] of [...store.balances.entries()]) {
                if (record.affectedBlockId > blockId) store.balances.delete(address);
            }
        },
    };

    // ---- DAO: transaction-pool ------------------------------------------------

    const transactionPoolDao = {
        upsert: async (transactionHash) => {
            store.pool.add(transactionHash);
            return { transactionHash };
        },
        getTransactions: async (count) => {
            // Mirrors: SELECT DISTINCT ON (t.from) ... ORDER BY t.from, t.timestamp DESC
            const bySender = new Map();
            for (const hash of store.pool) {
                const tx = store.transactions.get(hash);
                if (!tx) continue;
                const current = bySender.get(tx.from);
                if (!current || tx.timestamp > current.timestamp) bySender.set(tx.from, tx);
            }
            return [...bySender.entries()]
                .sort(([a], [b]) => (a < b ? -1 : 1))
                .slice(0, count)
                .map(([, tx]) => structuredClone(tx));
        },
        dropTransactions: async (transactionHashes) => {
            for (const hash of transactionHashes) store.pool.delete(hash);
        },
        clear: async () => {
            store.pool.clear();
        },
    };

    // ---- DAO: peer (minimal; peer flood logic is tested separately) -----------

    const peerDao = {
        findByKey: async () => null,
        create: async (data) => structuredClone(data),
        update: async () => [0],
        updateByKey: async (key, data) => ({ key, ...data }),
        getServers: async () => [],
    };

    // ---- test-facing helpers ---------------------------------------------------

    return {
        blockDao,
        transactionDao,
        blockTransactionDao,
        balanceDao,
        transactionPoolDao,
        peerDao,
        fakeSequelize,
        /** Deep snapshot of the whole store, for state-unchanged assertions. */
        dump: () => cloneStore(store),
        /** Restores a previous dump (for arrival-order determinism tests). */
        restore: (snapshot) => {
            store = cloneStore(snapshot);
        },
        /** Makes the named DAO call throw once (atomicity fault injection). */
        injectFault: (name) => faults.add(name),
        /** Clears all pending injected faults (call between tests). */
        clearFaults: () => faults.clear(),
        /** Direct store access for seeding/inspection. */
        getStore: () => store,
        /** Sum of every cached balance row (exact decimal string). */
        cachedSupply: () => {
            let sum = new Big(0);
            for (const record of store.balances.values()) sum = sum.plus(record.balance);
            return sum.toString();
        },
        /** Exact on-chain balance recomputed from confirmed transactions. */
        chainBalance: (address) => {
            let sum = new Big(0);
            for (const bt of store.blockTransactions) {
                const tx = store.transactions.get(bt.transactionHash);
                if (!tx) continue;
                if (tx.to === address) sum = sum.plus(tx.amount);
                if (tx.from === address) sum = sum.minus(tx.amount).minus(tx.fee);
            }
            return sum.toString();
        },
        /** Every address seen on chain. */
        chainAddresses: () => {
            const addresses = new Set();
            for (const bt of store.blockTransactions) {
                const tx = store.transactions.get(bt.transactionHash);
                if (!tx) continue;
                addresses.add(tx.from);
                addresses.add(tx.to);
            }
            for (const block of store.blocks.values()) addresses.add(block.publicKey);
            return addresses;
        },
    };
}

/**
 * Installs the ledger as the storage layer via node:test module mocks.
 * MUST be called before requiring any source module that (transitively)
 * requires a DAO — DAOs bind Sequelize models at require time and would throw.
 *
 * @param {import('node:test').Mock<Function> | any} mock node:test top-level `mock` tracker
 * @param {ReturnType<typeof createLedger>} ledger
 */
function installLedgerMocks(mock, ledger) {
    const fakeDatabase = {
        getSequelize: () => ledger.fakeSequelize,
        isInited: () => true,
        init: async () => {},
        getModels: () => ({}),
        getModel: () => {
            throw new Error('Model access is not allowed in unit tests — use DAOs');
        },
    };
    mock.module(path.join(ROOT, 'databases/postgres/index.js'), {
        defaultExport: fakeDatabase,
        namedExports: fakeDatabase,
    });
    const daoMocks = {
        'block.dao.js': ledger.blockDao,
        'transaction.dao.js': ledger.transactionDao,
        'block-transaction.dao.js': ledger.blockTransactionDao,
        'balance.dao.js': ledger.balanceDao,
        'transaction-pool.dao.js': ledger.transactionPoolDao,
        'peer.dao.js': ledger.peerDao,
    };
    for (const [file, implementation] of Object.entries(daoMocks)) {
        mock.module(path.join(ROOT, 'databases/postgres/dao', file), {
            namedExports: implementation,
        });
    }
}

/**
 * Mocks the wallet module with a deterministic fixture key.
 * @param {any} mock node:test `mock` tracker
 * @param {import('hdkey')} keyPair
 */
function installWalletMock(mock, keyPair) {
    const walletObject = {
        getDefaultAddress: () => keyPair,
        generateAddress: () => keyPair,
    };
    mock.module(path.join(ROOT, 'wallet/index.js'), {
        namedExports: {
            init: async () => {},
            // forger/index.js destructures `{ wallet }` at require time.
            wallet: walletObject,
            getWallet: () => walletObject,
            getDefaultPrivateKey: () => keyPair.privateKey,
            getDefaultPublicKey: () => keyPair.publicKey.toString('hex'),
        },
    });
}

/**
 * Mocks p2p broadcast actions with call-recording spies.
 * @param {any} mock node:test `mock` tracker
 */
function installP2pActionsMock(mock) {
    const calls = { broadcastBlock: [], broadcastTransaction: [], syncRequest: [] };
    mock.module(path.join(ROOT, 'p2p/p2p-actions.js'), {
        namedExports: {
            broadcastBlock: (block, exclude) => calls.broadcastBlock.push({ block, exclude }),
            broadcastTransaction: (transaction, exclude) =>
                calls.broadcastTransaction.push({ transaction, exclude }),
            syncRequest: (socket, lastBlockId) => calls.syncRequest.push({ lastBlockId }),
            sendChain: () => {},
            sendStatus: () => {},
            broadcastStatus: () => {},
        },
    });
    return calls;
}

module.exports = { createLedger, installLedgerMocks, installWalletMock, installP2pActionsMock };
