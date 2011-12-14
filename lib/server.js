var express = require("express");
var http = require("http");
var events = require("events");
var url = require('url');
var io = require("socket.io");
var ioClient = require("socket.io-client");

var sendfiles = require("./sendfiles").sendfiles;
var ui = require("./ui");
var visitor = require("./visitor");
var pkg = require("./package");
var fs = require('fs');
var fspath = require('path');

var forAgent = require('./browsers').Browser.forAgent;

var testResults = [];
var numConnected = 0;

// testId (batch) -> socket.io client IDs when batch was created
var currentBatch;


// Return a random whole number as a string with `Math.random`.
function makeId () {
    var id = ((new Date()).getTime()) + '-' + (Math.random() * 0x1000000|0); //Make sure that we NEVER duplicate a batch id
    return id;
}

var emitterRegistry = {}; // by port

var cachebuster = makeId();

// Returns a JSON string of all property-value pairs
// of `keys` in `req`.
function jsonize (req, keys) {
    var o = {};
    keys.forEach(function (k) {
        var v = req.param(k);
        if (v) o[k] = v;
    });
    return JSON.stringify(o);
}

function serveExpress (config, cb) {
    
	process.on('SIGINT', function() {
		ui.debug('Sending abort signal to all clients');
        ioYeti.emit('exit', true);
        ioResults.emit('exit', true);
		ui.debug('Exiting for real now..');
		process.exit();
	});
    
    if (config.reporter) {
        var str = 'with socket.io';
        if (config.reportpost) {
            str = 'with a post request.';
        }
        ui.info('Broadcasting test results to:', config.reporter, str);
    }

    var port = config.port;
    var path = config.path;
    // Create an `EventEmitter` for test-related events.
    var tests = new events.EventEmitter;

    var app = express.createServer(
        express.methodOverride(),
        express.bodyParser()
    );
    
    var socket = io.listen(app);
    //Socket.io client listener
    var ioResults = socket.of('/results');
    ioResults.on('timeout', function() {
        cleanUp();
        ui.log('Received a timeout from the client, cleaning up this batch');
    });
    var ioYeti = socket.of('/yetitests');

    var logLevel = 1;
    if (config.debugsocket) {
        logLevel = 3;
    }

    socket.set('log level', logLevel);
    socket.set('polling duration', '15');
    socket.set('close timeout', '20');
    socket.set('heartbeat timeout', '2');
    socket.set('heartbeat interval', '4');
    socket.set('transports', ['websocket', 'flashsocket', 'xhr-polling', 'jsonp-polling', 'htmlfile' ]);

    app.set("views", __dirname + "/views");
    app.set("view engine", "jade");

    // Use our version of Jade.
    app.register(".jade", require("jade"));

    app.get("/", function (req, res) {
        tests.emit("visitor", req.ua);
        var json = jsonize(req, ["transport", "timeout"]);

        res.header("Expires", "0");
        res.header("Pragma", "no-cache");
        res.header("Cache-Control", "no-cache");

        res.render("index", {
            bootstrap : "YETI.start(" + json + ")",
            yeti_version : pkg.readPackageSync().version,
            remote_ip: req.connection.remoteAddress
        });
    });


    // Add a new test. Called by the CLI in `app.js`.
    app.put("/tests/add", function (req, res) {
        if (!req.body.tests.length) {
            return res.send("No tests provided. Possible Yeti bug!", 500);
        }
        if (currentBatch) {
            return res.send("Batch already running (" + currentBatch + "). Either abort or wait until this batch is complete.", 500);
        }

        var urls = [];
        var id = makeId();

        req.body.tests.forEach(function (url) {
            urls.push("/project/" + id + url);
        });
        ui.debug("/tests/add: registered batch", id);

        tests.emit("add", id, urls);
        res.send(id);
    });
    // Comet middleware.
    // Sends a response when a test comes in.
    
    var clientCache = {};

    var parseClient = function(id, ua) {
	    var c = socket.handshaken[id];
        var ip = '';
        if (!c && clientCache[id]) {
            c = clientCache[id];
        }
	    if (c) {
            clientCache[id] = c;
	        ip = ' using ' + forAgent(c.headers['user-agent']) + ' from ' + c.address.address;
	    } else if (ua) {
	        ip = ' using ' + forAgent(ua);
        }
        return id + ip;
    };

    var getClientIP = function(id) {
	    var c = socket.handshaken[id];
        var ip = 'unknown';
        if (!c && clientCache[id]) {
            c = clientCache[id];
        }
	    if (c) {
            clientCache[id] = c;
	        ip = c.address.address;
	    }
        return ip;
    };

    ioYeti.on('disconnect', function() {
        console.log('DISCONNECT');
        console.log(arguments);
    });

    var postResults = function(data) {
        if (config.reporter && data.batch) {
            if (config.reportpost) {
                ui.debug('Posting results with POST');
                var u = url.parse(config.reporter);
                var c = {
                    method: 'POST',
                    host: u.hostname,
                    port: parseInt(u.port),
                    path: u.pathname,
                    headers: {
                       'Content-type':  'application/json'
                    }
                };
                var req = http.request(c, function(res) {});
                req.write(JSON.stringify(data));
                req.on('error', function(e) {});
                req.end();
            } else {
                ui.debug('Posting results with socket.io');
                var socket = ioClient.connect(config.reporter);
                socket.emit('submit', data);
            }
        }
    };

    var handleResults = function(message) {
        var result = message.results;
        result.ua = message.ua;
        var id = message.batch;
        var clientID = message.clientID;

        ui.info("/io::results:", id, " has results from: " + parseClient(clientID, message.ua));

        ui.info(parseClient(clientID), ' has ', message.tests, 'tests left to execute.');
        //Broadcast the results to the /results namespace
        ioResults.emit('result', message);
        
        //ui.debug(result);

        testResults.push(result);
        handleDone();
    };

    var cleanUp = function() {
        if (currentBatch) {
            postResults({
                batch: currentBatch,
                results: testResults
            });
        }
        currentBatch = null;
        testResults = [];
        ioYeti.emit('complete', true);
        //Notify the CLI that we are done..
        ioResults.emit('done', true);
    };

    var handleDone = function() {
        ui.debug('Checking for remaining clients, there are currently ' + numConnected + ' connected to Yeti.');
        if (currentBatch && numConnected === 0) {
            ui.info('All pending tests completed, exiting..');
            ui.info("Really done!");
            cleanUp();
        }
    };

    ioYeti.on("connection", function(client) {
        ui.info("Yeti loves " + parseClient(client.id));
        
        client.emit('ready', {
            id: client.id
        });

        client.on('results', handleResults);
        client.on('done', function() {
            numConnected--;
            ui.debug('Client done, ' + numConnected + ' remaining');
            handleDone();
        });
        
    });

    tests.on("add", function testAdd (id, urls) {
        numConnected = Object.keys(socket.connected).length;
        ui.debug("Broadcasting test URLs", urls, "to", numConnected, "clients");
        ioYeti.emit('tests', {
            batch : id,
            tests : urls
        });
        currentBatch = id;
        testResults = [];
    });

    app.get('/abort', function(req, res) {
        currentBatch = false;
        ui.info('Abort received, sending message to all clients');
        ioYeti.emit('abort', true);
        res.send({
            sent: true
        });
    });

    app.get('/reset', function(req, res) {
        currentBatch = false;
        ioYeti.emit('reset', true);
        res.send({
            sent: true
        });
    });

    app.get('/refresh', function(req, res) {
    	setTimeout((function(req, res) {
            return function() {
                res.redirect(req.headers['referer'] || '/');
            }
        })(req, res), 1000);
    });

    app.get('/connections', function(req, res) {
        var browsers = [];
        Object.keys(socket.connected).forEach(function(id) {
            var c = socket.handshaken[id];
            browsers.push(forAgent(c.headers['user-agent']) + ' from ' + c.address.address + ' ' + id);
        });
        res.send({
            connected: Object.keys(socket.connected),
            open: Object.keys(socket.open),
            closed: Object.keys(socket.closed),
            browsers: browsers
        });
    });

    app.get('/undefined', function(req, res) {
        ui.debug("Possible Yeti bug, we were sent to /undefined");
        res.send("<script>parent.parent.YETI.next()</script>");
    });

    // #### File Server

    var projectSend = function (res, file, appendString, nocache, prependString) {
        sendfiles.call(
            res,
            [file],
            appendString,
            null, // callback
            {
                prependString : prependString,
                cache : !nocache
            }
        );
    };

    app.get('/project/*', function (req, res) {

        var nocache = false;
        var splat = req.params.pop().split("/");
        splat.shift();
        nocache = true; // using a unique url
        if (splat[0] === "") splat.shift(); // stupid leading slashes
        splat = splat.join("/");

        var file = "/" + decodeURIComponent(splat);

        // The requested file must begin with our cwd.
        if (file.indexOf(path) !== 0) {
            // The file is outside of our cwd.
            // Reject the request.
	    /*
            ui.log(ui.color.red("[!]")
                + " Rejected " + file
                + ", run in the directory to serve"
                + " or specify --path.");
            return res.send(403);
	    */
            ui.log(ui.color.red("[!]")
                + " Rejected " + file
                + " Issuing an abort for this client.");
            return res.send("<script>parent.parent.YETI.abort()</script>");
        }

        if (/^.*\.html?$/.test(req.url)) {
            // Inject a test reporter into the test page.
            projectSend(
                res, file,
                "<script src=\"/dyn/" + cachebuster
                + "/inject.js\"></script><script>"
                + "$yetify({url:\"/results\"});</script>",
                nocache
            );
        } else {
            // Everything else goes untouched.
            projectSend(res, file, "", nocache);
        }

    });

    var incSend = function (res, name, nocache) {
        sendfiles.call(
            res,
            [__dirname + "/../inc/" + name],
            "", // appendString
            null, // callback
            {
                cache : !nocache
            }
        );
    };

    app.get("/inc/*", function (req, res) {
        incSend(res, req.params);
    });

    app.get("/dyn/:cachebuster/*", function (req, res) {
        incSend(res, req.params, true);
    });

    app.get("/favicon.ico", function (req, res) {
        incSend(res, "favicon.ico", true);
    });

    // Start the server.
    // Workaround Express and/or Connect bugs
    // that strip out the `host` and `callback` args.
    // n.b.: Express's `run()` sets up view reloading
    // and sets the `env` to `process.env.ENV`, etc.
    // We are bypassing all of that by using http directly.
    http.Server.prototype.listen.call(app, port, null, cb);

    // Publish the `tests` emitter.
    emitterRegistry[port] = tests;

    return app;

}

