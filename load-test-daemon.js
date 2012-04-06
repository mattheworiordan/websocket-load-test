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
      var params = querystring.parse(req.url.replace(/^\/start\?/, '')),
          loadTestError;
      if (!params.host) {
        res.end('Error: Host field is required');
      } else if (!params.port) {
        res.end('Error: Port field is required');
      } else {
        loadTestRunning = Math.floor(Math.random()*100000);
        loadTestErrors = 0;
        lastResponse = null;
        loadTestError = loadTestClient(params.host, params.port, params.concurrent, params.number || 1000, params.ramp_up_time || 0, params.no_ssl, params.rate, params.duration);
        if (loadTestError) {
          lastResponse = '!!! Error, load test did not start: ' + loadTestError;
          loadTestRunning = false;
          res.end(lastResponse);
        } else {
          res.end('Started load test number ' + loadTestRunning);
        }
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

var loadTestClient = function(hostList, port, concurrent, numberRequests, rampUpTime, noSsl, rate, duration) {
  /* options */
  var errorResponse = null, // return true from loadTestClient if tests started OK
      hosts = hostList.split(','),
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

      // if we are running a no limit concurrent connection test for a duration then set this to true so test behaves as fire and forget
      fireAwayIgnoringConnectionLimits = !concurrent && duration,
      fireAndForgetFn = null,

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
        var lastSecondAttemptRateLog = [], // log of connection attempts in the last second to keep track of rate p/s
            lastSecondConnectionRateLog = [], // log of successful connections in the last second to keep track of rate p/s
            messageLog = [], // log of all messages sent used for reporting when complete
            queue = [],
            whenRateDrops = function(callback, logArr) {
              // if rate is exceeded, then this function invokes the call back when the one second has passed from first item in the list
              var timeUntilNextItemShiftsOff = logArr[0] - (new Date().getTime() - 1000);
              setTimeout(callback(logArr), timeUntilNextItemShiftsOff >= 0 ? timeUntilNextItemShiftsOff+1 : 1);
            },
            processQueue = function(logArr) {
              if (queue.length) {
                if (rateInLastSecond(logArr) < currentRate()) {
                  queue.shift()();
                }
                whenRateDrops(processQueue, logArr);
              }
            },
            rateInLastSecond = function(logArr) {
              // clean up older messages
              while ((logArr.length > 0) && (logArr[0] < new Date().getTime() - 1000)) {
                logArr.shift();
              }
              return logArr.length;
            },
            attemptRateInLastSecond = function() {
              return rateInLastSecond(lastSecondAttemptRateLog);
            },
            connectionRateInLastSecond = function() {
              return rateInLastSecond(lastSecondConnectionRateLog);
            };

        return {
          recordAttempt: function() {
            lastSecondAttemptRateLog.push(new Date().getTime());
          },
          recordSuccess: function() {
            messageLog.push(new Date().getTime());
            lastSecondConnectionRateLog.push(new Date().getTime());
          },
          attemptRateInLastSecond: attemptRateInLastSecond,
          connectionRateInLastSecond: connectionRateInLastSecond,
          queueUntilRateDrops: function(callback) {
            // put the item onto the queue
            queue.push(callback);
            if (queue.length === 1) { // first item in queue so activate timeout
              whenRateDrops(processQueue, lastSecondAttemptRateLog);
            }
          },
          rateOverLastMinute: function() {
            // build a list of successful connections in the last minute
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
            report = '',
            i;
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
        for (i = 0; i < currentTestReport.length; i++) {
          report += currentTestReport[i].join(',') + '\n';
        }
        report += '---';
        lastResponse = report;
        loadTestRunning = false;
        console.log(report);
        for (i = 0; i < intervals.length; i++) {
          clearInterval(intervals[i]);
        }
      },

      testTimeStillLeft = function() {
        return endTime && (endTime > new Date().getTime());
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

              if (!fireAwayIgnoringConnectionLimits) {
                // we're not using fire & forget but recycling connections so we only open new connections when old ones are ready to be closed
                // if using time && time has not run out
                // or total requests less than expected requests (minus number of open connections)
                // open another connection
                if ( testTimeStillLeft() || (!endTime && (totalConnectionRequests < (numberRequests - attemptedConcurrentConnections))) ) {
                  openConnection();
                } else {
                  if (attemptedConcurrentConnections <= 0) {
                    if (loadTestRunning) { // only run once
                      loadTestComplete();
                    }
                  }
                }
              } else {
                // delay this by 1.5 seconds to ensure if message received back quickly the check to see if time is left will fail appropriately
                setTimeout(function() {
                  if (!testTimeStillLeft()) {
                    // we're running a fire & forget no concurrent connection limit process
                    // message sending initiated by setInterval so need to open new connections from here
                    if (attemptedConcurrentConnections <= 0) {
                      if (loadTestRunning) { // only run once
                        loadTestComplete();
                      }
                    }
                  }
                }, 1500);
              }
            },
            nextConnection = function() {
              if (!nextConnectionOpened) {
                nextConnectionOpened = true;
                if (!fireAwayIgnoringConnectionLimits && currentRate() && (messageRateManager.attemptRateInLastSecond() >= currentRate())) {
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
        if (currentRate() && (messageRateManager.attemptRateInLastSecond() >= currentRate())) {
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
        currentTestReport.push([secondsElapsed, attemptedConcurrentConnections, concurrentConnections, (currentRate() ? messageRateManager.attemptRateInLastSecond() : 'max'), messageRateManager.connectionRateInLastSecond()]);
      },

      intervals = [];

  console.log("Starting load testing for host " + hosts.join(',') + ":" + port);
  if (endTime) {
    console.log("Running for " + duration + " seconds");
  }
  if (concurrent) {
    console.log("Set to use " + concurrent + " concurrent connections");
  } else {
    if (!rate && duration) {
      errorResponse = 'Cannot run test with an unlimited number of concurrent connections without a max rate or using a time based test (as opposed to specifying a number of requests)';
      console.log('!!! Error: ' + errorResponse);
      return errorResponse;
    } else {
      console.log("Set to use unlimited connections");
    }
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

    if (!concurrent && !duration) {
      // no concurrent connection limit and just a number of max requests specified so lets open them all up now (rate limited still)
      for (connIndex = 0; connIndex < numberRequests; connIndex++) {
        openRateControlledConnectionCallback();
      }
    } else if (fireAwayIgnoringConnectionLimits) {
      // no concurrent connection limit, so just open a new connection whenever we need to fire a message
      fireAndForgetFn = function() {
        if (testTimeStillLeft()) {
          if (messageRateManager.attemptRateInLastSecond() < currentRate()) {
            openConnection();
            setTimeout(fireAndForgetFn, 0);
          } else {
            setTimeout(fireAndForgetFn, 100);
          }
        }
      };
      fireAndForgetFn();
    } else {
      // concurrent connections set so we'll fire new requests when connections become available
      // open up the connections
      for (connIndex = 0; connIndex < concurrent; connIndex++) {
        openConnectionInMs = rampUpTime ? Math.floor( (connIndex / concurrent) * rampUpTime) * 1000: 0;
        setTimeout(openRateControlledConnectionCallback, openConnectionInMs);
      }
    }

    intervals.push(setInterval(function() {
      if (loadTestRunning) {
        console.log(' - connections open: ' + concurrentConnections + ', attempts p/s: ' + messageRateManager.attemptRateInLastSecond() + ', messages p/s: ' + messageRateManager.connectionRateInLastSecond() + ', total messages: ' + totalConnectionRequests);
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

  return errorResponse;
};

console.log('Ready and listening on port ' + serverPort);

