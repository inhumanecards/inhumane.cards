var Hapi = require('hapi');
var Path = require('path');

//Port must be an integer for HAPI
var numPort = process.env.PORT ? parseInt(process.env.PORT, 10) : 8100;
var server = new Hapi.Server();

server.views({
    engines: {
        html: require('handlebars')
    },
    relativeTo: __dirname,
    path: './views',
    partialsPath: './views/partials'
});


server.connection({ port: numPort });


server.route({
    method: 'GET',
    path: '/',
    handler: function (request, reply) {
        reply.view('index');
    }
});

server.route({
    method: 'GET',
    path: '/{filename*}',
    handler: {
        directory: {
            path: 'public'
        }
    }
});

server.start(function () {
    console.log("Hapi server started @ " + server.info.uri);
});
