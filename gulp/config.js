"use strict";

global.PUBLIC_FOLDER = "public";
global.CLIENT_FOLDER = "/client";
global.SRC_FOLDER = CLIENT_FOLDER + "/src";

global.config = {
  paths: {
    src: {
      app: PUBLIC_FOLDER + "/assets/js/app",
      indexHtml: SRC_FOLDER + '/index.html',
      html: [SRC_FOLDER + '/app/*.html', SRC_FOLDER + '/app/**/*.html', SRC_FOLDER + '/index.html'],
      sass: [SRC_FOLDER + '/sass/app.scss', SRC_FOLDER + '/sass/**/*.scss'],
      bower: SRC_FOLDER + "/lib",
      scripts: SRC_FOLDER + "/app/**/*.js",
      lib: ["lib/**", CLIENT_FOLDER + "!lib/**/docs/**"],
      systemConfig: SRC_FOLDER + "/system-config.js"
    },
    dest: {
      app: PUBLIC_FOLDER + '/assets/js',
      markdown: SRC_FOLDER + '/app/views',
      indexHtml: PUBLIC_FOLDER,
      bower: SRC_FOLDER + '/lib',
      views: PUBLIC_FOLDER + "/assets/js",
      scripts: PUBLIC_FOLDER + "/assets/js",
      styles: PUBLIC_FOLDER + "/assets/css",
      fonts: PUBLIC_FOLDER + "/assets/fonts",
      images: PUBLIC_FOLDER + "/assets/images",
      lib: PUBLIC_FOLDER + "/assets/lib"
    },
    clean: {
      lib: "lib/**/docs/**/*"
    }
  },
  files: {
    app: "app.js"
  },
  ports: {
    staticServer: 8000,
    livereloadServer: 35729
  },
  traceurOptions: {
    modules: "instantiate"
  }
};
