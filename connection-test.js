#!/usr/bin/env node

/**********************************
 * Usage
 *
 * connection-test.js -c|--concurrent=<count> -h|--host=<host> -port|--p=<port> -s|--no_ssl (disable SSL)
 **********************************/

var webSocket = require('ws');

var argv = require('optimist')
      .usage('Usage: connection-test.js -c|--concurrent=<count> -h|--host=<host> -port|--p=<port> -s|--no_ssl (disable SSL)')
      .alias('c', 'concurrent').describe('c', 'number of concurrent connections').default('c', 100)
      .alias('h', 'host').describe('h', 'the hostname or IP address of the service').default('h', 'localhost')
      .alias('p', 'port').describe('p', 'the port of the service').default('p', 8000)
      .alias('s', 'ssl').describe('s', 'use SSL (off by default)')
      .describe('help', 'show this help')

if (argv.argv.help) {
  argv.showHelp();
  process.exit(0);
} else {
  argv = argv.argv;
}

/* options */
var host = argv.h,
    port = argv.p,
    maxConnections = argv.c,
    useSsl = argv.s,

    concurrentConnections = 0,

    startTime = new Date().getTime(),

    connections = [],

    // object to keep track of messages received in the last second
    messageRateManager = function() {
      var lastMinuteRateLog = [], // log of messages in the last second to keep track of rate p/s
          rateInLastSecond = function() {
            // clean up messages older than 1 second
            while ((lastMinuteRateLog.length > 0) && (lastMinuteRateLog[0] < new Date().getTime() - 1000)) {
              lastMinuteRateLog.shift();
            }
            return lastMinuteRateLog.length;
          };

      return {
        record: function() {
          lastMinuteRateLog.push(new Date().getTime());
        },
        rateInLastSecond: rateInLastSecond
      };
    }(),

    openAnotherConnection = function() {
      var ws = new webSocket((useSsl ? 'wss' : 'ws') + '://' + host + ':' + port + '/'),
          nextConnectionOpened = false;

      ws.on('open', function() {
        connections.push(ws);
        concurrentConnections += 1;
        if (concurrentConnections % 10 === 0) { console.log("Connections now open " + concurrentConnections); }
        ws.send('message');
      });
      ws.on('close', function() {
        concurrentConnections -= 1;
        if (concurrentConnections <= 0) {
          var timePassed = new Date().getTime() - startTime;
          console.log('Finished in ' + Math.round(timePassed/1000) + 's');
          process.exit(0);
        }
      });
      // once we've successfully received a message, lets open the next connection
      ws.on('message', function(data, flags) {
        var i;
        messageRateManager.record();
        if (!nextConnectionOpened) {
          if (concurrentConnections < maxConnections) {
            nextConnectionOpened = true;
            openAnotherConnection();
          } else {
            console.log("Closing connections");
            for (i = 0; i < connections.length; i++) {
              connections[i].close();
            }
          }
        }
        if (ws.readyState === 1) { ws.send('message'); }
      });
    };

openAnotherConnection();

setInterval(function() {
  console.log('Messages in last second ' + messageRateManager.rateInLastSecond());
}, 1000);

