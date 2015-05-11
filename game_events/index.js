var handlers = require('./handlers');

exports.register = function (server, options, next) {

    var io = require('socket.io')(server.listener);
    var redis = require('redis').createClient;
    var adapter = require('socket.io-redis');
    var pub = redis(options.redis.port, options.redis.hostname, { auth_pass: options.redis.password });
    var sub = redis(options.redis.port, options.redis.hostname, { detect_buffers: true, auth_pass: options.redis.password });

    io.adapter(adapter({ pubClient: pub, subClient: sub }));

    io.on('connection', function (socket) {
        socket.on('game-connect', handlers.connect);
    });

    next();

    var shutdownProcess = function () {
        pub.end();
        sub.end();
    };

    process.on('SIGTERM', shutdownProcess);
    process.on('SIGINT', shutdownProcess);
};

exports.register.attributes = {
    name: 'hapi-game-events'
};
