var Hapi = require('hapi');
var Path = require('path');
var redisURL = require("redis-url").parse(process.env.REDIS_URL);
var redis = require("redis");
var q = require("q");

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

var redisClient = redis.createClient(Number(redisURL.port), redisURL.hostname, {});

if(redisURL.password) {
    redisClient.auth(redisURL.password);
}

var redisDeferal = q.defer();
var redisReady = redisDeferal.promise;

redisClient.on('ready', function() {
    redisDeferal.resolve();
});

redisClient.on('error', function(error) {
    redisDeferal.reject(error);
});

redisReady.then(function(){
    server.start(function () {
        console.log("Redis client connect @ port ", redisClient.server_info.tcp_port);
        console.log("Server started @ " + server.info.uri);
    });
}, function(error){
    console.log("Could not connect to Redis server: ", error);
});

var shutdownProcess = function () {
    redisClient.end(); //Kills all clients in their tracks
    server.stop(function () {
        console.log('Server stopped');
    });
};

process.on('SIGTERM', shutdownProcess);
process.on('SIGINT', shutdownProcess);
