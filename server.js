var sys    = require('sys');
var ws     = require("ws").Server;
var fs     = require('fs');
var server = new ws({ port: 8000 });

// add echo behaviour to standard non secure WS
addEcho(server);

var http = require('http');
http.createServer(function (req, res) {
  res.writeHead(200, {'Content-Type': 'text/plain'});
  res.end('I\'m alive\n');
}).listen(8001);

var options = {
  key: fs.readFileSync('/Users/matthew/Desktop/ssl/easybacklog.com.nopw.key', 'utf8'),
  cert: fs.readFileSync('/Users/matthew/Desktop/ssl/easybacklog.com.pem', 'utf8')
};
var wss = require('https').createServer(options);
wss.listen(8003);
var wssServer = new ws({ server: wss });
// add echo behaviour to SSL WS
addEcho(wssServer);

function addEcho(server) {
  server.on("connection", function(connection) {
    connection.on("message", function(msg){
      sys.debug('message received: ' + msg);
      connection.send('message echo');
    });
  });
}