/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
exports.sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {string} ip
 * @returns {string}
 */
exports.getIpV4 = (ip) => {
    if (ip.startsWith('::ffff:')) return ip.substring(7);
    return ip;
};

/**
 * @param {string} address
 * @returns {string}
 */
exports.toWsAddress = (address) => {
    if (!/^https?:\/\//i.test(address) && !/^wss?:\/\//i.test(address)) {
        return 'ws://' + address;
    }

    if (/^https:\/\//i.test(address)) {
        return 'wss://' + address.slice(8);
    }
    if (/^http:\/\//i.test(address)) {
        return 'ws://' + address.slice(7);
    }

    return address;
};
