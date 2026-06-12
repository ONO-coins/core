// const secp256k1 = require('secp256k1');
const crypto = require('crypto');
const secp256k1 = require('secp256k1');

exports.hash = (text) => crypto.createHash('sha256').update(text).digest('hex');

exports.checkHash = (text, hash) => crypto.createHash('sha256').update(text).digest('hex') === hash;

/**
 * Domain-separated, unambiguous hash of selected object fields. Each field is
 * emitted as `name=value` and joined with a `|` delimiter that cannot occur in the
 * values (hex / decimal / integers), so two different field sets can never produce
 * the same preimage (the old delimiter-free concatenation was only collision-free
 * by accident). A `domain` tag ("transaction" vs "block") and the network prevent a
 * transaction preimage from ever equalling a block preimage, or a testnet item a
 * mainnet one (crypto review).
 * @param {string} domain
 * @param {Array<string>} params
 * @param {Object} obj
 * @returns {string}
 */
exports.generateDomainHash = (domain, params, obj) => {
    const network = process.env.TESTNET === 'true' ? 'testnet' : 'mainnet';
    const sortedParams = params.toSorted();
    const parts = sortedParams.map((param) => `${param}=${String(obj[param])}`);
    return this.hash([domain, network, ...parts].join('|'));
};

exports.verifySignature = (hash, signature, publicKey) => {
    try {
        const signatureBuffer = Buffer.from(signature, 'hex');
        // Reject non-canonical (high-S) signatures to remove ECDSA malleability. Our
        // signer uses RFC6979 and already produces low-S, so honest signatures pass;
        // a third party can no longer mint a second valid signature for the same data.
        const normalized = Buffer.from(
            secp256k1.signatureNormalize(Uint8Array.from(signatureBuffer)),
        );
        if (!normalized.equals(signatureBuffer)) return false;
        return secp256k1.ecdsaVerify(
            Uint8Array.from(signatureBuffer),
            Buffer.from(hash, 'hex'),
            Buffer.from(publicKey, 'hex'),
        );
    } catch (error) {
        return false;
    }
};
