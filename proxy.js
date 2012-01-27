var fs = require('fs'),
    https = require('https'),
    httpProxy = require('http-proxy');

var options = {
  https: {
    key: fs.readFileSync('example.key', 'utf8'),
    cert: fs.readFileSync('example.crt', 'utf8')
  }
};

// Straightforward HTTP proxy on port 8000 so we can test a normal HTTP connection -> HTTP connection
httpProxy.createServer(8000, 'localhost').listen(8001);

// SSL HTTP proxy on port 8044, HTTPS -> HTTP
var proxy = new httpProxy.HttpProxy({
  target: {
    host: 'localhost',
    port: 8000
  }
});
var httpsServer = https.createServer(options.https, function (req, res) {
  proxy.proxyRequest(req, res);
});

// Websocket upgrade socket
httpsServer.on('upgrade', function(req, socket, head) {
  proxy.proxyWebSocketRequest(req, socket, head);
});

httpsServer.listen(8044);