var Hapi = require('hapi');
var routes = require('./routes');

// Create a server with a host and port
var server = new Hapi.Server();


server.connection({
  port: 8000
});

// Add the route
server.route(routes);

// Start the server
server.start(function() {
  console.log('started on port 8000');
});
