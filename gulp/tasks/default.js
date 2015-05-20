module.exports = gulp.task("default", function() {
  runSequence('build', 'copy', 'watch');
});
