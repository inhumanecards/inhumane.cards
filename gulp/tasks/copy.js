module.exports = gulp.task("copy:images", function() {
  return gulp.src("src/images/**/*")
    .pipe(gulp.dest("server/public/assets/images/"));
});


gulp.task("copy:html", function() {
  return gulp.src("./client/src/**/*.html")
    .pipe(gulp.dest("./server/public/"));
});


gulp.task("copy:systemConfig", function() {
  return gulp.src("client/src/config.js")
    .pipe(gulp.dest("server/public/assets/"));
});


gulp.task("copy", function() {
  return runSequence(["copy:html", "copy:images"]);
});
