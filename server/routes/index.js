module.exports = [{
  method: 'GET',
  path: '/{param*}',
  handler: {
    file: './server/public/index.html'
  },
  config: {
    cors: true
  }
  }, {
  method: 'GET',
  path: '/assets/{param*}',
  handler: {
    directory: {
      path: './server/public/assets'
    }
  }
  }, {
  method: 'GET',
  path: '/lib/{param*}',
  handler: {
    directory: {
      path: './server/public/assets/lib'
    }
  }

}];
