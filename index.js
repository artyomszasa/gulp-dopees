const through = require('through2'),
    path = require('path'),
    babel = require("babel-core"),
    vfs = require('vinyl-fs'),
    applySourceMap = require('vinyl-sourcemaps-apply'),
    Readable = require('stream').Readable;

const getFileContents = (file, enc) => new Promise(resolve => {
    if (file.isBuffer()) {
        resolve(file.contents.toString(enc));
    } else {
        throw new Error(`Unsupported file type for ${file.relative}`);
    }
});

const noCache = {
    getOrAdd (_, __, ___, func) {
        return Promise.resolve(func());
    }
};

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
        Promise.resolve(predicate(chunk, enc))
            .then(success => resolve(success ? chunk : undefined))
            .then(null, reject);
    } catch (e) {
        reject(e);
    }
}));

const mkCollectVariables = map => mkFilter(file => {
    if ('.json' === path.extname(file.relative)) {
        let rel = file.relative.substr(0, file.relative.length - 5);
        if (rel.endsWith('global')) {
            rel = path.basename(rel);
        }
        if (!map.has(rel)) {
            return getFileContents(file).then(contents => {
                map.add(rel, JSON.parse(contents));
                return false;
            });
        }
        return false;
    }
    return true;
});

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
        file.dopeVariables = {
            version: version,
            prefix: prefix || "",
            isES6: -1 !== targets.indexOf('es6')
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

const mkBabel = (mode, variables, cache) => new Step((file, enc) => getFileContents(file, enc).then(sourceCode => {
    const babelMode = file.dopeTarget.toUpperCase() + mode;
    const vars = Object.assign(variables.get(file.relative) || {}, file.dopeVariables);
    return cache.getOrAdd(file.history && file.history[0] || file.path, babelMode, { variables: vars }, () => {
        const config = Object.assign({}, babelConfigs[babelMode], { filename: file.path });
        if (Object.keys(vars).length) {
            config.plugins = config.plugins || [];
            config.plugins.unshift([emplaceConstants, vars]);
        }
        const res = babel.transform(sourceCode, config);
        if (!res) {
            throw new Error(`Running babel on ${file.path} failed.`);
        }
        return res;
    }).then(res => {
        file.contents = new Buffer(res.code, enc);
        if (res.srcMap && file.sourceMap) {
            applySourceMap(file, res.srcMap);
        }
        return file;
    });
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
 * @param {Cache} [options.cache] - Shared cache object to use. If not specified, all files are regenerated within each
 * iteration.
 * @returns {stream} gulp compatible stream.
 */
function dope (options) {
    const opts = Object.assign({}, options);
    const pversion = Promise.resolve(opts.version && opts.version() || Date.now());
    const targets = [].concat(opts.targets || 'es5');
    const mode = options.mode || options.configuration || process.env.CONFIGURATION || 'Debug';
    const cache = opts.cache || noCache;

    const variables = new Map();

    const transformation = mkChooseFirst()
        .chain(mkCollectVariables(variables))
        .chain(mkAddTargets(pversion, opts.prefix, targets))
        .chain(mkBabel(mode, variables, cache))
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

dope.src = (root, ...args) => {

    const components = new Set();

    const configCollector = through.obj(function (file, enc, callback) {
        const readConfig = config => {
            if (Array.isArray(config)) {
                config.forEach(readConfig);
            } else {
                if (!config.name) {
                    throw new Error('component name must be specified');
                }
                if (components.has(config.name)) {
                    throw new Error(`duplicate component name: ${config.name}`);
                }
                this.push({
                    name : config.name,
                    path: config.path ? (path.isAbsolute(config.path) ? config.path : path.join(path.dirname(file.path), config.path)) : path.dirname(file.path)
                });
            }
        };
        getFileContents(file, enc).then(contents => {
            const config = JSON.parse(contents);
            readConfig(config);
            callback();
        });
    });

    class ArrayStream extends Readable {
        constructor (opts) {
            super(Object.assign({}, opts, {
                objectMode: true
            }));
            this._data = [];
        }
        add (item) {
            this._data.push(item);
            if (this.readRequest) {
                this.readRequest = false;
                this.doRead();
            }
        }
        completeAdding () {
            this.add(null);
        }
        doRead () {
            let shouldStop = false;
            while (!shouldStop && this._data.length) {
                const item = this._data.shift();
                shouldStop = !this.push(item);
            }
        }
        _read () {
            this.readRequest = true;
            this.doRead();
        }
    };

    const stream = new ArrayStream();

    const usedComponents = new Set(args);

    const fileLocator = through.obj(function (config, _, callback) {
        if (usedComponents.has(config.name)) {
            const push = through.obj((file, _, pushCallback) => {
                stream.add(file);
                pushCallback();
            });
            vfs.src([
                path.join(config.path, '**', '*.js'),
                path.join('!' + config.path, '**', 'node_modules', '**', '*')
            ])
            .pipe(push)
            .on('finish', () => callback());
        } else {
            callback();
        }
    });

    // start file emission
    vfs.src(path.join(root, '**', 'dopees.json'))
        .pipe(configCollector)
        .pipe(fileLocator)
        .on('finish', () => stream.completeAdding());

    return stream;
};

module.exports = dope;