/*

    // returns false if not rate limited
    // else returns current rate factoring in any ramp up time that may be required
    currentRate = function() {
      var timeElapsed = (new Date().getTime() - startTime) / 1000;
      if (rate) {
        if (rampUpTime) {
          return Math.max(1, Math.ceil(rate * Math.min(1, (timeElapsed / rampUpTime))));
        } else {
          return rate;
        }
      } else {
        return false;
      }
    },

    // object to keep track of messages sent in the last second
    messageRateManager = function(rate) {
      var lastMinuteRateLog = [], // log of messages in the last second to keep track of rate p/s
          messageLog = [], // log of all messages sent used for reporting when complete
          queue = [],
          whenRateDrops = function(callback) {
            var timeUntilNextItemShiftsOff = lastMinuteRateLog[0] - (new Date().getTime() - 1000);
            setTimeout(callback, timeUntilNextItemShiftsOff ? timeUntilNextItemShiftsOff+1 : 1);
          },
          processQueue = function() {
            if (queue.length) {
              if (rateInLastSecond() < currentRate()) {
                queue.shift()();
              }
              whenRateDrops(processQueue);
            }
          },
          rateInLastSecond = function() {
            // clean up messages older than 1 second
            while ((lastMinuteRateLog.length > 0) && (lastMinuteRateLog[0] < new Date().getTime() - 1000)) {
              lastMinuteRateLog.shift();
            }
            return lastMinuteRateLog.length;
          };

      return {
        record: function() {
          lastMinuteRateLog.push(new Date().getTime());
          messageLog.push(new Date().getTime());
        },
        rateInLastSecond: rateInLastSecond,
        queueUntilRateDrops: function(callback) {
          // put the item onto the queue
          queue.push(callback);
          if (queue.length === 1) { // first item in queue so activate timeout
            whenRateDrops(processQueue);
          }
        },
        rateOverLastMinute: function() {
          // build a list of messages sent in the last minute
          var i, period = 60, lastMessageInMinute;
          for (i = messageLog.length - 1; i--; messageLog[i] >= new Date().getTime() - period * 1000) {}
          lastMessageInMinute = messageLog[i+1];
          if (lastMessageInMinute) {
            return (messageLog.length - 1 - i) / ((new Date().getTime() - lastMessageInMinute) / 1000);
          } else {
            return 0;
          }
        }
      };
    }(rate),

    // open a new connection to the server
    openConnection = function() {
      var ws = new webSocket((noSsl ? 'ws' : 'wss') + '://' + hostResolved + ':' + port + '/');

      attemptedConcurrentConnections += 1;
      messageRateManager.record();

      // on open connection, lets send a message to the server
      ws.on('open', function() {
        concurrentConnections += 1;
        totalConnectionRequests += 1;
        ws.send('message');
      });
      ws.on('close', function() {
        concurrentConnections -= 1;
      });

      // once we've successfully received a message, close the connection and open a new one if we have not exceeded the rate
      ws.on('message', function(data, flags) {
        var closeAndOpen = function() {
              attemptedConcurrentConnections -= 1;
              ws.close();
              // if using time && time has not run out
              // or total requests less than expected requests (minus number of open connections)
              // open another connection
              if ( (endTime && (endTime > new Date().getTime())) || (!endTime && (totalConnectionRequests < (numberRequests - attemptedConcurrentConnections))) ) {
                openConnection();
              } else {
                if (attemptedConcurrentConnections <= 0) {
                  var timePassed = new Date().getTime() - startTime,
                      averageRate = totalConnectionRequests / (timePassed / 1000),
                      IPs = [],
                      ip;
                  console.log('\nFinished\n--------');
                  console.log(totalConnectionRequests + ' connections opened over ' + (Math.round(timePassed/100)/10) + ' seconds.  Average rate of ' + (Math.round(averageRate*10)/10) + ' transactions per second.');
                  console.log('Average rate over last minute of ' + (Math.round(messageRateManager.rateOverLastMinute() * 10) / 10) + ' transactions per second.');
                  for (ip in hostResolvedUsed) {
                    IPs.push(ip);
                  }
                  console.log('IPs used: ' + IPs.join(','));
                  process.exit(0);
                }
              }
            };

        if (currentRate() && (messageRateManager.rateInLastSecond() >= currentRate())) {
          // ensure we don't exceed rate per second set
          messageRateManager.queueUntilRateDrops(closeAndOpen);
        } else {
          closeAndOpen();
        }
      });
    },

    connIndex, openConnectionInMs,

    openRateControlledConnectionCallback = function() {
      if (currentRate() && (messageRateManager.rateInLastSecond() >= currentRate())) {
        messageRateManager.queueUntilRateDrops(openConnection);
      } else {
        openConnection();
      }
    };

console.log("Starting load testing for host " + host + ":" + port);
if (endTime) {
  console.log("Running for " + duration + " seconds");
} else {
  console.log("Set to open " + connections + " connections");
}
console.log("Using SSL: " + (noSsl ? 'No' : 'Yes'));

dns.resolve4(host, function (err, addresses) {
  if (err) {
    console.log("Warning, could not resolve DNS for " + host);
    hostResolved = host;
    hostResolvedUsed[hostResolved] = true;
  } else {
    console.log("Resolved DNS for " + host + " to " + addresses.join(', '));
    hostResolved = addresses[Math.floor(Math.random()*addresses.length)];
    hostResolvedUsed[hostResolved] = true;
  }

  // ramp up the number of connections in one second interval
  for (connIndex = 0; connIndex < connections; connIndex++) {
    openConnectionInMs = rampUpTime ? Math.floor( (connIndex / connections) * rampUpTime) * 1000: 0;
    setTimeout(openRateControlledConnectionCallback, openConnectionInMs);
  }

  setInterval(function() {
    console.log(' - connections open: ' + concurrentConnections + ', transactions p/s: ' + messageRateManager.rateInLastSecond() + ', total messages: ' + totalConnectionRequests);
  }, Math.min(duration ? duration / 20 : 20, 20) * 1000); // 20 updates or at least one every 20 seconds

  // update the DNS every 5 seconds
  setInterval(function() {
    dns.resolve4(host, function (err, addresses) {
      if (!err) {
        var newHost = addresses[Math.floor(Math.random()*addresses.length)];
        if (newHost !== hostResolved) {
          console.log("DNS resolution changed to " + newHost);
          hostResolved = newHost;
          hostResolvedUsed[hostResolved] = true;
        }
      }
    });
  }, 5000);
});

*/