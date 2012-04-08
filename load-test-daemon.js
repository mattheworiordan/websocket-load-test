#!/usr/bin/env node

/**********************************
 * Web Socket Echo Load Testing Daemon
 *
 * Usage:
 * load-test-daemon.js -port|--p=<port>
 **********************************

 * Instructions triggered by HTTP request with querystring parameters
 * (*) denotes required
 *
 * /start (Start load test)
 * example: http://localhost:8000/start?host=localhost&port=8000&no_ssl=true&duration=10&rate=30
 *   - host*: comma seperated list of one or more hosts
 *   - port*: http port to use
 *   - number: number of requests to make in this load test (defaults to 1000)
 *   - duration: duration in seconds to run the test, if specified -number parameter is ignored
 *   - concurrent: max number of concurrent connections to use (misfires will occur if an attempted request is made that would exceed the connection count)
 *   - rate: max number of request per second to fire at the server, scaled up bicubicly if ramp_up_time if specified
 *   - ramp_up_time: time in seconds to ramp up the rate using a bicubic curve
 *   - no_ssl: do not use SSL, SSL protocal is assumed by default
 *
 * /report (View the load test report once complete)
 * example: http://localhost:8000/report
 */

var webSocket = require('ws'),
    dns = require('dns'),
    querystring = require('qs');

var argv = require('optimist')
      .usage('Usage: load-test-daemon.js -port|--p=<port>')
      .alias('p', 'port').describe('p', 'the port the service should run on ').default('p', 8000)
      .describe('help', 'show this help');

var PERFORMANCE_LOGGING_INTERVAL = 30, // frequency in seconds to log stats for collection by bee master
    MAX_DNS_ENTRY_AGE = 300, // keep using an old DNS resolution entry for 5 minutes i.e. when ELB removes an old server keep using it for 5 minutes
    DNS_QUERY_INTERVAL = 5, // frequency of DNS queries to see if new ELB instances are online
    DEFAULT_CONCURRENT = 250, // default max concurrent connections to use
    DEFAULT_NUMBER_REQUESTS = 1000, // default number of requests to fire at the server if not a time based test
    OPEN = 1; // web socket OPEN readyState

if (argv.argv.help) {
  argv.showHelp();
  process.exit(0);
} else {
  argv = argv.argv;
}

var serverPort = argv.p,
    httpServer = require('http').createServer(),
    lastResponse = null,
    loadTestRunning = false;

// start an HTTP server for responding to triggers/reports
httpServer.listen(serverPort);

// enable http server to respond to a simple GET request for triggers/reports
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
        lastResponse = null;
        loadTestClient(params.host, params.port, params.concurrent || DEFAULT_CONCURRENT, params.number || DEFAULT_NUMBER_REQUESTS, params.ramp_up_time || 0, params.no_ssl, params.rate, params.duration);
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

