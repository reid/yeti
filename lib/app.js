var ui = require("./ui");
var visitor = require("./visitor");
var server = require("./server");
var http = require("./http");
var pkg = require("./package");
var color = require('./color').codes;
var io = require('socket.io-client');

// Nicely format fatal errors with ui.exit.
process.on("uncaughtException", function (e) {
    ui.exit(e);
});

var showConnected = function(config) {
    ui.info('checking for connected clients..');
    var d = {
	method: 'GET',
        host : config.host,
        port : config.port,
	path: '/connections'
    };
    http.request(d).on('response', function(res, response) {
	var json = JSON.parse(response);
	['open', 'closed', 'connected'].sort().forEach(function(k) {
		ui.info('clients ' + k + ': ' + json[k].length);
	});
	var br = json.browsers.sort();
	var b = [];
	br.forEach(function(l) {
		var data = {};
		var d = l.split(' / ');
		data.browser = d[0];
        if (d[1]) {
            d = d[1].split(' from ');
            data.os = d[0];
            d = d[1].split(' ');
            data.ip = d[0];
            data.id = d[1];
            b.push(data);
        }
	});
	var lens = { browser: 0, os: 0, ip: 0, id: 0 };
	b.forEach(function(d) {
		Object.keys(d).forEach(function(o) {
			var itemLen = d[o].length;
			if (itemLen > lens[o]) {
				lens[o] = itemLen;
			}
		});
	});
	var bar = function(d, key) {
		var line = '';
		if (d.length < lens[key]) {
			for (var i = d.length; i < lens[key]; i++) {
				line += ' ';
			}
		}
		return line;
	};
	if (b.length) {
		ui.info('browsers connected: ');
		var line = '     | ' + color.info('Browser') + bar('browser', 'browser');
		line += ' | ' + color.debug('OS') + bar('OS', 'os');
		line += ' | ' + color.warn('IP') + bar('IP', 'ip');
		line += ' | ' + color.warn('SESSION') + bar('SESSION', 'id') + ' |';
		var l = '';
		for (var i = 0; i < line.length; i++) {
			l += '-'
		}
		ui.puts(l);
		ui.puts(line);
		ui.puts(l);
		b.forEach(function(d) {
			var line = '     | ' + color.info(d.browser) + bar(d.browser, 'browser');
			line += ' | ' + color.debug(d.os) + bar(d.os, 'os');
			line += ' | ' + color.warn(d.ip) + bar(d.ip, 'ip');
			line += ' | ' + color.warn(d.id) + bar(d.id, 'id') + ' |';
			ui.puts(line);
		});
	}
	
    });
};

var issueAbort = function(config) {
    ui.info('Issuing batch abort..');
    var d = {
	method: 'GET',
        host : config.host,
        port : config.port,
	    path: '/abort'
    };
    http.request(d).on('response', function(res, response) {
	    var json = JSON.parse(response);
    });
};

var issueReset = function(config) {
    ui.info('Issuing reset..');
    var d = {
	method: 'GET',
        host : config.host,
        port : config.port,
	    path: '/reset'
    };
    http.request(d).on('response', function(res, response) {
	    var json = JSON.parse(response);
    });
};

// The entrypoint of Yeti.
exports.boot = function (config) {
    
    // Assume the Yeti server is on the same computer.
    if (!config.host) config.host = "localhost";

    if (config.connected) {
        return showConnected(config);
    }

    if (config.abort) {
        return issueAbort(config);
    }

    if (config.reset) {
	    return issueReset(config);
    }

    ui.dots(config.dots);

    if (config.version) {
        var ver;
        try {
            ver = pkg.readPackageSync().version;
        } catch (ex) {
            ver = "unknown";
        }
        ui.puts(ver);
        process.exit(0);
    }

    // Set a flag for ui to print debug() messages.
    ui.verbose(config.verbose);

    // Was `--browsers` provided on the command line?
    config.forceVisit = !!config.browsers;

    // Provide an appropiate browser if one wasn't given.
    if (
        "string" !== typeof config.browsers
    ) config.browsers = require("./browsers").Browser.canonical();

    if (config.browsers) {
        config.browsers = config.browsers.split(",");
    } else {
        config.browsers = [];
    }

    // Suppress debug() and log() ui messages.
    if (config.quiet) ui.quiet(config.quiet);


    // Configuration is done.
    fromConfiguration(config);

};

function fromConfiguration (config) {
    
    if (config.reconnect) {
        ui.info('Reconnecting to results server..');
        getYetiResults(config);
        return
    }
    // If no files were provided, we're probably
    // starting up the Yeti server.
    if (!config.files.length) {
        try {
            server.fromConfiguration(config);
        } catch (e) {
            // Don't fallback to `uncaughtException`, show a helpful message:
            ui.log(e);
            ui.exit("Unable to start the server. Is it already running?");
        }
        return;
    }

    // Attempt to add our test files.

    var d = {
        host : config.host,
        port : config.port
    };

    d.method = "PUT";
    d.path = "/tests/add";
    d.body = { tests : visitor.composeURLs(
        "",
        config.path,
        config.files
    ) };
    var req = http.request(d);

    if (config.solo) {
        ui.start();
        var l = config.files.length;
        while (l--) ui.pending();
    }

    req.on("response", function (res, result) {
        if (res.statusCode !== 200) {
            return ui.exit("Unable to run tests: " + result);
        }
        ui.info("Waiting for results of batch " + result + ".");
        getYetiResults(config);
    });

    // Couldn't add the tests. Continue in standalone mode.
    req.on("error", function () {
        server.fromConfiguration(config);
    });
};

var responseTimer,
    startStamp,
    endStamp,
    sentDone;

var resultsDone = function() {
    if (sentDone) {
        return;
    }
    sentDone = true;
    ui.log("Batch started at: " + startStamp);
    ui.log("Batch completed at: " + endStamp);
    ui.summarize();
};

var getYetiResults = function(config) {
    
	//process.on('SIGINT', resultsDone);

    startStamp = new Date();
    ui.start();

    if (config.ignorepass) {
        ui.info('Ignoring passing tests..');
    }

    var socket = io.connect('http://' + config.host + ':' + config.port + '/results');
    socket.on('result', function(result) {
        endStamp = new Date(); //Cache end stamp with the last result received..
        if (responseTimer) {
            clearTimeout(responseTimer);
        }
        responseTimer = setTimeout(function() {
            ui.log('No response from server in 60 seconds, exiting');
            socket.emit('timeout', true);
            resultsDone();
        }, (60000 * 3));

        if (result.failed || (!config.ignorepass)) {
            ui.results(result);
		}
    });

    socket.on('done', resultsDone);

    socket.on('exit', function() {
        ui.info('Received an exit from the server, exiting..');
        process.exit();
    });
};



exports.fromConfiguration = fromConfiguration;
