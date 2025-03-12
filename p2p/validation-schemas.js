const { P2P_MESSAGE_TYPES } = require('../constants/p2p.constants');

const transaction = {
    type: 'object',
    properties: {
        hash: { type: 'string', minLength: 64, maxLength: 64 },
        from: { type: 'string', minLength: 66, maxLength: 66 },
        to: { type: 'string', minLength: 66, maxLength: 66 },
        amount: { type: 'number', minimum: 0.0000000001 },
        fee: { type: 'number', minimum: 0 },
        timestamp: { type: 'number', minimum: 0 },
        signature: { type: 'string', minLength: 128, maxLength: 128 },
    },
    required: ['hash', 'from', 'to', 'amount', 'fee', 'timestamp', 'signature'],
    additionalProperties: false,
};

const block = {
    type: 'object',
    properties: {
        id: { type: 'integer', minimum: 0 },
        timestamp: { type: 'number', minimum: 0 },
        target: { type: 'number', minimum: 0 },
        hash: { type: 'string', minLength: 64, maxLength: 64 },
        previousHash: { type: 'string', minLength: 64, maxLength: 64 },
        publicKey: { type: 'string', minLength: 66, maxLength: 66 },
        signature: { type: 'string', minLength: 128, maxLength: 128 },
        transactions: { type: 'array', items: transaction },
    },
    required: [
        'timestamp',
        'target',
        'hash',
        'previousHash',
        'publicKey',
        'signature',
        'transactions',
    ],
    additionalProperties: false,
};

module.exports = {
    [P2P_MESSAGE_TYPES.PEERS_REQUEST]: {
        type: 'object',
        properties: {
            number: { type: 'integer' },
        },
        required: ['number'],
        additionalProperties: false,
    },
    [P2P_MESSAGE_TYPES.PEERS_RESPONSE]: {
        type: 'array',
        items: { type: 'string', pattern: '^(ws|wss)://.*$' },
    },
    [P2P_MESSAGE_TYPES.NEW_TRANSACTION]: transaction,
    [P2P_MESSAGE_TYPES.NEW_BLOCK]: block,
    [P2P_MESSAGE_TYPES.SYNC_REQUEST]: {
        type: 'object',
        properties: {
            lastBlockId: { type: 'integer' },
        },
        required: ['lastBlockId'],
        additionalProperties: false,
    },
    [P2P_MESSAGE_TYPES.CHAIN]: {
        type: 'array',
        items: block,
    },
    [P2P_MESSAGE_TYPES.ID]: {
        type: 'object',
        properties: {
            id: {
                type: 'string',
                pattern:
                    '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$',
            },
        },
        required: ['id'],
        additionalProperties: false,
    },
    [P2P_MESSAGE_TYPES.PEER_GOSSIP]: {
        type: 'object',
        properties: {
            peer: {
                type: 'string',
                pattern: '^(ws|wss)://.*$',
            },
        },
        required: ['peer'],
        additionalProperties: false,
    },
};
