const fs = require('fs'),
    assert = require('assert');

class CacheEntry {
    constructor (mtime, variables, result) {
        this.mtime = mtime;
        this.variables = variables;
        this.result = result;
    }
}

const eqq = (a, b) => {
    try {
        assert.deepStrictEqual(a || {}, b || {});
        return true;
    } catch (e) {
        return false;
    }
};

module.exports = class Cache {
    constructor () {
        this.cache = {};
    }
    validateEntry (entry, path, variables) {
        return new Promise((resolve, reject) => {
            fs.stat(path, (err, stats) => {
                if (err) {
                    reject(err);
                } else {
                    const mtime = stats.mtime.getTime();
                    if (entry && entry.mtime === mtime && eqq(entry.variables, variables)) {
                        resolve(entry);
                    } else {
                        resolve(new CacheEntry(mtime, variables, null));
                    }
                }
            });
        });
    }
    getOrAdd (path, mode, opts, func) {
        this.cache[path] = this.cache[path] || {};
        return this.validateEntry(this.cache[path][mode], path, opts.variables || {})
            .then(entry => {
                this.cache[path][mode] = entry;
                if (!entry.result) {
                    entry.result = func();
                }
                return entry.result;
            });
    }
};