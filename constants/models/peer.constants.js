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
    // Average inter-message interval (ms) below which a peer is a sustained
    // flooder and gets disconnected. Above this we only drop the offending
    // message and let the peer recover (review M5).
    DISCONNECT: 5,
};
