require('../helpers/env');
const { describe, it, mock, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { FREQUENCY } = require('../../constants/models/peer.constants');
const { P2P_MESSAGE_TYPES } = require('../../constants/p2p.constants');

/**
 * Per-peer flood scoring (peer.service.messageEvent). This is the DoS guard:
 * it must throttle a flooding peer WITHOUT permanently blacklisting one that
 * briefly bursts, and only sever the socket on a sustained severe flood. The
 * EMA math is re-derived independently below.
 */

const ROOT = path.join(__dirname, '..', '..');

// Stateful in-memory peer, mocked at the DAO level.
const peerStore = new Map();
mock.module(path.join(ROOT, 'databases/postgres/index.js'), {
    namedExports: {
        getSequelize: () => ({ transaction: async () => ({ commit: async () => {}, rollback: async () => {} }) }),
        isInited: () => true,
    },
});
mock.module(path.join(ROOT, 'databases/postgres/dao/peer.dao.js'), {
    namedExports: {
        findByKey: async (key) => peerStore.get(key) ?? null,
        update: async (where, values) => {
            const peer = peerStore.get(where.key);
            if (peer) Object.assign(peer, values);
            return [peer ? 1 : 0];
        },
        create: async (data) => {
            peerStore.set(data.key, { ...data });
            return peerStore.get(data.key);
        },
        updateByKey: async (key, values) => {
            const peer = peerStore.get(key);
            if (peer) Object.assign(peer, values);
            return peer;
        },
        getServers: async () => [],
    },
});

const peerService = require('../../services/peer.service');
const state = require('../../state');

/**
 * Independent EMA reference: one message with the given interval, capped at the
 * DEFAULT ceiling — mirrors the production formula so drift is caught.
 */
function nextFrequency(prev, interval) {
    const raw = (prev * (FREQUENCY.MESSAGES_COUNT - 1) + interval) / FREQUENCY.MESSAGES_COUNT;
    return Math.min(raw, FREQUENCY.DEFAULT);
}

/**
 * Replays `count` messages arriving `interval` ms apart against a fresh peer
 * and returns the last verdict, driving a mocked wall clock.
 */
async function flood({ t, count, interval, messageType = P2P_MESSAGE_TYPES.NEW_BLOCK, startFrequency = FREQUENCY.DEFAULT }) {
    const key = 'ws://peer:1';
    let now = 1_000_000_000_000;
    // Tolerate being called multiple times within one test.
    try {
        t.mock.timers.enable({ apis: ['Date'], now });
    } catch {
        t.mock.timers.setTime(now);
    }
    peerStore.clear();
    peerStore.set(key, {
        key,
        messageFrequency: startFrequency,
        lastSeen: new Date(now),
        connected: true,
    });

    let verdict;
    for (let i = 0; i < count; i++) {
        now += interval;
        t.mock.timers.setTime(now);
        verdict = await peerService.messageEvent(key, messageType);
    }
    return { verdict, frequency: peerStore.get(key).messageFrequency };
}

describe('messageEvent — EMA flood scoring', () => {
    beforeEach(() => {
        state.init();
        state.setState(state.KEYS.SYNCING, false);
    });

    it('a single well-spaced message is never throttled', async (t) => {
        const { verdict } = await flood({ t, count: 1, interval: FREQUENCY.DEFAULT });
        assert.deepEqual(verdict, { ignore: false, close: false });
    });

    it('updates the frequency by the exact EMA formula (independent check)', async (t) => {
        const { frequency } = await flood({ t, count: 1, interval: 0 });
        assert.equal(frequency, nextFrequency(FREQUENCY.DEFAULT, 0));
    });

    it('a sustained zero-interval flood eventually drops messages (ignore) then disconnects (close)', async (t) => {
        // Independent thresholds: freq decays as DEFAULT * (0.99)^n toward 0.
        // ignore when freq < MIN(500); close when freq < DISCONNECT(5).
        const beforeIgnore = await flood({ t, count: 200, interval: 0 });
        // 200 messages: 10000*0.99^200 ≈ 1339 — still above MIN, not yet ignored.
        assert.equal(beforeIgnore.verdict.ignore, false);

        const deepFlood = await flood({ t, count: 400, interval: 0 });
        // 400 messages: 10000*0.99^400 ≈ 179 — below MIN(500): ignored, not yet closed.
        assert.equal(deepFlood.verdict.ignore, true);
        assert.equal(deepFlood.verdict.close, false);

        const severe = await flood({ t, count: 800, interval: 0 });
        // 800 messages: ≈ 3.2 — below DISCONNECT(5): the socket is severed.
        assert.equal(severe.verdict.close, true);
    });

    it('a peer that bursts then slows RECOVERS (no permanent blacklist)', async (t) => {
        // Regression guard for review M5: the EMA must climb back up once the
        // peer resumes normal spacing, instead of being stuck below the floor.
        const key = 'ws://burst:1';
        let now = 1_000_000_000_000;
        t.mock.timers.enable({ apis: ['Date'], now });
        peerStore.clear();
        peerStore.set(key, { key, messageFrequency: 100, lastSeen: new Date(now), connected: true });

        // Recover with well-spaced (interval = DEFAULT) messages.
        let verdict;
        for (let i = 0; i < 500; i++) {
            now += FREQUENCY.DEFAULT;
            t.mock.timers.setTime(now);
            verdict = await peerService.messageEvent(key, P2P_MESSAGE_TYPES.NEW_BLOCK);
        }
        assert.ok(peerStore.get(key).messageFrequency > FREQUENCY.MIN, 'peer never recovered above the throttle floor');
        assert.equal(verdict.ignore, false);
        assert.equal(verdict.close, false);
    });

    it('SYNC_REQUEST is held to a lower floor (sync bursts are legitimate)', async (t) => {
        // At a frequency between SYNCING_MIN(50) and MIN(500), a normal message
        // is ignored but a SYNC_REQUEST is allowed — syncing is bursty by design.
        const key = 'ws://sync:1';
        let now = 1_000_000_000_000;
        t.mock.timers.enable({ apis: ['Date'], now });
        peerStore.clear();
        peerStore.set(key, { key, messageFrequency: 100, lastSeen: new Date(now), connected: true });
        const blockVerdict = await peerService.messageEvent(key, P2P_MESSAGE_TYPES.NEW_BLOCK);
        assert.equal(blockVerdict.ignore, true, 'a normal message at freq ~100 should be throttled');

        peerStore.get(key).messageFrequency = 100;
        peerStore.get(key).lastSeen = new Date(now);
        const syncVerdict = await peerService.messageEvent(key, P2P_MESSAGE_TYPES.SYNC_REQUEST);
        assert.equal(syncVerdict.ignore, false, 'a sync request at freq ~100 should be allowed');
    });

    it('while SYNCING, all flood checks are bypassed', async (t) => {
        state.setState(state.KEYS.SYNCING, true);
        const { verdict } = await flood({ t, count: 1000, interval: 0 });
        assert.deepEqual(verdict, { ignore: false, close: false });
        state.setState(state.KEYS.SYNCING, false);
    });

    it('an unknown peer is neither ignored nor closed (nothing to score yet)', async (t) => {
        t.mock.timers.enable({ apis: ['Date'], now: 1_000_000_000_000 });
        peerStore.clear();
        const verdict = await peerService.messageEvent('ws://ghost:1', P2P_MESSAGE_TYPES.NEW_BLOCK);
        assert.deepEqual(verdict, { ignore: false, close: false });
    });
});
