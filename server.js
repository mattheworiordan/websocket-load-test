var sys = require('sys');
var ws = require("ws").Server;

var server = new ws({ port: 8000 });

server.on("connection", function(connection) {
  connection.on("message", function(msg){
    sys.debug('message received: ' + msg);
    connection.send('message echo');
  });
});

var http = require('http');
http.createServer(function (req, res) {
  res.writeHead(200, {'Content-Type': 'text/plain'});
  res.end('I\'m alive\n');
}).listen(8001);