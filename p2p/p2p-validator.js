const { Ajv } = require('ajv');
const schemas = require('./validation-schemas');

// @ts-ignore
const ajv = new Ajv({ coerceTypes: 'number' });
const validators = new Map();

exports.init = () => {
    Object.keys(schemas).map((key) => {
        const validator = ajv.compile(schemas[key]);
        validators.set(key, validator);
    });
};

/**
 * @param {Object} message
 * @param {string} message.type
 * @param {Object} message.data
 * @returns {boolean}
 */
exports.validateMessage = (message) => {
    const validate = validators.get(message.type);
    if (!validate) return false;

    const valid = validate(message.data);
    return valid;
};
