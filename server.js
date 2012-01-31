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
    };

var setupServer = function(protocol, port, options) {
  var httpServer = require(protocol).createServer(options);

  httpServer.listen(port);

  // enable http/s server to respond to a simple GET request
  httpServer.on('request', function (req, res) {
    res.writeHead(200, {'Content-Type': 'text/plain'});
    res.end('I\'m alive (process ' + process.env.NODE_WORKER_ID + ')\n');
    console.log(' --> ' + protocol.toUpperCase() + ' heartbeat sent');
  });

  // set up web socket server
  webSocketServer = new WebSocketServer({ server: httpServer });

  // add echo behaviour to SSL WS
  webSocketServer.on("connection", function(connection) {
    console.log("Connection from client opened");
    connection.on("message", function(msg){
      console.log(' <-- message received and echoed on cluster ' + process.env.NODE_WORKER_ID + ': ' + msg + ' --> ');
      connection.send('message echo');
    });
  });
};

if (cluster.isMaster) {
  console.log('Server has ' + numCPUs + ' CPU(s)');
  console.log('Using key ' + key);

  // Fork workers.
  for (var i = 0; i < numCPUs; i++) {
    cluster.fork();
  }

  cluster.on('death', function(worker) {
    console.log('!! Worker ' + worker.pid + ' died');
    cluster.fork();
    console.log('   .. spawned new worker');
  });
} else {
  console.log('Starting up cluster ID: ' + process.env.NODE_WORKER_ID);
  setupServer('http', 8000);
  setupServer('https', 8043, options);
}