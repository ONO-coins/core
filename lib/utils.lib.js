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

/**
 * @param {Array<string>} urls
 * @returns {Array<string>}
 */
exports.filterLocalUrls = (urls) => {
    const blockedPatterns = [
        /localhost/i, // 'localhost' (case-insensitive)
        // The ENTIRE 127.0.0.0/8 block is loopback, not just 127.0.0.1 — a peer
        // advertising 127.0.0.2 (or the IPv4-mapped ::ffff:127.x form, whose
        // textual spelling contains a 127.x.x.x) must be filtered too.
        /127(?:\.\d{1,3}){3}/,
        /(?<![\d.])0\.0\.0\.0(?![\d.])/, // 0.0.0.0 unspecified / self
        /\[?::1\]?/, // IPv6 loopback (with or without brackets)
    ];

    return urls.filter((url) => !blockedPatterns.some((pattern) => pattern.test(url)));
};
