var argv = require('optimist')
      .alias('k', 'keysize').describe('k', 'key size (1024|2048)').default('k', '')
      .argv;

var WebSocketServer     = require("ws").Server,
    fs                  = require('fs'),
    cluster             = require('cluster'),
    numCPUs             = require('os').cpus().length,
    key                 = 'example' + (argv.k ? '-' + argv.k : ''),
    options             = {
      key: fs.readFileSync(key + '.key', 'utf8'),
      cert: fs.readFileSync(key + '.crt', 'utf8')
    },
    messagesSent = 0, // keep track of number of messages in the last period
    heartBeatsSent = 0,
    connections = 0,
    headerShown = false;

var setupServer = function(protocol, port, options) {
  var httpServer = require(protocol).createServer(options);

  httpServer.listen(port);

  // enable http/s server to respond to a simple GET request
  httpServer.on('request', function (req, res) {
    res.writeHead(200, {'Content-Type': 'text/plain'});
    res.end('I\'m alive (process ' + process.env.NODE_WORKER_ID + ')\n');
    process.send({ heartBeatSent: true });
  });

  // set up web socket server
  webSocketServer = new WebSocketServer({ server: httpServer });

  // add echo behaviour to SSL WS
  webSocketServer.on("connection", function(connection) {
    process.send({ connection: 1 });
    connection.on("message", function(msg){
      connection.send('message echo');
      process.send({ messageSent: true });
    });
    connection.on('close', function(msg) {
      process.send({ connection: -1 });
    });
  });
};

if (cluster.isMaster) {
  console.log('Server has ' + numCPUs + ' CPU(s)');
  console.log('Using key ' + key);

  // Fork workers.
  for (var i = 0; i < numCPUs; i++) {
    var worker = cluster.fork();
    worker.on('message', function(msg) {
      if (msg.messageSent) {
        messagesSent++;
      } else if (msg.heartBeatSent) {
        heartBeatsSent++;
      } else if (msg.connection) {
        connections += msg.connection;
      }
    });
  }

  cluster.on('death', function(worker) {
    console.log('!! Worker ' + worker.pid + ' died');
    cluster.fork();
    console.log('   .. spawned new worker');
  });


  var reportingDuration = 10; // seconds
  setInterval(function() {
    var now = new Date();
    if (messagesSent || heartBeatsSent) {
      if (!headerShown) {
        console.log('\nHour,Minute,Second,Messages,HeartBeats,MessagesPerSecond,HeartBeatsPerSecond,Connections');
        headerShown = true;
      }
      console.log(now.getHours() + ',' + now.getMinutes() + ',' + now.getSeconds() + ',' + messagesSent + ',' + heartBeatsSent + ',' +
        Math.round(10 * messagesSent/reportingDuration)/10 + ',' + Math.round(10 * heartBeatsSent/reportingDuration)/10 + ',' + connections);
      messagesSent = 0;
      heartBeatsSent = 0;
    }
  }, reportingDuration * 1000);
} else {
  console.log('Starting up cluster ID: ' + process.env.NODE_WORKER_ID);
  setupServer('http', 8000);
  setupServer('https', 8043, options);
}