require('../helpers/env');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const state = require('../../state');

/**
 * The in-memory state singleton coordinates the forger, sync logic and block
 * processing. Its invariants are small but load-bearing: a stale PROCESSING or
 * SYNCING flag wedges the node.
 */

describe('state module', () => {
    it('init sets the documented defaults and a fresh UUID node id', () => {
        state.init();
        assert.equal(state.getState(state.KEYS.SYNCING), false);
        assert.equal(state.getState(state.KEYS.SYNCHRONIZED), true);
        assert.equal(state.getState(state.KEYS.CHAIN_PROCESSING), false);
        assert.equal(state.getState(state.KEYS.IMMUTABLE_BLOCK_ID), 0);
        assert.equal(state.getState(state.KEYS.FORGER_PREDICTED_TIMESTAMP), 0);
        assert.match(
            state.getState(state.KEYS.NODE_ID),
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
            'NODE_ID is not a v4 UUID',
        );
    });

    it('FORGING reflects the environment flag at init time', () => {
        process.env.FORGING = 'true';
        state.init();
        assert.equal(state.getState(state.KEYS.FORGING), true);
        process.env.FORGING = 'false';
        state.init();
        assert.equal(state.getState(state.KEYS.FORGING), false);
    });

    it('each init issues a distinct node id (no cross-restart identity reuse)', () => {
        state.init();
        const first = state.getState(state.KEYS.NODE_ID);
        state.init();
        assert.notEqual(state.getState(state.KEYS.NODE_ID), first);
    });

    it('set/get round-trips arbitrary values by key', () => {
        state.setState(state.KEYS.PROCESSING_BLOCK_ID, 42);
        assert.equal(state.getState(state.KEYS.PROCESSING_BLOCK_ID), 42);
        state.setState(state.KEYS.PROCESSING_BLOCK_ID, 0);
        assert.equal(state.getState(state.KEYS.PROCESSING_BLOCK_ID), 0);
    });

    it('reading an unknown key yields undefined (no throw)', () => {
        assert.equal(state.getState('nonexistent-key'), undefined);
    });
});
