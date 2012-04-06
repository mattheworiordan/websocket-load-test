#!/usr/bin/env node

/**********************************
 * Usage
 *
 * load-test-daemon.js -port|--p=<port>
 **********************************/

var webSocket = require('ws'),
    dns = require('dns'),
    querystring = require('qs');

var argv = require('optimist')
      .usage('Usage: load-test-daemon.js -port|--p=<port>')
      .alias('p', 'port').describe('p', 'the port the service should run on ').default('p', 8000)
      .describe('help', 'show this help');

var PERFORMANCE_LOGGING_INTERVAL = 30, // frequency in seconds to log stats for collection by bee master
    DNS_QUERY_INTERVAL = 5; // frequency of DNS queries to see if new ELB instances are online

if (argv.argv.help) {
  argv.showHelp();
  process.exit(0);
} else {
  argv = argv.argv;
}

var serverPort = argv.p,
    httpServer = require('http').createServer(),
    lastResponse = null,
    loadTestRunning = false,
    loadTestErrors = 0;
httpServer.listen(serverPort);

// enable http server to respond to a simple GET request
httpServer.on('request', function (req, res) {
  res.writeHead(200, {'Content-Type': 'text/plain'});
  if (req.url.match(/^\/start/)) {
    if (loadTestRunning) {
      res.end('Load test ' + loadTestRunning + ' already running');
    } else {
      var params = querystring.parse(req.url.replace(/^\/start\?/, ''));
      if (!params.host) {
        res.end('Error: Host field is required');
      } else if (!params.port) {
        res.end('Error: Port field is required');
      } else {
        loadTestRunning = Math.floor(Math.random()*100000);
        loadTestErrors = 0;
        lastResponse = null;
        loadTestClient(params.host, params.port, params.concurrent || 100, params.number || 1000, params.ramp_up_time || 0, params.no_ssl, params.rate, params.duration);
        res.end('Started load test number ' + loadTestRunning);
      }
    }
  } else if (req.url.match(/^\/report/)) {
    if (lastResponse) {
      res.end(lastResponse);
    } else {
      res.end('Report for load test ' + loadTestRunning + ' not ready yet');
    }
  } else {
    if (loadTestRunning) {
      res.end('Load test ' + loadTestRunning + ' currently running');
    } else {
      res.end('Ready for next load test');
    }
  }
});

