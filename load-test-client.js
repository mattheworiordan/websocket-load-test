#!/usr/bin/env node

/**********************************
 * Usage
 *
 * load-test-client.js -c|--connections=<count> -r|--requests=<count> -h|--host=<host> -port|--p=<port> -t|--ramp_up_time=<time in seconds> -s|--ssl=[true|false]
 **********************************/

var WebSocket = require('ws');

var argv = require('optimist')
      .usage('Usage: load-test-client.js -c|--connections=<count> -r|--requests=<count> -h|--host=<host> -port|--p=<port> -t|--ramp_up_time=<time in seconds> -s|--no_ssl (disable SSL)')
      .alias('c', 'connections').describe('c', 'number of concurrent connections (defaults to 100)').default('c', 100)
      .alias('r', 'requests').describe('r', 'number of total connection requests (defaults to 1,000)').default('r', 1000)
      .alias('h', 'host').describe('h', 'the hostname or IP address of the service (defaults to localhost)').default('h', 'localhost')
      .alias('p', 'port').describe('p', 'the port of the service (defaults to 8043)').default('p', 8043)
      .alias('t', 'ramp_up_time').describe('t', 'time to take in seconds to ramp up connections (defaults to 10)').default('t', 0)
      .alias('s', 'no_ssl').describe('s', 'flag to disable SSL').default('s', false)
      .argv;

var host = argv.h,
    port = argv.p,
    connections = argv.c,
    requests = argv.r,
    ramp_up_time = argv.t,
    no_ssl = argv.s;

var currentConnections = 0,
    totalConnectionRequests = 0,
    startTime = new Date().getTime();

console.log("Using SSL: " + (no_ssl ? 'No' : 'Yes'));

// open a new connection to the server
var openConnection = function() {
  var ws = new WebSocket((no_ssl ? 'ws' : 'wss') + '://' + host + ':' + port + '/');
  currentConnections += 1;
  // on open connection, lets send a message to the server
  ws.on('open', function() {
    totalConnectionRequests += 1;
    ws.send('message');
  });
  // once we've successfully received a message, close the connection and open a new one
  ws.on('message', function(data, flags) {
    ws.close();
    currentConnections -= 1;
    if (totalConnectionRequests < requests) {
      openConnection();
    } else {
      var timePassed = new Date().getTime() - startTime,
          rate = totalConnectionRequests / (timePassed / 1000);
      console.log(totalConnectionRequests + ' connections in ' + (Math.round(timePassed/100)/10) + ' seconds.  Rate of ' + (Math.round(rate*10)/10) + ' connections per second');
      process.exit(0);
    }
  });
  // throttle the start time opening new connections
  if (currentConnections < connections) {
    setTimeout(function() {
      openConnection();
    }, 1000 / (connections / ramp_up_time));
  }
};

openConnection();

