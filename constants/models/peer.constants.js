exports.TABLE_NAME = 'peers';

exports.MODEL_NAME = 'peer';

exports.PEER_TYPES = {
    SERVER: 'server',
    CLIENT: 'client',
};

exports.FREQUENCY = {
    MESSAGES_COUNT: 100,
    DEFAULT: 10_000,
    MIN: 500,
    SYNCING_MIN: 50,
};