var loadTestClient = function(hostList, port, connections, numberRequests, rampUpTime, noSsl, rate, duration) {
  /* options */
  var hosts = hostList.split(','),
      randomHost = function() { return hosts[Math.floor(Math.random() * hosts.length)]; },
      lastRandomHost = randomHost(),
      hostResolved = false,
      hostResolvedUsed = {},
      currentTestReport = [['Seconds passed','Connections attempted','Actual connections','Messages attempted','Actual Messages']],

      concurrentConnections = 0, // actual number of concurrent connections as updated after open/close events
      attemptedConcurrentConnections = 0, // stores number of concurrent connections before open/close event fired

      totalConnectionRequests = 0,
      startTime = new Date().getTime(),
      endTime = duration ? startTime + duration * 1000 : false,

      // returns false if not rate limited
      // else returns current rate factoring in any ramp up time that may be required
      currentRate = function() {
        var timeElapsed = (new Date().getTime() - startTime) / 1000;
        if (rate) {
          if (rampUpTime) {
            return Math.max(1, Math.ceil(rate * Math.min(1, Math.pow(timeElapsed / rampUpTime, 3))));
          } else {
            return rate;
          }
        } else {
          return false;
        }
      },

      // object to keep track of messages sent in the last second
      messageRateManager = function(rate) {
        var lastSecondRateLog = [], // log of messages in the last second to keep track of rate p/s
            messageLog = [], // log of all messages sent used for reporting when complete
            queue = [],
            whenRateDrops = function(callback) {
              var timeUntilNextItemShiftsOff = lastSecondRateLog[0] - (new Date().getTime() - 1000);
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
              while ((lastSecondRateLog.length > 0) && (lastSecondRateLog[0] < new Date().getTime() - 1000)) {
                lastSecondRateLog.shift();
              }
              return lastSecondRateLog.length;
            };

        return {
          recordAttempt: function() {
            lastSecondRateLog.push(new Date().getTime());
          },
          recordSuccess: function() {
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

      loadTestComplete = function() {
        var timePassed = new Date().getTime() - startTime,
            averageRate = totalConnectionRequests / (timePassed / 1000),
            errorsPerMinute = Math.round(loadTestErrors / ((timePassed / 1000) / 60) * 1000) / 1000,
            IPs = [],
            ip,
            report = '';
        console.log('\nFinished\n--------');
        report += 'Report for load test ' + loadTestRunning + ' complete';
        report += '\n' + totalConnectionRequests + ' connections opened over ' + (Math.round(timePassed/100)/10) + ' seconds.  Average rate of ' + (Math.round(averageRate*10)/10) + ' transactions per second.';
        report += '\nAverage rate over last minute of ' + (Math.round(messageRateManager.rateOverLastMinute() * 10) / 10) + ' transactions per second.';
        report += '\nLoad test errors ' + loadTestErrors + ', errors per minute ' + errorsPerMinute;
        for (ip in hostResolvedUsed) {
          IPs.push(ip);
        }
        report += '\nIPs used: ' + IPs.join(',') + '\n\n';
        report += 'Performance report for the duration of the tests:\n';
        if (currentTestReport.length < 2) {
          // if report has less than 2 line items, then add report up to now so that we don't have an empty report as we only generate report lines PERFORMANCE_LOGGING_INTERVAL seconds
          logPerformance({ showExactSeconds: true });
        }
        for (var i = 0; i < currentTestReport.length; i++) {
          report += currentTestReport[i].join(',') + '\n';
        }
        report += '---';
        lastResponse = report;
        loadTestRunning = false;
        console.log(report);
        for (var i = 0; i < intervals.length; i++) {
          clearInterval(intervals[i]);
        }
      },

      // open a new connection to the server
      openConnection = function() {
        attemptedConcurrentConnections += 1;
        messageRateManager.recordAttempt();

        var ws,
            closeAndOpen = function() {
              attemptedConcurrentConnections -= 1;
              try {
                ws.close();
              } catch(e) { }

              // if using time && time has not run out
              // or total requests less than expected requests (minus number of open connections)
              // open another connection
              if ( (endTime && (endTime > new Date().getTime())) || (!endTime && (totalConnectionRequests < (numberRequests - attemptedConcurrentConnections))) ) {
                openConnection();
              } else {
                if (attemptedConcurrentConnections <= 0) {
                  if (loadTestRunning) { // only run once
                    loadTestComplete();
                  }
                }
              }
            },
            nextConnection = function() {
              if (!nextConnectionOpened) {
                nextConnectionOpened = true;
                if (currentRate() && (messageRateManager.rateInLastSecond() >= currentRate())) {
                  // ensure we don't exceed rate per second set
                  messageRateManager.queueUntilRateDrops(closeAndOpen);
                } else {
                  closeAndOpen();
                }
              }
            },
            nextConnectionOpened = false,
            connectionOpened = false;

        try {
          ws = new webSocket((noSsl ? 'ws' : 'wss') + '://' + hostResolved + ':' + port + '/');

          // on open connection, lets send a message to the server
          ws.on('open', function() {
            concurrentConnections += 1;
            totalConnectionRequests += 1;
            connectionOpened = true;
            try {
              ws.send('message');
            } catch (e) {
              concurrentConnections -= 1;
              connectionOpened = false;
              loadTestErrors += 1;
              nextConnection();
            }
          });
          ws.on('close', function() {
            if (connectionOpened) {
              concurrentConnections -= 1;
              nextConnection(); // try open next connection in case message never received
            }
          });

          // once we've successfully received a message, close the connection and open a new one if we have not exceeded the rate
          ws.on('message', function(data, flags) {
            messageRateManager.recordSuccess();
            nextConnection();
          });

          ws.on('error', function() {
            // close will fire afterwards
            loadTestErrors += 1;
            nextConnection();
          });
        } catch (e) {
          loadTestErrors += 1;
          totalConnectionRequests += 1; // must log connection requests in case test is limited by connections
          nextConnection();
        }
      },

      connIndex, openConnectionInMs,

      openRateControlledConnectionCallback = function() {
        if (currentRate() && (messageRateManager.rateInLastSecond() >= currentRate())) {
          messageRateManager.queueUntilRateDrops(openConnection);
        } else {
          openConnection();
        }
      },

      // log current performance of test to the report array
      logPerformance = function(options) {
        var secondsElapsed = Math.floor((new Date().getTime() - startTime) / 1000),
            opts = (typeof options === 'object' ? options : {});
        if (!opts.showExactSeconds) {
          // make sure time is closest to the
          secondsElapsed = Math.round(secondsElapsed / PERFORMANCE_LOGGING_INTERVAL) * PERFORMANCE_LOGGING_INTERVAL;
        }
        currentTestReport.push([secondsElapsed, attemptedConcurrentConnections, concurrentConnections, (currentRate() ? currentRate() : 'max'), messageRateManager.rateInLastSecond()]);
      },

      intervals = [];

  console.log("Starting load testing for host " + hosts.join(',') + ":" + port);
  if (endTime) {
    console.log("Running for " + duration + " seconds");
  } else {
    console.log("Set to open " + connections + " connections");
  }
  console.log("Using SSL: " + (noSsl ? 'No' : 'Yes'));

  dns.resolve4(lastRandomHost, function (err, addresses) {
    if (err) {
      console.log("Warning, could not resolve DNS for " + lastRandomHost);
      hostResolved = lastRandomHost;
      hostResolvedUsed[hostResolved] = true;
    } else {
      console.log("Resolved DNS for " + lastRandomHost + " to " + addresses.join(', '));
      hostResolved = addresses[Math.floor(Math.random()*addresses.length)];
      hostResolvedUsed[hostResolved] = true;
    }

    // ramp up the number of connections
    for (connIndex = 0; connIndex < connections; connIndex++) {
      openConnectionInMs = rampUpTime ? Math.floor( (connIndex / connections) * rampUpTime) * 1000: 0;
      setTimeout(openRateControlledConnectionCallback, openConnectionInMs);
    }

    intervals.push(setInterval(function() {
      if (loadTestRunning) {
        console.log(' - connections open: ' + concurrentConnections + ', transactions attempts p/s: ' + messageRateManager.rateInLastSecond() + ', total messages: ' + totalConnectionRequests);
      }
    }, Math.min(duration ? duration / 20 : 20, 20) * 1000)); // 20 updates or at least one every 20 seconds

    // update the DNS every DNS_QUERY_INTERVAL seconds
    intervals.push(setInterval(function() {
      if (loadTestRunning) {
        lastRandomHost = randomHost();
        dns.resolve4(lastRandomHost, function (err, addresses) {
          if (!err) {
            var newHost = addresses[Math.floor(Math.random()*addresses.length)];
            if (newHost !== hostResolved) {
              console.log("DNS resolution changed to " + newHost + ' for ' + lastRandomHost);
              hostResolved = newHost;
              hostResolvedUsed[hostResolved] = true;
            }
          }
        });
      }
    }, DNS_QUERY_INTERVAL * 1000));

    // log the attempted performance and actual performance every PERFORMANCE_LOGGING_INTERVAL seconds
    intervals.push(setInterval(logPerformance, PERFORMANCE_LOGGING_INTERVAL * 1000));
  });
};

console.log('Ready and listening on port ' + serverPort);

