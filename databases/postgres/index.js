const path = require('path');
const { logger } = require('../../managers/log.manager');
const Postgres = require('../../constructors/postgres.constructor');

/**
 * @typedef {import('sequelize').Options} Options
 */

/**
 * @type {Options}
 */
const config = {
    database: process.env.DATABASE_NAME,
    username: process.env.DATABASE_USERNAME,
    password: process.env.DATABASE_PASSWORD,
    host: process.env.DATABASE_HOST,
    dialect: 'postgres',
    logging: process.env.DATABASE_LOGGING === 'true',
};

const force = process.env.DATABASE_FORCE_SYNC === 'true';

const modelsDir = path.join(__dirname, '/models');
const database = new Postgres(config, modelsDir, logger, force);

module.exports = database;
