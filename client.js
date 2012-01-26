var sys = require('sys');
var WebSocket = require('ws');

// var ws = new WebSocket('ws://ec2-79-125-102-118.eu-west-1.compute.amazonaws.com:8000/');
// var ws = new WebSocket('ws://lb.mattheworiordan.com:1340/');
var ws = new WebSocket('ws://localhost:8000/');
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