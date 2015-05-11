var assert = require("assert");
var io = require('socket.io-client');

module.exports = function (opts, url) {

    describe('initial handshake', function (done) {
        it("confirms a game connection", function(done) {
            var client1 = io.connect(url, opts);
            client1.on('connect', function(data){
                client1.emit('game-connect');

            });

            client1.on('game-connected', function(data){
                assert.equal(10, 10);
                done();
            });
        });

    });
};
