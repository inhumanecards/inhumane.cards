'use strict';

var fs = require('fs'),
  lazypipe = require("lazypipe"),
  argv = require('yargs').argv,
  tasks = fs.readdirSync('./gulp/tasks/'),
  browserSync = require('browser-sync'),
  _ = require('lodash');

require('./config');

// --release flag when executing a task
global.argv = argv;
global.gulp = require('gulp');
global.runSequence = require("run-sequence").use(global.gulp);
global.del = require("del");
global.browserSync = browserSync;
global.coverage = argv.coverage;
global.release = argv.release;
global.lazypipe = lazypipe;
global.$_ = require('gulp-load-plugins')();
global._ = _;

tasks.forEach(function(task) {
  if (task.match(/.*\.js/)) {
    require('./tasks/' + task);
  }
});
