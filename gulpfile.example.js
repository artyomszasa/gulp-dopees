const gulp = require('gulp'),
    del = require('del'),
    path = require('path'),
    dope = require('./index'),
    sourcemaps = require('gulp-sourcemaps');

const target = '/path/to/output';

// Dopees creates versioned folders for generated files, thus older versions are to be deleted.
gulp.task('clean-scripts', () => del(path.join(target, '*'), {
    force: true
}));

// Example of usage. If sourcemaps are not initialized no source map is generated despite configuration.
gulp.task('scripts', ['clean-scripts'], () => {
    // get dopees components by name. Order is significant!
    // first parameter is root path to search components within
    // further arguments a component names
    return dope.src(__dirname, 'project', 'lib1', 'lib2', 'api')
        // (optional) init source maps
        .pipe(sourcemaps.init())
        // call dopees with specified targets and public prefix
        .pipe(dope({
            prefix: '/static/scripts', // path to access generated files from web
            targets: ['es5', 'es6'] // targets
        }))
        // (optional) write source maps
        .pipe(sourcemaps.write())
        // write optput:
        // dopees injects compilation infomration into api.js and outputs is;
        // all other files are processed and placed into ${target}_${version} folder;
        // if multiple target is specified, then api.js will choose approprite at runtime.
        .pipe(gulp.dest(target));
});

// **************************************************************************
// Harder way: loading components manually...

const merge = require('gulp-merge');

// Source files may be from external directory.
// Order is significant, e.g. if both lib1 and project contains mycomponent.js, only the later one is used.
const scriptSources = [
    { base: '/path/to/project', path: '/path/to/project/**/*.js' },
    { base: '/path/to/lib2', path: '/path/to/lib2/**/*.js' },
    { base: '/path/to/lib1', path: '/path/to/lib1/**/*.js' },
    { base: '/path/to/dopees/api', path: '/path/to/dopees/api/**/*.js' }
];

// Relative name and thus file.base is significant, when scripts are collected from multiple forces the base path must
// be specified.
const srcScripts = () => merge.apply(null, scriptSources.map(src => gulp.src(src.path, {
    base: src.base
})));

// Example of usage. If sourcemaps are not initialized no source map is generated despite configuration.
gulp.task('scripts2', ['clean-scripts'], () => srcScripts()
    .pipe(sourcemaps.init())
    .pipe(dope({
        prefix: '/static/scripts', // path to access generated files from web
        targets: ['es5', 'es6'] // targets
    }))
    .pipe(sourcemaps.write())
    .pipe(gulp.dest(target)));