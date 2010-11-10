YETI = (function yeti (window, document, evaluator) {

    var RETRY = "Server error, retrying in 5 seconds.",
        WAIT_FOR = "Waiting for ",
        WAIT_TESTS = WAIT_FOR + "tests.",
        XMLHTTPREQUEST = "XMLHttpRequest",
        READYSTATE = "readyState",
        CONTENTWINDOW = "contentWindow",
        ENDPOINT = "/tests/wait",
        DEFAULT_TIMEOUT = 30000, // after this many ms of no activity, skip the test
        setTimeout = window.setTimeout,
        clearTimeout = window.clearTimeout,
        heartbeats = 0, // counter for YETI.heartbeat() calls
        reaperSecondsRemaining = 0, // counter for UI
        frame = null, // test target frame's contentWindow
        tests = [], // tests to run
        elementCache = {}, // cache of getElementById calls
        idle = true, // = !(tests_running)
        nativeXHR = window[XMLHTTPREQUEST],
        xhr, // returns an XMLHttpRequest
        TIMEOUT, // see START, config.timeout || DEFAULT_TIMEOUT
        source, // the EventSource
        wait, // holder for the wait() function
        startTime, // for elapsed time
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
        frame.location.replace(url)
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
        fn = function () {
            console.log("reaper has arrived.");
            fn();
        };
        var second = 1000;
        phantom();
        reaperTimeout = setTimeout(fn, TIMEOUT);
        reaperSecondsRemaining = Math.floor(TIMEOUT / second);
        (function SYNCUI () {
            var bpm = Math.round(
                ( (heartbeats * 60000) / ( (new Date).getTime() - startTime ) )
            );
            if (!isNaN(bpm) && bpm > 0) {
                // add a leading zero if needed, always 2 digits
                if ((""+bpm).length < 2) bpm = "0" + bpm;
                setContent("pulse", bpm);
            }
            setContent("timer", reaperSecondsRemaining);
            setContent("heartbeats", heartbeats);
            reaperSecondsRemaining--;
            if (reaperSecondsRemaining > 0)
                syncUITimeout = setTimeout(SYNCUI, second);
        })();
    }

    // handling incoming data from the server
    // this may be from EventSource or XHR
    function incoming (data) {
        smode("Data");
        if ("string" === typeof data) data = JSON.parse(data);
        var response = data;
        if (response.shutdown) {
            // the server was shutdown. no point in reconnecting.
            if (source) source.close();
            status("The server was shutdown. Refresh to reconnect.");
            mode("Offline");
            return;
        }

        if (response.tests.length) {
            mode("Run");
            heartbeats = 0;
            startTime = (new Date).getTime();

            var t = response.tests;
            for (var i in t) tests.push(t[i]);
            idle && dequeue(); // run if necessary
        }
        wait();
    }

    // factories for the wait() function

    function patientEventSource () {
        function setupEventSource () {
            source = new EventSource(ENDPOINT);
            source.onmessage = function (e) {
                incoming(e.data);
            };
            source.onerror = function () {
                if (source[READYSTATE] === 2) {
                    // connection was closed
                    source = null;
                    setTimeout(wait, 5000);
                    status(RETRY);
                }
            };
        }
        return function waitEventSource () {
            source || setupEventSource();
            smode("Listening EV");
            status(WAIT_TESTS);
        }
    }

    if (nativeXHR) {
        xhr = function () { return new nativeXHR(); }
    } else {
        xhr = function () {
            try {
                return new window.ActiveXObject("Microsoft.XMLHTTP");
            } catch (e) {}
        };
    }

    function patientXHR () {
        return function waitXHR () {
            var poll,
                req = xhr();
            if (!req) return status("Unable to create " + XMLHTTPREQUEST);
            req.open("POST", ENDPOINT, true);

            // prevent memory leaks by polling
            // instead of using onreadystatechange
            poll = window.setInterval(function () {
                if (req[READYSTATE] === 0) {
                    // server is down
                } else if (req[READYSTATE] === 4) {
                    var data = req.responseText;
                    if (req.status === 200 && req.responseText) {
                        incoming(req.responseText);
                    } else {
                        setTimeout(wait, 5000);
                        status(RETRY);
                    }
                } else {
                    return;
                }
                // readystate is either 0 or 4, we're done.
                req = null;
                window.clearInterval(poll);
            }, 50);

            status(WAIT_TESTS);
            smode("Listening XHR");
            req.send(null);
        };
    }

    // Accept Reject buttons
    function override (pass) {
        var url = frame.location.href;
        console.log(url);
        if (url === "about:blank") return;

        var r = {
            results : {
                name : url,
                total : 1,
                passed : 0,
                failed : 0,
                data : {
                    name : "Manual test (yeti virtual test)",
                    passed : 0,
                    failed : 0,
                    data : {
                        name : "Accept button should be pressed",
                        message : "",
                        result: "pass"
                    }
                }
            }
        };

        // kind of hacky!

        if (pass) {
            r.results.passed = 1;
            r.results.data.passed = 1;
        } else {
            r.results.failed = 1;
            r.results.data.failed = 1;
            // TODO accept user input
            r.results.data.data.message = "Reject button should not be pressed.";
            r.results.data.data.result = "fail";
        }

        // send results!
        // TODO optimize. lots of dup code. got 'er done.
        var poll,
            req = xhr();
        if (!req) return status("Unable to create " + XMLHTTPREQUEST);
        req.open("POST", "/results", true);

        // prevent memory leaks by polling
        // instead of using onreadystatechange
        poll = window.setInterval(function () {
            if (req[READYSTATE] === 0) {
                // server is down
            } else if (req[READYSTATE] === 4) {
                var data = req.responseText;
console.log("next from xhr?");
                if (req.status === 200) next();
                else incoming({shutdown:"true"}); // uh-oh!
            } else {
                return;
            }
            // readystate is either 0 or 4, we're done.
            req = null;
            window.clearInterval(poll);
        }, 50);

        status("Submitting result...");
        smode("XHR Data");
        req.setRequestHeader("Content-Type", "application/json");
        req.send(JSON.stringify(r));
    }

    function attachEvent (ev, el, cb) {
        if (el.addEventListener) {
            el.addEventListener(ev, cb, false);
        } else if (el.attachEvent) {
            el.attachEvent('on' + ev, cb);
        }
    };

    // run the next test
    function dequeue () {
        idle = false;
        var url = tests.shift();
        status(WAIT_FOR + "results: " + url);
console.log("go! " + url);
        navigate(frame, url);
console.log("next from dequeue?");
        reaper(YETI.next);
    }

    // stop running all tests, restart with dequeu()
    function complete () {
        idle = true;
        phantom();
        navigate(frame, "about:blank");
        status("Done. " + WAIT_FOR + "new tests.");
        mode("Idle");
    }

    // public API
    return {
        // called once by the Yeti runner
        start : function START (config) {
            var transport = config.transport,
                supportEV = "undefined" !== typeof EventSource,
                forceXHR = transport == "xhr",
                forceEV = transport == "eventsource";
            TIMEOUT = config.timeout || DEFAULT_TIMEOUT;
            frame = createFrame();
            attachEvent("click", _("reject"), function () {
                override(false);
            });
            attachEvent("click", _("accept"), function () {
                override(true);
            });
            wait = (
                supportEV
                && (!forceXHR || forceEV)
            ) ? patientEventSource() : patientXHR();
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
console.log("next from beat?");
            reaper(YETI.next); // restart the reaper timer
        },
        // called by run.js when it's ready to move on
        next : function NEXT () {
console.log("called next...");
            // tests.length ? dequeue() : complete();
        }
    };

})(
    window,
    document,
    // you can't minify any JS with eval() in its scope
    // provide this toxic function in its own little box
    function (d) { return eval("(" + d + ")"); }
);
