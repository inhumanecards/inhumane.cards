var jspm = require("jspm");
module.exports = gulp.task("jspm:install", function(done) {
  jspm.install(true).then(function(installed) {
    done();
  });
});
//
// gulp.task("jspm:bundle", function(done) {
//   jspm.bundleSFX("~/app", "server/public/assets/js/app.js", {
//     sourceMaps: false
//   }).then(function() {
//     done();
//   });
// });

function wrapSourcemaps(gulpStream, callback, useSourcemaps) {
  if (useSourcemaps) {
    return callback(gulpStream
      .pipe($_.sourcemaps.init()))
      .pipe($_.sourcemaps.write());
  } else {
    return callback(gulpStream);
  }
}

gulp.task('jspm:bundle', $_.shell.task([
  'jspm bundle-sfx "~/app" server/public/assets/js/app.js'
]));


gulp.task("build", function(done) {
  runSequence('jspm:bundle', 'reload', done);
});

// var babelOptions = {
//   optional: [
//     'es7.classProperties',
//     'es7.asyncFunctions',
//     'es7.objectRestSpread',
//     'es7.trailingFunctionCommas'
//   ]
// };

// // JSX
// gulp.task('scripts', function() {
//   return wrapSourcemaps(gulp.src('client/src/**/*.js'), function(stream) {
//     return stream.pipe($_.babel(babelOptions));
//   }, config.sourcemaps)
//     .pipe($_.cached('jsx')) //Process only changed files
//     .pipe($_.react())
//     .pipe(gulp.dest('build/src/'));
// });
