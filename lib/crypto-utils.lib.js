// const secp256k1 = require('secp256k1');
const crypto = require('crypto');
const secp256k1 = require('secp256k1');

exports.hash = (text) => crypto.createHash('sha256').update(text).digest('hex');

exports.checkHash = (text, hash) => crypto.createHash('sha256').update(text).digest('hex') === hash;

exports.generateHashFromObjectParams = (params, obj) => {
    const sortedParams = params.toSorted();
    const hashStr = sortedParams.map((param) => String(obj[param])).join('');
    return this.hash(hashStr);
};

exports.verifySignature = (hash, signature, publicKey) => {
    try {
        return secp256k1.ecdsaVerify(
            Buffer.from(signature, 'hex'),
            Buffer.from(hash, 'hex'),
            Buffer.from(publicKey, 'hex'),
        );
    } catch (error) {
        return false;
    }
};
