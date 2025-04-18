const fs = require('fs');
const path = require('path');
const pg = require('pg');
const { Sequelize, DataTypes } = require('sequelize');

pg.defaults.parseInt8 = true;

/**
 * @typedef {import('pino').Logger} Logger
 * @typedef {import('sequelize').Model} Model
 * @typedef {import('sequelize').Options} Options
 * @typedef {import('sequelize').ModelStatic<Model>} ModelStatic
 */

class PgDatabase {
    #modelsDir;
    #sequelize;
    #force = false;
    #models = {};
    #inited = false;

    /**
     * @param {Options} config
     * @param {string} modelsDir
     * @param {Logger} logger
     * @param {boolean} force
     */
    constructor(config, modelsDir, logger, force) {
        this.#modelsDir = modelsDir;
        this.#sequelize = new Sequelize(config);
        this.logger = logger;
        this.#force = force;
        if (this.#force)
            logger.warn(
                'Your database will be force synced! Change DATABASE_FORCE_SYNC=false to avoid it.',
            );
    }

    async init() {
        if (this.#inited) return;

        fs.readdirSync(this.#modelsDir)
            .filter((file) => {
                return file.indexOf('.') !== 0 && file.slice(-3) === '.js';
            })
            .forEach((file) => {
                const model = require(path.join(this.#modelsDir, file))(this.#sequelize, DataTypes);
                this.#models[model.name] = model;
            });

        Object.keys(this.#models).forEach((modelName) => {
            if (this.#models[modelName].associate) {
                this.#models[modelName].associate(this.#models);
            }
        });

        await this.#sequelize.sync({ force: this.#force }).catch((err) => this.logger.fatal(err));

        this.#inited = true;
    }

    getSequelize() {
        return this.#sequelize;
    }

    isInited() {
        return this.#inited;
    }

    getModels() {
        return this.#models;
    }

    /**
     * @param {string} name
     */
    getModel(name) {
        const model = this.#models[name];
        if (model) return model;
        throw new Error(`No such model: ${name}`);
    }
}

module.exports = PgDatabase;
