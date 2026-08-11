require('../helpers/env');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const utilsLib = require('../../lib/utils.lib');

/**
 * Address/URL normalization. These feed peer identity and connection dialing;
 * a normalization mismatch either splits a peer into two identities (dedup
 * failure) or lets a blocked address through.
 */

describe('toWsAddress — peer URL normalization', () => {
    it('adds ws:// to a bare host:port', () => {
        assert.equal(utilsLib.toWsAddress('1.2.3.4:5000'), 'ws://1.2.3.4:5000');
        assert.equal(utilsLib.toWsAddress('node.example:5000'), 'ws://node.example:5000');
    });

    it('maps http→ws and https→wss (scheme preservation)', () => {
        assert.equal(utilsLib.toWsAddress('http://host:1'), 'ws://host:1');
        assert.equal(utilsLib.toWsAddress('https://host:1'), 'wss://host:1');
    });

    it('leaves already-ws/wss addresses unchanged (idempotent)', () => {
        assert.equal(utilsLib.toWsAddress('ws://host:1'), 'ws://host:1');
        assert.equal(utilsLib.toWsAddress('wss://host:1'), 'wss://host:1');
        // Idempotency: normalizing twice equals normalizing once — required so
        // the same peer never becomes two socket-map identities.
        for (const input of ['host:1', 'http://host:1', 'https://host:1', 'wss://host:1']) {
            assert.equal(utilsLib.toWsAddress(utilsLib.toWsAddress(input)), utilsLib.toWsAddress(input));
        }
    });

    it('is case-insensitive on the scheme', () => {
        assert.equal(utilsLib.toWsAddress('HTTP://host:1'), 'ws://host:1');
        assert.equal(utilsLib.toWsAddress('HTTPS://host:1'), 'wss://host:1');
    });
});

describe('filterLocalUrls — loopback SSRF/self-dial guard', () => {
    it('removes localhost / 127.0.0.1 / ::1 in the obvious forms', () => {
        const input = [
            'ws://localhost:1',
            'ws://127.0.0.1:1',
            'ws://[::1]:1',
            'ws://198.51.100.5:1',
            'ws://peer.example:1',
        ];
        assert.deepEqual(utilsLib.filterLocalUrls(input), ['ws://198.51.100.5:1', 'ws://peer.example:1']);
    });

    it('is case-insensitive for localhost', () => {
        assert.deepEqual(utilsLib.filterLocalUrls(['ws://LOCALHOST:1']), []);
    });

    it('catches the full loopback range: 127.0.0.0/8, 0.0.0.0, and IPv4-mapped forms', () => {
        // Hardened: the whole 127/8 block and 0.0.0.0 are now filtered, closing
        // the self-dial / SSRF gap where a peer advertised 127.0.0.2 or 0.0.0.0.
        const sneaky = [
            'ws://127.0.0.2:1',
            'ws://127.255.255.254:1',
            'ws://0.0.0.0:1',
            'ws://[::ffff:127.0.0.1]:1',
            'ws://203.0.113.9:1', // genuinely remote — must survive
        ];
        assert.deepEqual(utilsLib.filterLocalUrls(sneaky), ['ws://203.0.113.9:1']);
    });

    it('does not over-filter non-loopback addresses that merely contain a 0 or 127', () => {
        // 10.0.0.0 (private, not loopback) and 8.127.0.0-style hosts must NOT be
        // dropped by the 0.0.0.0 / 127 patterns.
        const remote = ['ws://10.0.0.5:1', 'ws://198.51.100.0:1', 'ws://212.7.0.9:1'];
        assert.deepEqual(utilsLib.filterLocalUrls(remote), remote);
    });
});

describe('getIpV4 — IPv4-mapped IPv6 unwrapping', () => {
    it('strips the ::ffff: prefix and leaves plain addresses alone', () => {
        assert.equal(utilsLib.getIpV4('::ffff:203.0.113.5'), '203.0.113.5');
        assert.equal(utilsLib.getIpV4('203.0.113.5'), '203.0.113.5');
        assert.equal(utilsLib.getIpV4('::1'), '::1');
    });
});
