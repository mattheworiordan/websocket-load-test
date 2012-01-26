var sys = require('sys');
var WebSocket = require('websocket-client').WebSocket;

var ws = new WebSocket('ws://localhost:8000/');
ws.addListener('data', function(buf) {
    // sys.debug('Got data: ' + sys.inspect(buf));
});
ws.onmessage = function(m) {
    sys.debug('Got message: ' + m.data);
}

function sendMessage() {
  if (ws.readyState === 1) {
    ws.send('message');
  }
  sys.debug('sent message');
  setTimeout(sendMessage, 1000);
}

sendMessage();