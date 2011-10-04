var express = require("express");
var http = require("http");
var events = require("events");
var io = require("socket.io");

var sendfiles = require("./sendfiles").sendfiles;
var ui = require("./ui");
var visitor = require("./visitor");
var pkg = require("./package");
var fs = require('fs');
var fspath = require('path');

var forAgent = require('./browsers').Browser.forAgent;

var testIds = {};
var testResults = {};

// testId (batch) -> socket.io client IDs when batch was created
var testClients = {};
var clientsComplete = {};
var clientsWaiting = {};
var resultCache = {}; //Cache the results even after the test is run

// Return a random whole number as a string with `Math.random`.
function makeId () {
    var id = (Math.random() * 0x1000000|0) + "";
    while (! id in resultCache) {
    	id = (Math.random() * 0x1000000|0) + "";
    }
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
    var ioYeti = socket.of('/yetitests');

    var logLevel = 1;
    if (config.debugsocket) {
        logLevel = 3;
    }

    socket.set('log level', logLevel);
    socket.set('polling duration', '35');
    socket.set('close timeout', '30');
    socket.set('heartbeat timeout', '3');
    socket.set('heartbeat interval', '5');
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
        var clients = Object.keys(socket.connected);

        if (!clients.length) {
	    //Removed since new clients will auto receive the tests
            //return res.send("Nothing is listening to this batch. At least one browser should be pointed at the Yeti server.", 500);
        }

        var urls = [];
        var id = makeId();

        req.body.tests.forEach(function (url) {
            urls.push("/project/" + id + url);
        });
        ui.debug("/tests/add: registered batch", id);

        tests.emit("add", id, urls, clients);
        res.send(id);
    });
    // Comet middleware.
    // Sends a response when a test comes in.
    
    var parseClient = function(id) {
	    var c = socket.handshaken[id];
        var ip = '';
	    if (c) {
	        ip = ' using ' + forAgent(c.headers['user-agent']) + ' from ' + c.address.address;
	    }
        return id + ip;
    };

    var getClientIP = function(id) {
	    var c = socket.handshaken[id];
        var ip = 'unknown';
	    if (c) {
	        ip = c.address.address;
	    }
        return ip;
    };

    ioYeti.on('disconnect', function() {
        console.log('DISCONNECT');
        console.log(arguments);
    });

    var clientPings = {};

    var handleResults = function(message) {
        var result = message.results;
        result.ua = message.ua;
        var id = message.batch;
        var clientID = message.clientID;
        var clients = testClients[currentBatch];

        ui.info("/io::results:", id, " has results from: " + parseClient(clientID));

        ui.info(parseClient(clientID), ' has ', message.tests, 'tests left to execute.');
        //Broadcast the results to the /results namespace
        ioResults.emit('result', message.results);
        //ui.debug(result);

        resultCache[id] = resultCache[id] || [];
        resultCache[id].push(result);

        //ui.debug('Current Result Cache', resultCache);

        if (clientPings[clientID]) {
            clearTimeout(clientPings[clientID]);
        }
        
        if (message.tests === 0) {
            ui.debug('Client has no more tests to run, removing');
            clientsComplete[clientID] = true;
            clients = clients.filter(function (id) {
                var ret = id !== clientID;
                return ret;
            });
            testClients[currentBatch] = clients;
        } else {

            clientPings[clientID] = setTimeout((function(cid) {
                return function() {
                    ui.debug('Client failed to connect in 45 seconds, removing:', cid);
                    var clients = testClients[currentBatch];
                    if (clients) {
                        clients = clients.filter(function (id) {
                            var ret = id !== cid;
                            return ret;
                        });
                    }
                    testClients[currentBatch] = clients;
                    handleDone();
                }
            })(clientID), 45000);

        }

        if (id in testIds) {
            if (tests.listeners(id).length) {
                tests.emit(id, result);
            } else {
                if ( ! (id in testResults) ) {
                    testResults[id] = [];
                }
                testResults[id].push(result);
            }
        } else {
            ui.results(result);
        }
        handleDone();
    };

    var handleDone = function() {
        ui.debug('Checking for remaining clients..');
        var clients = testClients[currentBatch];
        if (!clients || (clients && clients.length === 0)) {
            ui.info('All pending tests completed, exiting..');
            ui.info("Really done!");
            currentBatch = false;
            batchComplete = true;
            ioYeti.emit('complete', true);
            //Notify the CLI that we are done..
            ioResults.emit('done', true);
        }
    };

    ioYeti.on("connection", function(client) {
        ui.info("Yeti loves " + parseClient(client.id));

        client.emit('ready', {
            id: client.id
        });

        client.on('results', handleResults);

        if (currentBatch) {
            var clients = testClients[currentBatch];
            if (clients && !clientsComplete[client.id]) {
                var registered = clients.some(function(id) {
                    return id === client.id;
                });
                ui.info('Client already registered?', registered);
                if (!registered) {
                    ui.info('Sending tests to this client');
                    testClients[currentBatch].push(client.id);
                    client.emit('tests', {
                        batch : currentBatch,
                        tests : testHash[currentBatch].urls
                    });
                }
            }
        }
    });

    /*
    ioYeti.on("connection", function wait (client) {
	    var ip = ((client.connection && client.connection.remoteAddress) ? ' from ' + client.connection.remoteAddress : '');
	    var c = socket.handshaken[client.id];
	    if (c) {
	        ip = ' using ' + forAgent(c.headers['user-agent']) + ' from ' + c.address.address;
	    }
        ui.info("Yeti loves " + client.id + ip);
        if (currentBatch) {
            var clients = testClients[currentBatch];
            if (clients && !clientsComplete[client.id]) {
                var registered = clients.some(function(id) {
                    return id === client.id;
                });
                ui.info('Client already registered?', registered);
                if (!registered) {
                    ui.info('Sending tests to this client');
                    testClients[currentBatch].push(client.id);
                    client.json.send({
                        batch : currentBatch,
                        tests : testHash[currentBatch].urls
                    });
                }
            }
        }
        client.on("message", function (message) {
            // On done, remove from testClients.
            // If testClients is now empty, notify the CLI we're done.
            var batch = message.batch;

	        ui.debug('Received client message');
	        //ui.debug(message);

            if (message.status === "done") {
                if (batch in testClients) {
                    var clients = testClients[message.batch];

                    // Remove this sessionId from clients.
                    ui.info("YUP, done!");
		            ui.debug('Removing client:', client.id);
                    clientsComplete[client.id] = true;
                    ui.debug(clients);
                    clients = clients.filter(function (id) {
                        var ret = id !== client.id;
                        var c = socket.connected[id]; //Client is undefined
                        if (!c && !ret) {
                            var c2 = socket.handshaken[id];
                            if (c2) {
                                id += ' using ' + forAgent(c2.headers['user-agent']) + ' from ' + c2.address.address;
                            }
                            ui.warn('Removing stale client session: ' + id);
                            ret = !!c;
                        }
                        return ret;
                    });
                    ui.debug(clients);
                    testClients[batch] = clients;

                    // If clients is now empty, notify the CLI we're done.
                    if (!clients.length) {
                        ui.info("Really done!");
                        currentBatch = false;
                        batchComplete = true;
                        ioYeti.emit('complete', true);
                        //Notify the CLI that we are done..
                        ioResults.emit('done', true);
                    } else {
                        clients.forEach(function(id) {
                            var c = socket.handshaken[id];
                            if (c) {
                                 ui.debug('still waiting for client ' + id + ' using ' + forAgent(c.headers['user-agent']) + ' from ' + c.address.address);
                            } else {
                                 ui.debug('still waiting for unknown client ' + id);
                            }
                        });
                    }
                } else {
                    ui.log("Warning: Unknown batch (" + batch + ") completion. Yeti bug!");
                }
            } else if (message.status === 'results') {
                var result = message.results;
                result.ua = message.ua;
                var id = message.batch;

                ui.info("/io::results:", id, " has results from: " + forAgent(result.ua));
                ui.info(id, ' has ', message.tests, 'tests left to execute.');
                //Broadcast the results to the /results namespace
                ioResults.emit('result', message.results);
                //ui.debug(result);

                resultCache[id] = resultCache[id] || [];
                resultCache[id].push(result);

                //ui.debug('Current Result Cache', resultCache);

                if (id in testIds) {
                    if (tests.listeners(id).length) {
                        tests.emit(id, result);
                    } else {
                        if ( ! (id in testResults) ) {
                            testResults[id] = [];
                        }
                        testResults[id].push(result);
                    }
                } else {
                    ui.results(result);
                }
            } else {
                ui.debug("Unknown message from " + client.id);
            }
        });
    });
    */

    var testHash = {},
	currentBatch, batchComplete = false;

    tests.on("add", function testAdd (id, urls, clients) {
        ui.debug("Broadcasting test URLs", urls, "to", clients.length, "clients");
        ioYeti.emit('tests', {
            batch : id,
            tests : urls
        });
	testHash[id] = {
		urls: urls,
		id: id,
		clients: clients
	};
	batchComplete = false;
	currentBatch = id;
        testIds[id] = 1;
        testClients[id] = clients;
    });


    app.get("/batch/:id", function (req, res) {
        var id = req.params.id;
	if (id in resultCache) {
	    res.send(resultCache[id]);
	} else {
            res.send("Batch not found, it should be registered first with /tests/add. Possible Yeti bug!", 404);
	}
    });
    // Respond when test results for the given batch ID arrive.
    // Called by the CLI in `app.js`.
    app.get("/status/:id", function (req, res) {
        var id = req.params.id;
	ui.info('Status check for batch: ' + id);
	if (batchComplete) {
	    ui.info('Current batch is complete, notify the CLI..');
	    return res.send({ status: 'done', batch: id });
	}
        if (id in testIds) {
            if (id in testResults) {
                var results = testResults[id].shift();
                if (results) {
                    return res.send(results);
                } else {
                    // nothing in the queue
                    delete testResults[id];
                    // fallthrough to the test listener
                }
	    }
            tests.once(id, function (results) {
                res.send(results);
            });
        } else {
            res.send("Batch not found, it should be registered first with /tests/add. Possible Yeti bug!", 404);
        }
    });
	/*
    // Recieves test results from the browser.
    app.post("/results", function (req, res) {
        var result = JSON.parse(req.body.results);
        result.ua = req.body.useragent;
        var id = req.body.id;

        ui.info("/results:", id, " has results from: " + result.ua);
	//ui.debug(result);

	resultCache[id] = resultCache[id] || [];
        resultCache[id].push(result);

	//ui.debug('Current Result Cache', resultCache);

        if (id in testIds) {
            if (tests.listeners(id).length) {
                tests.emit(id, result);
            } else {
                if ( ! (id in testResults) ) {
                    testResults[id] = [];
                }
                testResults[id].push(result);
            }
        } else {
            ui.results(result);
        }

        // Advance to the next test immediately.
        // We do this here because determining if an iframe has loaded
        // is much harder on the client side. Takes advantage of the
        // fact that we're on the same domain as the parent page.
        res.send("<script>parent.parent.YETI.next()</script>");

    });*/

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
        if (splat[0] in testIds) {
            splat.shift();
            nocache = true; // using a unique url
        }
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
