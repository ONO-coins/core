/**
 * Deterministic property-testing harness with zero dependencies.
 *
 * Every randomized test in this suite draws from a seeded PRNG (mulberry32), so
 * a failure is always reproducible: the assertion message contains the seed and
 * the iteration index, and re-running with the same seed replays the exact same
 * cases. Tests must never use Math.random() or Date.now() for generation.
 */

/**
 * @param {number} seed
 * @returns {() => number} uniform float in [0, 1)
 */
function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

class Rng {
    /** @param {number} seed */
    constructor(seed) {
        this.seed = seed;
        this.next = mulberry32(seed);
    }

    /** Uniform float in [0, 1). */
    float01() {
        return this.next();
    }

    /**
     * Uniform integer in [min, max] inclusive.
     * @param {number} min
     * @param {number} max
     */
    int(min, max) {
        return Math.floor(this.next() * (max - min + 1)) + min;
    }

    /** @param {number} [p] probability of true */
    bool(p = 0.5) {
        return this.next() < p;
    }

    /**
     * @template T
     * @param {Array<T>} arr
     * @returns {T}
     */
    pick(arr) {
        return arr[this.int(0, arr.length - 1)];
    }

    /**
     * Random lowercase hex string of exactly `len` chars.
     * @param {number} len
     */
    hex(len) {
        const chars = '0123456789abcdef';
        let out = '';
        for (let i = 0; i < len; i++) out += chars[this.int(0, 15)];
        return out;
    }

    /** @param {number} n */
    bytes(n) {
        const buf = Buffer.alloc(n);
        for (let i = 0; i < n; i++) buf[i] = this.int(0, 255);
        return buf;
    }

    /**
     * A positive monetary amount spanning many magnitudes (satoshi-like dust up
     * to the total capacity), rounded to at most 10 decimal places so it is
     * representable in the protocol's numeric domain.
     * @param {number} [max]
     */
    amount(max = 100_000_000) {
        const magnitude = this.int(-8, Math.floor(Math.log10(max)));
        const value = this.float01() * 9 * 10 ** magnitude + 10 ** magnitude;
        const rounded = Number(Math.min(value, max).toFixed(10));
        return rounded > 0 ? rounded : 10 ** -8;
    }

    /**
     * Random unicode string including astral-plane and control characters.
     * @param {number} len
     */
    unicode(len) {
        let out = '';
        for (let i = 0; i < len; i++) {
            const r = this.int(0, 3);
            if (r === 0) out += String.fromCharCode(this.int(0x20, 0x7e));
            else if (r === 1) out += String.fromCharCode(this.int(0x00, 0x1f));
            else if (r === 2) out += String.fromCharCode(this.int(0x80, 0xffff));
            else out += String.fromCodePoint(this.int(0x10000, 0x10ffff));
        }
        return out;
    }

    /**
     * A hostile "any JSON-ish value" generator for fuzzing: wrong types, deep
     * nesting, huge strings, numeric edge cases, prototype-pollution keys.
     * @param {number} [depth]
     * @returns {any}
     */
    anyValue(depth = 0) {
        const leaves = [
            () => null,
            () => this.bool(),
            () => this.int(-1e15, 1e15),
            () => this.float01() * 1e308,
            () => -this.float01() * 1e308,
            () => NaN,
            () => Infinity,
            () => -Infinity,
            () => '',
            () => this.hex(this.int(0, 200)),
            () => this.unicode(this.int(0, 50)),
            () => 'a'.repeat(this.int(0, 5000)),
            () => this.int(0, 1) === 0 ? undefined : {},
        ];
        if (depth >= 3) return this.pick(leaves)();
        const r = this.int(0, 9);
        if (r <= 6) return this.pick(leaves)();
        if (r === 7) {
            return Array.from({ length: this.int(0, 5) }, () => this.anyValue(depth + 1));
        }
        const obj = {};
        const keys = ['a', 'hash', 'from', 'to', 'amount', '__proto__', 'constructor', 'ยง'];
        for (let i = this.int(0, 4); i > 0; i--) {
            obj[this.pick(keys)] = this.anyValue(depth + 1);
        }
        return obj;
    }
}

/**
 * Runs `property` against `runs` generated cases. On the first violation it
 * throws an AssertionError carrying the seed, iteration and the offending case,
 * so the failure replays exactly.
 *
 * @template T
 * @param {{name: string, seed: number, runs?: number}} opts
 * @param {(rng: Rng) => T} generate
 * @param {(value: T, rng: Rng) => void} property assertion body (throws on violation)
 */
function forAll(opts, generate, property) {
    const runs = opts.runs ?? 500;
    for (let i = 0; i < runs; i++) {
        // Independent stream per case: replaying case N never depends on N-1.
        const rng = new Rng(opts.seed + i * 0x9e3779b9);
        let value;
        try {
            value = generate(rng);
            property(value, rng);
        } catch (error) {
            const shown = (() => {
                try {
                    return JSON.stringify(value);
                } catch {
                    return String(value);
                }
            })();
            error.message =
                `[property "${opts.name}" seed=${opts.seed} run=${i}/${runs}]\n` +
                `case: ${shown}\n` +
                error.message;
            throw error;
        }
    }
}

module.exports = { Rng, forAll, mulberry32 };