var loadTestClient = function(hostList, port, concurrent, numberRequests, rampUpTime, noSsl, rate, duration) {
  /* options */
  var hosts = hostList.split(','),
      randomHost = function() { return hosts[Math.floor(Math.random() * hosts.length)]; },
      currentTestReport = [['Seconds passed','Connections attempted','Actual connections','Messages attempted','Actual Messages','Connection Errors','Misfires','Latency(ms)']],

      concurrentConnections = 0, // actual number of concurrent connections as updated after open/close events
      attemptedConcurrentConnections = 0, // stores number of concurrent connections before open/close event fired

      totalConnectionsOpened = 0,
      totalConnectionAttempts = 0,
      startTime = new Date().getTime(),
      endTime = duration ? startTime + duration * 1000 : false,

      intervals = [], // array to store setInterval timers so that they can be stopped when load test is complete

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
      messageRateManager = function() {
        var lastSecondAttemptRateLog = [], // log of connection attempts in the last second to keep track of rate p/s
            lastSecondConnectionRateLog = [], // log of successful connections in the last second to keep track of rate p/s
            messageLog = [], // log of all messages sent used for reporting when complete
            errorLog = [], // log of all errors typically when max connection limit reached
            lastSecondMisfireLog = [], // log of misfires which occur when connection limit is hit and message cannot be sent
            lastSecondLatencyLog = [], // log of latency (time from connection open to successful message echo) times to average out for report
            rateInLastSecond = function(logArr) { // rate in the previous 5 seconds
              var TIME_MEASURED = 5000,
                  timePassed = Math.max((new Date().getTime() - startTime) / 1000, 1),
                  timeNow = new Date().getTime();

              // clean up older messages
              while ((logArr.length > 0) && (logArr[0] < timeNow - TIME_MEASURED)) {
                logArr.shift();
              }
              return Math.round(logArr.length / Math.min(TIME_MEASURED / 1000, timePassed));
            },
            attemptRateInLastSecond = function() {
              return rateInLastSecond(lastSecondAttemptRateLog);
            },
            connectionRateInLastSecond = function() {
              return rateInLastSecond(lastSecondConnectionRateLog);
            },
            misfiresInLastSecond = function() {
              return rateInLastSecond(lastSecondMisfireLog);
            },
            latencyInLastSecond = function() {
              var TIME_MEASURED = 5000,
                  timeNow = new Date().getTime(),
                  index,
                  latencyTotal = 0;

              // clean up older messages
              while ((lastSecondLatencyLog.length > 0) && (lastSecondLatencyLog[0].time < timeNow - TIME_MEASURED)) {
                lastSecondLatencyLog.shift();
              }
              for (index = 0; index < lastSecondLatencyLog.length; index++) {
                latencyTotal += lastSecondLatencyLog[index].latencyMs;
              }
              return Math.round(latencyTotal / lastSecondLatencyLog.length) || 0;
            };

        return {
          recordAttempt: function() {
            lastSecondAttemptRateLog.push(new Date().getTime());
            totalConnectionAttempts += 1;
          },
          recordSuccess: function() {
            messageLog.push(new Date().getTime());
            lastSecondConnectionRateLog.push(new Date().getTime());
          },
          recordError: function() {
            errorLog.push(new Date().getTime());
          },
          recordMisfire: function() {
            lastSecondMisfireLog.push(new Date().getTime());
          },
          recordLatency: function(latencyMs) {
            lastSecondLatencyLog.push({
              time: new Date().getTime(),
              latencyMs: latencyMs
            });
          },
          attemptRateInLastSecond: attemptRateInLastSecond,
          connectionRateInLastSecond: connectionRateInLastSecond,
          misfiresInLastSecond: misfiresInLastSecond,
          latencyInLastSecond: latencyInLastSecond,
          errorsAveragedPerSecond: function() {
            // get average number of errors per second since last performance logged or since start of test if less than performance logged interval
            var i, timePassed = (new Date().getTime() - startTime) / 1000, timeNow = new Date().getTime();
            for (i = errorLog.length - 1; (i >= 0) && (errorLog[i] >= timeNow - PERFORMANCE_LOGGING_INTERVAL * 1000); i--) {}
            if (errorLog.length) {
              return Math.round((errorLog.length - 1 - i) / Math.min(PERFORMANCE_LOGGING_INTERVAL, timePassed));
            } else {
              return 0;
            }
          },
          totalErrors: function() {
            return errorLog.length;
          },
          rateOverLastMinute: function() {
            // build a list of successful connections in the last minute
            var i, period = 60, lastMessageInMinute;
            for (i = messageLog.length - 1; messageLog[i] >= new Date().getTime() - period * 1000; i--) {}
            lastMessageInMinute = messageLog[i+1];
            if (lastMessageInMinute) {
              return (messageLog.length - 1 - i) / ((new Date().getTime() - lastMessageInMinute) / 1000);
            } else {
              return 0;
            }
          }
        };
      }(),

      dnsResolutionManager = function() {
        var IPsUsed = {},
            warnedAboutDnsResolution = false,
            addIP = function(IP) {
              IPsUsed[IP] = new Date().getTime();
            },
            resolve = function(callback) {
              var host = randomHost(), i;
              dns.resolve4(host, function (err, addresses) {
                if (err) {
                  if (!(host in IPsUsed)) {
                    console.log("Warning, could not resolve DNS for " + host);
                  }
                  addIP(host);
                } else {
                  for (i = 0; i < addresses.length; i++) {
                    if (!(addresses[i] in IPsUsed)) {
                      console.log(" .. resolved DNS for " + host + " to " + addresses[i]);
                    }
                    addIP(addresses[i]);
                  }
                }
                if (callback) callback();
              });
            };

        return {
          resolveDns: resolve,

          randomIP: function() {
            var timeNow = new Date().getTime(),
                validIPs = [],
                IP;
            // build up list of IPs not older than MAX_DNS_ENTRY_AGE(s)
            for (IP in IPsUsed) {
              if (IPsUsed.hasOwnProperty(IP) && (IPsUsed[IP] > timeNow - MAX_DNS_ENTRY_AGE * 1000)) {
                validIPs.push(IP);
              }
            }
            return validIPs[Math.floor(Math.random()*validIPs.length)];
          },

          getList: function() {
            var IPs = [], IP, timeNow = new Date().getTime();
            for (IP in IPsUsed) {
              if (IPsUsed.hasOwnProperty(IP)) {
                if (IPsUsed[IP] > timeNow - MAX_DNS_ENTRY_AGE * 1000) {
                  IPs.push(IP);
                } else {
                  IPs.push('(' + IP + ')');
                }
              }
            }
            return IPs.join(',');
          }
        };
      }(),

      // log current performance of test to the report array
      // format: elapsed time(s),connections attempted,actual connections,messages attempted,messages actual
      logPerformance = function(options) {
        var secondsElapsed = Math.floor((new Date().getTime() - startTime) / 1000),
            opts = (typeof options === 'object' ? options : {});
        if (!opts.showExactSeconds) {
          // make sure time is closest to the
          secondsElapsed = Math.round(secondsElapsed / PERFORMANCE_LOGGING_INTERVAL) * PERFORMANCE_LOGGING_INTERVAL;
        }
        currentTestReport.push([
          secondsElapsed,
          attemptedConcurrentConnections,
          concurrentConnections,
          (currentRate() ? messageRateManager.attemptRateInLastSecond() : 'max'),
          messageRateManager.connectionRateInLastSecond(),
          messageRateManager.errorsAveragedPerSecond(),
          messageRateManager.misfiresInLastSecond(),
          messageRateManager.latencyInLastSecond()
        ]);
      },

      loadTestComplete = function() {
        var timePassed = new Date().getTime() - startTime,
            averageRate = totalConnectionsOpened / (timePassed / 1000),
            errorsPerMinute = Math.round(messageRateManager.totalErrors() / ((timePassed / 1000) / 60) * 1000) / 1000,
            IPs = [],
            ip,
            report = '',
            i;
        console.log('\nFinished\n--------');
        report += 'Report for load test ' + loadTestRunning + ' complete';
        report += '\n' + totalConnectionsOpened + ' connections opened over ' + (Math.round(timePassed/100)/10) + ' seconds.  Average rate of ' + (Math.round(averageRate*10)/10) + ' transactions per second.';
        report += '\nAverage rate over last minute of ' + (Math.round(messageRateManager.rateOverLastMinute() * 10) / 10) + ' transactions per second.';
        report += '\nLoad test errors ' + messageRateManager.totalErrors() + ', average errors per minute ' + (Math.round(errorsPerMinute * 10) / 10);
        report += '\nAverage misfires (all connections used) in last 5 seconds ' + messageRateManager.misfiresInLastSecond();
        report += '\nIPs used: ' + dnsResolutionManager.getList() + '\n\n';
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

      testCanStillRun = function() {
        if (endTime) {
          return endTime > new Date().getTime();
        } else {
          return totalConnectionAttempts < Number(numberRequests);
        }
      },

      testFinished = function() {
        if (endTime) {
          return (endTime < new Date().getTime()) && concurrentConnections <= 0;
        } else {
          return (totalConnectionAttempts >= Number(numberRequests)) && (concurrentConnections <= 0);
        }
      },

      // open a new connection to the server
      openConnection = function() {
        var ws,
            connectionStartTime = new Date().getTime(),
            connectionId = attemptedConcurrentConnections + 1,
            connectionIsOpen = false,
            attemptedConnectionClosed = false,
            recordedEvent = false,
            recordEvent = function(status) {
              if (recordedEvent === false) {
                recordedEvent = true;
                if (status === 'success') {
                  messageRateManager.recordSuccess();
                } else {
                  messageRateManager.recordError();
                }
              }
            },
            closeConnection = function() {
              // close this connection no matter what to ensure we don't have memory or connection leaks
              try {
                if (ws.readyState === OPEN) {
                  ws.close();
                }
              } catch(e) { }

              // log connection closed if connection was opened
              if (connectionIsOpen === true) {
                concurrentConnections -= 1;
                connectionIsOpen = false;
                messageRateManager.recordLatency(new Date().getTime() - connectionStartTime);
              }

              // ensure connection count for attempted connections is reduced only once and check for last test is run once
              if (!attemptedConnectionClosed) {
                attemptedConnectionClosed = true;
                attemptedConcurrentConnections -= 1;
                // check if the test is over and if so generate a report
                // delay this check by 1.001 seconds to ensure if message received back quickly the check to see if time is left will fail because we may be in the second the test should run until
                setTimeout(function() {
                  if (testFinished()) {
                    // we're running a fire & forget no concurrent connection limit process
                    // message sending initiated by setInterval so need to open new connections from here
                    if (attemptedConcurrentConnections <= 0) {
                      if (loadTestRunning) { // only run once
                        loadTestComplete();
                      }
                    }
                  }
                }, 1001);
              }
            };

        messageRateManager.recordAttempt();

        if (attemptedConcurrentConnections >= concurrent) {
          messageRateManager.recordMisfire();
        } else {
          attemptedConcurrentConnections += 1;

          try {
            ws = new webSocket((noSsl ? 'ws' : 'wss') + '://' + dnsResolutionManager.randomIP() + ':' + port + '/');

            // on open connection, lets send a message to the server
            ws.on('open', function() {
              if (connectionIsOpen === false) { // ensure we never double count a connection open
                connectionIsOpen = true;
                concurrentConnections += 1;
                totalConnectionsOpened += 1;
              }
              try {
                ws.send('message');
              } catch (e) {
                console.dir(e);
                recordEvent('error');
                closeConnection();
              }
            });

            ws.on('close', function() {
              closeConnection();
            });

            // once we've successfully received a message, close the connection and open a new one if we have not exceeded the rate
            ws.on('message', function(data, flags) {
              recordEvent('success');
              closeConnection();
            });

            ws.on('error', function(e) {
              // close will fire afterwards
              recordEvent('error');
              closeConnection();
            });
          } catch (e) {
            recordEvent('error');
            totalConnectionsOpened += 1; // must log connection requests in case test is limited by connections
            closeConnection();
          }
        }
      };

  // quick summary of load test outputted to the console
  console.log("Starting load testing for host " + hosts.join(',') + ":" + port);
  if (endTime) {
    console.log("Running for " + duration + " seconds");
  } else {
    console.log("Will fire " + numberRequests + " requests in this test");
  }
  console.log("Set to use max " + concurrent + " concurrent connections");
  if (rate) { console.log("Max rate set to " + rate + " p/s" + (rampUpTime ? ' with a ramp up time of ' + rampUpTime + 's' : '')); }
  console.log("Using SSL: " + (noSsl ? 'No' : 'Yes'));

  // resolve DNS and then lets start the test
  dnsResolutionManager.resolveDns(function() {
    // fire connection requests as necessary, either limited by rate or until testCanStillRun specifies it should stop (time or quantity based)
    var fireAwayFn = function() {
      var requestSent = false;
      if (testCanStillRun()) {
        if (currentRate()) {
          // test is rate limited, so open a connection if within rate threshold
          if (messageRateManager.attemptRateInLastSecond() < currentRate()) {
            requestSent = true;
            openConnection();
          }
        } else {
          // just fire away
          requestSent = true;
          openConnection();
        }
        // call this test again immediately if request sent, else wait a bit until a slot frees up
        setTimeout(fireAwayFn, requestSent ? 0 : 100);
      }
    };
    fireAwayFn();

    // console status updates
    intervals.push(setInterval(function() {
      if (loadTestRunning) {
        console.log(' - attempted conns: ' + attemptedConcurrentConnections + ', conns: ' + concurrentConnections + ', msg attempts p/s: ' + messageRateManager.attemptRateInLastSecond() + ', msgs p/s: ' + messageRateManager.connectionRateInLastSecond() + ', misfires p/s: ' + messageRateManager.misfiresInLastSecond() + ', latency: ' + messageRateManager.latencyInLastSecond() + 'ms, messages: ' + totalConnectionsOpened + ', errors: ' + messageRateManager.totalErrors());
      }
    }, Math.min(duration ? duration / 20 : 20, 20) * 1000)); // 20 updates or at least one every 20 seconds

    // update the DNS every DNS_QUERY_INTERVAL seconds
    intervals.push(setInterval(function() {
      if (loadTestRunning) {
        dnsResolutionManager.resolveDns();
      }
    }, DNS_QUERY_INTERVAL * 1000));

    // log the attempted performance and actual performance every PERFORMANCE_LOGGING_INTERVAL seconds
    intervals.push(setInterval(logPerformance, PERFORMANCE_LOGGING_INTERVAL * 1000));
  });
};

console.log('Ready and listening on port ' + serverPort);

