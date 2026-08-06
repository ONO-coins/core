/**
 * Pins the process environment for deterministic tests. Must be required at the
 * very top of every test file, BEFORE any source module, because several source
 * modules read process.env at require time (wallet HD path, database config) and
 * crypto-utils reads TESTNET on every hash (network domain separation).
 */
process.env.TESTNET = 'false';
process.env.LOG_LEVEL = 'silent';
process.env.FORGING = 'false';
delete process.env.SECRET_PASSPHRASE;

// The pino logger is created at require time with level "info"; silence it so
// expected-failure paths under test do not spam the runner output.
require('../../managers/log.manager').setLevel('silent');

/**
 * A fixed "wall clock" second used across tests (well after the genesis
 * timestamp 1731330074). Tests that need Date.now() pin it via mock timers to
 * FIXED_NOW_MS so time-dependent consensus rules are reproducible.
 */
exports.FIXED_NOW_SECONDS = 1_750_000_000;
exports.FIXED_NOW_MS = exports.FIXED_NOW_SECONDS * 1000;
