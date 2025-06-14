/**
 * @typedef {import('constants/p2p.constants').P2P_MESSAGE_TYPES} P2P_MESSAGE_TYPES
 */

const sockets = new Map();

exports.getSockets = () => {
    return sockets;
};

/**
 * @returns {number}
 */
exports.getSize = () => {
    return sockets.size;
};

/**
 * @returns {Array<string>}
 */
exports.getKeys = () => {
    return Array.from(sockets.keys());
};

/**
 * @returns {Array<string>}
 */
exports.getServerKeys = () => {
    const keys = this.getKeys();
    return keys.filter((key) => key.startsWith('ws'));
};

/**
 * @returns {number}
 */
exports.getServerSize = () => {
    const keys = this.getServerKeys();
    return keys.length;
};

/**
 *
 * @param {string} id
 * @returns {boolean}
 */
exports.checkId = (id) => {
    return sockets.has(id);
};

/**
 * @param {string} id
 */
exports.delete = (id) => {
    sockets.delete(id);
};

/**
 * @param {P2P_MESSAGE_TYPES} type
 * @param {Object} data
 * @param {Array<string>} [ignoreKeys]
 * @returns {void}
 */
exports.broadcastMessage = (type, data, ignoreKeys = []) => {
    [...sockets.keys()].forEach((key) => {
        if (ignoreKeys.includes(key)) return;
        const socket = sockets.get(key);
        try {
            socket.send(JSON.stringify({ type, data }));
        } catch (err) {
            socket.close();
        }
    });
};
