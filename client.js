var sys = require('sys');
var WebSocket = require('ws');

// var ws = new WebSocket('ws://ec2-79-125-102-118.eu-west-1.compute.amazonaws.com:8000/');
// var ws = new WebSocket('ws://test-1884315901.eu-west-1.elb.amazonaws.com:80/');
// var ws = new WebSocket('wss://easybacklog.com:443/');
// var ws = new WebSocket('ws://easybacklog.com:80/');
var ws = new WebSocket('wss://localhost:8003/');
// var ws = new WebSocket('ws://localhost:8000/');
ws.on('open', function() {
  sys.debug('Connection opened');
  sendMessage();
});
ws.on('message', function(data, flags) {
  sys.debug('Data received: ' + data);
});


function sendMessage() {
  ws.send('message');
  sys.debug('..sent message..');
  setTimeout(sendMessage, 1000);
}