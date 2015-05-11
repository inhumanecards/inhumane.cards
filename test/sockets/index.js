module.exports = function(){
    var socketURL = 'http://0.0.0.0:5000';
    var options ={
        transports: ['websocket'],
        'force new connection': true
    };

    describe("game connect", function() {
        require("./connect")(options, socketURL);
    });
};
