const gulp = require('gulp'),
    del = require('del'),
    merge = require('gulp-merge'),
    path = require('path'),
    dope = require('./index'),
    sourcemaps = require('gulp-sourcemaps');

// Source files may be from external directory.
// Order is significant, e.g. if both lib1 and project contains mycomponent.js, only the later one is used.
const scriptSources = [
    { base: '/path/to/project', path: '/path/to/project/**/*.js' },
    { base: '/path/to/lib2', path: '/path/to/lib2/**/*.js' },
    { base: '/path/to/lib1', path: '/path/to/lib1/**/*.js' },
    { base: '/path/to/dopees/api', path: '/path/to/dopees/api/**/*.js' }
];
const target = '/path/to/output';

// Relative name and thus file.base is significant, when scripts are collected from multiple forces the base path must
// be specified.
const srcScripts = () => merge.apply(null, scriptSources.map(src => gulp.src(src.path, {
    base: src.base
})));

// Dopees creates versioned folders for generated files, thus older versions are to be deleted.
gulp.task('clean-scripts', () => del(path.join(target, '*'), {
    force: true
}));

// Example of usage. If sourcemaps are not initialized no source map is generated despite configuration.
gulp.task('scripts', ['clean-scripts'], () => srcScripts()
    .pipe(sourcemaps.init())
    .pipe(dope({
        prefix: '/static/scripts', // path to access generated files from web
        targets: ['es5', 'es6'] // targets
    }))
    .pipe(sourcemaps.write())
    .pipe(gulp.dest(target)));