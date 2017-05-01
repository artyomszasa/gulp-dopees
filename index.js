const through = require('through2'),
    path = require('path'),
    babel = require("babel-core"),
    applySourceMap = require('vinyl-sourcemaps-apply');

const sequentialFlatten = function (source, mapping) {
    let results = [];
    const f = i => {
        if (i === source.length) {
            return Promise.resolve(results);
        }
        return mapping(source[i]).then(res => {
            results = results.concat(res);
            return f(i + 1);
        });
    };
    return f(0);
};

class Step {
    constructor (fun) {
        this.fun = fun;
    }
    chain (next) {
        if (!(next instanceof Step)) {
            throw new TypeError("next must be instance of Step");
        }
        return new Step((chunk, enc) => {
            return this.fun(chunk, enc).then(results => {
                const chunks = [].concat(results || []);
                return sequentialFlatten(chunks, next.fun);
            });
        });
    }
};

const emplaceConstants = function emplaceConstants (babel) {
    return {
        visitor: {
            MemberExpression (path, state) {
                const node = path.node;
                if (state.opts && node.object.name === "dopeVars") {
                    var value = state.opts[node.property.name];
                    if (undefined !== value) {
                        const t = babel.types;
                        let newNode;
                        if (null === value) {
                            newNode = t.nullLiteral();
                        } else if ("string" === typeof value) {
                            newNode = t.stringLiteral(value);
                        } else if ("number" === typeof value) {
                            newNode = t.numericLiteral(value);
                        } else if ("boolean" === typeof value) {
                            newNode = t.booleanLiteral(value);
                        } else {
                            throw new Error(`Unsupported value for compile time argument ${node.property.name}`);
                        }
                        path.replaceWith(newNode);
                    }
                }
            }
        }
    };
};

const mkFilter = predicate => new Step((chunk, enc) => new Promise ((resolve, reject) => {
    try {
        if (predicate(chunk, enc)) {
            resolve(chunk);
        }
        resolve();
    } catch (e) {
        reject(e);
    }
}));

const mkChooseFirst = () => {
    const files = new Set();
    return mkFilter(file => {
        if (!files.has(file.relative)) {
            files.add(file.relative);
            return true;
        }
        return false;
    });
};

const mkAddTargets = (pversion, prefix, targets) => new Step(file => pversion.then(version => {
    if ('api.js' === file.relative) {
        file.dopeTarget = 'es5';
        file.initBabelConfig = config => {
            config.plugins = config.plugins || [];
            config.plugins.unshift([emplaceConstants, {
                version: version,
                prefix: prefix || "",
                isES6: -1 !== targets.indexOf('es6')
            }]);
        };
        return file;
    } else {
        return targets.map(target => {
            const newFile = file.clone({
                contents: !file.isBuffer()
            });
            newFile.path = path.join(file.base, `${target}_${version}`, file.relative);
            newFile.dopeTarget = target;
            return newFile;
        });
    }
}));

const getFileContents = (file, enc) => new Promise(resolve => {
    if (file.isBuffer()) {
        resolve(file.contents.toString(enc));
    } else {
        throw new Error(`Unsupported file type for ${file.relative}`);
    }
});

const babelConfigs = {
    "ES5Debug": {
        presets: ["es2015"],
        sourceMaps: true,
        code: true,
        ast: false,
        comments: false
    },
    "ES5Release": {
        presets: ["babili", "es2015"],
        sourceMaps: true,
        code: true,
        ast: false,
        comments: false
    },
    "ES5Production": {
        presets: ["babili", "es2015"],
        sourceMaps: false,
        code: true,
        ast: false,
        comments: false
    },
    "ES6Debug": {
        presets: [],
        sourceMaps: true,
        code: true,
        ast: false,
        comments: false
    },
    "ES6Release": {
        presets: ["babili"],
        sourceMaps: true,
        code: true,
        ast: false,
        comments: false
    },
    "ES6Production": {
        presets: ["babili"],
        sourceMaps: false,
        code: true,
        ast: false,
        comments: false
    }
};

const mkBabel = mode => new Step((file, enc) => getFileContents(file, enc).then(sourceCode => {
    const config = Object.assign({}, babelConfigs[file.dopeTarget.toUpperCase() + mode], { filename: file.path });
    if (file.initBabelConfig) {
        file.initBabelConfig(config);
    }
    const res = babel.transform(sourceCode, config);
    if (!res) {
        throw new Error(`Running babel on ${file.path} failed.`);
    }
    file.contents = new Buffer(res.code, enc);
    if (res.srcMap && file.sourceMap) {
        applySourceMap(file, res.srcMap);
    }
    return file;
}));

/**
 * Compiles javascript files with respect to the dopees packaging rules.
 * Dopees package assumes that sources contains single api.js (usually dopees/api path).
 * Furthermore file order matters -- if multiple scripts have same relative path, only the
 * first one is used, other files are ignored.
 *
 * Dopees uses babel to polyfill missing features. Three compilation configurations are supported:
 * * Debug - polyfill only, no tranformations applied, source maps are generated. Thid configuration is perfect for
 *   debugging code.
 * * Release - output is polyfilled and minified, source maps are generated. Usefull to debug final code;
 * * Production - output is polyfilled and minified, source maps are not generated. Intended to be used in production.
 *
 * @param {object} [options] - Compilation options.
 * @param {string} [options.prefix] - Base URI to use when loading components.
 * @param {string} [options.configuration] - Configuration to use, if not specified _CONFIGURATION_ environment
 * variable is used.
 * @param {string|string[]} [options.targets=es5] - Compilation targets. Supported values: _es5_, _es6_.
 * @param {function} [options.version] - Factory function to generate versioned folder names. May either return value
 * or Promise.
 * @returns {stream} gulp compatible stream.
 */
function dope (options) {
    const opts = Object.assign({}, options);
    const pversion = Promise.resolve(opts.version && opts.version() || Date.now());
    const targets = [].concat(opts.targets || 'es5');
    const mode = options.mode || options.configuration || process.env.CONFIGURATION || 'Debug';

    const transformation = mkChooseFirst()
        .chain(mkAddTargets(pversion, opts.prefix, targets))
        .chain(mkBabel(mode))
        .fun;

    return through.obj(function (file, enc, callback) {
        transformation(file, enc).then(results => {
            [].concat(results).forEach(file => {
                this.push(file);
            });
            callback();
        }, err => callback(err));
    });
};
module.exports = dope;