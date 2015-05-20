var nodemon = require('gulp-nodemon');
module.exports = gulp.task('serve', ['load-server'], function() {
  return browserSync({
    notify: false,
    proxy: "localhost:8000",
    // Customize the BrowserSync console logging prefix
    logPrefix: "Dev",
  // Run as an https by uncommenting 'https: true'
  // Note: this uses an unsigned certificate which on first access
  //       will present a certificate warning in the browser.
  // https: true,
  });
});

gulp.task('watch', ['serve'], function() {
  gulp.watch("client/index.html", ['copy:html', 'reload']);
  gulp.watch("client/src/**/*.js", ['build']);
  gulp.watch("client/src/**/*.jsx", ['build']);
});

gulp.task('reload', function() {
  setTimeout(function() {
    browserSync.reload();
  }, 200);
});

gulp.task('load-server', function() {
  nodemon({
    script: 'server/server.js',
    ext: 'html js',
    watch: [
      "server"
    ],
    ignore: ['server/public']
  })
    //.on('change', ['lint'])
    .on('restart', ['reload']);
});
