YETI = (function yeti (window, document) {

    var RETRY = "Server error, retrying in 5 seconds.",
        WAIT_FOR = "Waiting for ",
        WAIT_TESTS = WAIT_FOR + "tests.",
        XMLHTTPREQUEST = "XMLHttpRequest",
        READYSTATE = "readyState",
        CONTENTWINDOW = "contentWindow",
        ENDPOINT = "/tests/wait",
        FAILED = 'THIS TEST FAILED',
        DEFAULT_TIMEOUT = 30000, // after this many ms of no activity, skip the test
        setTimeout = window.setTimeout,
        clearTimeout = window.clearTimeout,
        socket = io.connect('/yetitests'), // socket.io
        heartbeats = 0, // counter for YETI.heartbeat() calls
        reaperSecondsRemaining = 0, // counter for UI
        frame = null, // test target frame's contentWindow
        tests = [], // tests to run
        currentBatch = null, // current batch id, falsy if idle
        batches = [], // batches
        elementCache = {}, // cache of getElementById calls
        TIMEOUT, // see START, config.timeout || DEFAULT_TIMEOUT
        startTime, // for elapsed time
        currentURL, // The current test url
        clientID, // The socket.io client id given on first request
        reaperTimeout, // reaper(fn)'s timeout to call fn
        syncUITimeout; // reaper(fn)'s timeout to sync UI

    // caching getElementById
    function _ (id) {
        if (!(id in elementCache)) elementCache[id] = document.getElementById(id);
        return elementCache[id];
    }

    function setContent (id, html) {
        _(id).innerHTML = html;
    }

    // creates our test target
    function createFrame () {
        var frame = document.createElement("iframe");
        frame.frameBorder = 0; // IE 6
        _("bd").appendChild(frame);
        return frame[CONTENTWINDOW] || frame.contentDocument[CONTENTWINDOW];
    }

    function navigate (frame, url) {
        setTimeout((function(frame, url) {
            return function() {
                if (frame && frame.location) {
                    frame.location.href = url;
                }
            }
        })(frame, url), 850);
    }

    // wrappers around setContent

    function mode (str) {
        setContent("mode", str);
    }

    function smode (str) {
        setContent("smode", str);
    }

    function status (str) {
        setContent("status", str);
    }

    // clears all timers
    function phantom () {
        if (reaperTimeout) clearTimeout(reaperTimeout);
        if (syncUITimeout) clearTimeout(syncUITimeout);
        reaperTimeout = syncUITimeout = null;
    }

    // starts the reaper timers
    // updates the vitals UI
    // calls the provided function after TIMEOUT ms
    // unless reset by phantom() or by calling reaper again
    function reaper (fn) {
        var second = 1000;
        phantom();
        reaperTimeout = setTimeout((function(fn) {
          return function() {
            fn(FAILED);
          };  
        })(fn), (TIMEOUT - 3000));
        reaperSecondsRemaining = Math.floor(TIMEOUT / second);
        (function SYNCUI () {
            var bpm = Math.round(
                ( (heartbeats * 60000) / ( (new Date).getTime() - startTime ) )
            );
            if (!isNaN(bpm) && bpm > 0) {
                // add a leading zero if needed, always 2 digits
                if ((""+bpm).length < 3) bpm = "0" + bpm;
                setContent("pulse", bpm);
            }
            setContent("timer", reaperSecondsRemaining);
            setContent("heartbeats", heartbeats);
            setContent("tests", tests.length);
            reaperSecondsRemaining--;
            if (reaperSecondsRemaining > 0) {
                syncUITimeout = setTimeout(SYNCUI, second);
            }
        })();
    }

    // handling incoming data from the server
    // this may be from EventSource or XHR
    function incoming (response) {
        if (response && response.tests && response.tests.length && response.batch && !currentBatch) {
            mode("Run");
            heartbeats = 0;
            startTime = (new Date).getTime();

            if (currentBatch) {
                batches[response.batch] = response.tests;
            } else {
                currentBatch = response.batch;
                tests = response.tests;
                dequeue();
            }
        }
    }

    function reset() {
        abort();
        smode("Reset");
        status("Resetting this browser");
        setTimeout(function() {
            location.href = 'refresh/';
        }, 1000);
    }

    function abort() {
        smode("Abort Batch");
        mode("Idle");
        status("Abort received, waiting for server..");
        heartbeats = 0;
        navigate(frame, 'about:blank');
        currentBatch = null;
        batches = [];
        phantom();
    }

    // run the next test
    function dequeue () {
        var url = tests.shift();
        if (url) {
            smode('Fetch');
            currentURL = url;
            status("Running test: " + url);
            navigate(frame, url);
            reaper(YETI.next);
        } else {
            //If we get here, something may be wrong
            complete();
        }
    }

    // stop running all tests, restart with dequeue()
    function complete () {
        phantom();
        navigate(frame, "about:blank");
        status("Done. " + WAIT_FOR + "new tests.");
        mode("Idle");
        if (currentBatch) {
            socket.emit('done', {
                clientID: clientID,
                batch: currentBatch
            });
            smode("Done");
        }

        currentBatch = null;
        if (batches.length) {
            for (var id in batches) {
                // only need one!
                currentBatch = id;
                if (currentBatch) {
                    tests = batches[id];
                    if (tests && tests.length) {
                        return dequeue();
                    }
                }
            }
        }
    }

    function wait () {
        socket.on("connect", function () {
            smode("Waiting");
            status(WAIT_TESTS);
        });

        //socket.on("message", incoming);
        
        socket.on("ready", function(msg) {
            if (!clientID) {
                clientID = msg.id;
            }
        });
        socket.on("tests", incoming);
        socket.on("abort", abort);
        socket.on("reset", reset);
        socket.on("exit", abort);
        socket.on("complete", function() {
            smode("Complete");
        });

        socket.on("disconnect", function () {
            setTimeout(wait, 1500);
            status(RETRY);
        });
    }

    var report = function(data) {
        smode("Results Sent!");
        status('Sending results to server.');
        navigate('about:blank');
        var data = {
            batch: currentBatch,
            results: data.results,
            tests: tests.length,
            clientID: clientID,
            ua: navigator.userAgent
        };
        socket.emit('results', data);
    };

    // public API
    return {
        // called once by the Yeti runner
        start : function START (config) {
            frame = createFrame();
            TIMEOUT = config.timeout || DEFAULT_TIMEOUT;
            wait();
        },
        // called by run.js when test activity occurs
        heartbeat : function BEAT () {
            // update the heartbeat symbol
            _("beat").style.visibility = "visible";
            setTimeout(function () {
                // turn it off after a short time
               _("beat").style.visibility = "hidden";
            }, 50);
            heartbeats++;
            reaper(YETI.next); // restart the reaper timer
        },
        // called by run.js when it's ready to move on
        next : function NEXT (f) {
            if (f === FAILED) {
                report({
                   results: {
                        passed: 0,
                        failed: 1,
                        name: 'Timeout: ' + currentURL
                   }
                });
            }
            tests.length ? dequeue() : complete();
        },
        abort: function ABORT () {
            abort();
        },
        reset: function RESET () {
            reset();
        },
        report: function REPORT (data) {
            report(data);
            YETI.next();
        }
    };

})(
    window,
    document
);
