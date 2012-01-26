var fs = require('fs'),
    http = require('http'),
    https = require('https'),
    httpProxy = require('http-proxy');

var options = {
  https: {
    key: fs.readFileSync('/Users/matthew/Desktop/ssl/easybacklog.com.nopw.key', 'utf8'),
    cert: fs.readFileSync('/Users/matthew/Desktop/ssl/easybacklog.com.pem', 'utf8')
  }
};

// Straightforward HTTP proxy on port 80 so we can test this
httpProxy.createServer(8001, 'localhost', options).listen(8143);

// SSL HTTP proxy on port 8043
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

httpsServer.listen(8043);