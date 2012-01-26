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