// Handle the CLI server start request. Called from `app.js`.
// Starts the server, prints a message and may open browsers as needed.
// Called when the server isn't already running.
function fromConfiguration (config) {

    var cb = config.callback;
    cb = cb || null;

    var app = serveExpress(config, cb);

    var baseUrl = "http://" + config.host + ":" + config.port;

    var urls = visitor.composeURLs(
        baseUrl,
        "project" + config.path,
        config.files
    );

    if (urls.length) return visitor.visit(
        config.browsers,
        urls
    );

    ui.log("Yeti will only serve files inside " + config.path);
    ui.log("Visit " + ui.color.bold(baseUrl) + ", then run:");
    ui.log("    yeti <test document>");
    ui.log("to run and report the results.");

    if (config.forceVisit) {
        ui.log("Running tests locally with: " + config.browsers.join(", "));

        return visitor.visit(
            config.browsers,
            [baseUrl]
        );
    }

    return app;
}

// Get the cachebuster for unit tests.
exports.getCachebuster = function () {
    return cachebuster;
};

// Get the `tests` emitter for unit tests.
exports.getEmitterForPort = function (port) {
    return emitterRegistry[port];
}

// Get the ports we've used for unit tests.
exports.getPorts = function () {
    return Object.keys(emitterRegistry);
}

exports.fromConfiguration = fromConfiguration;
exports.serve = serveExpress;
