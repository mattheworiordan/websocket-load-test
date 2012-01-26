var sys = require('sys');
var ws = require("websocket-server");

var server = ws.createServer();

server.addListener("connection", function(connection){
  connection.addListener("message", function(msg){
    sys.debug('message received: ' + msg);
    connection.send('message echo');
  });
});

server.listen(8000);

var http = require('http');
http.createServer(function (req, res) {
  res.writeHead(200, {'Content-Type': 'text/plain'});
  res.end('I\'m alive\n');
}).listen(8001);