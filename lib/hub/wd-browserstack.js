"use strict";

var request = require("request");
var async = require("async");

var BROWSERS;

function BrowserStack(user, pass) {
    this.baseUrl = "http://api.browserstack.com/3/";
    this.request = request.defaults({
        json: true,
        auth: {
            user: user,
            pass: pass
        }
    });
    this.id = null;
}

BrowserStack.prototype._getBrowsers = function (cb) {
    if (BROWSERS) { return cb(null, BROWSERS); }

    this.request({
        method: "GET",
        url: this.baseUrl + "browsers",
        qs: {
            flat: true
        }
    }, function (err, res, body) {
        if (err) { return cb(err); }
        if (res.statusCode !== 200) {
            return cb(new Error("Unable to list BrowserStack browsers, got code: " + res.statusCode));
        }
        console.log(body);
        BROWSERS = body;
        cb(null, body);
    });
};

BrowserStack.prototype._getMatch = function (browsers, desired) {
    // XXX The hard part!
    var name = desired.browserName,
        version = desired.version,
        platform = desired.platform;

    console.log("filtering to match", desired);
    if (name) {
        name = name.toLowerCase();
        if (name === "internet explorer") {
            name = "ie";
        }
        browsers = browsers.filter(function (browser) {
            if (name === "android") {
                return browser.os === name;
            } else {
                return browser.browser.toLowerCase().indexOf(name) !== -1;
            }
        });
        console.log("name filter", browsers);
    }

    if (version) {
        browsers = browsers.filter(function (browser) {
            if (browser.browser_version) {
                return browser.browser_version === version;
            } else {
                return browser.os_version === version;
            }
        });
        console.log("version filter", browsers);
    }

    if (platform) {
        browsers = browsers.filter(function (browser) {
            return browser.os.toLowerCase() === platform;
        });
        console.log("platform filter", browsers);
    }

    if (browsers.length) {
        return browsers[0];
    }

    console.log("nothing to return");
    return false;
};

BrowserStack.prototype.init = function (desired, cb) {
    var self = this;

    function onBrowsers(browsers, cb) {
        var match = self._getMatch(browsers, desired);
        if (!match) {
            return cb(new Error("Unable to find a BrowserStack browser for the given requirements."));
        }
        cb(null, match);
    }

    async.waterfall([
        self._getBrowsers.bind(self),
        onBrowsers
    ], function (err, match) {
        if (err) { return cb(err); }
        self.matchedBrowser = match;
        cb(null);
    });
};

BrowserStack.prototype.get = function (url, cb) {
    var self = this,
        query = this.matchedBrowser;

    if (!query) {
        return cb(new Error("BrowserStack init was not called"));
    }

    query.timeout = 3600;
    query.url = url;

    this.request({
        method: "POST",
        url: this.baseUrl + "worker",
        form: query
    }, function (err, res, body) {
        if (err) { return cb(err); }
        console.log("CREATED WORKER", body);
        self.id = body.id;
        cb(null);
    });

};

BrowserStack.prototype.quit = function (cb) {
    if (!this.id) {
        return cb(new Error("BrowserStack get was not called"));
    }

    this.request({
        method: "DELETE",
        url: this.baseUrl + "worker/" + this.id
    }, function (err, res, body) {
        if (err) { return cb(err); }
        if (res.statusCode !== 200) {
            return cb(new Error("Unable to quit BrowserStack browser, got code: " + res.statusCode));
        }
        console.log("DELETE SUCCESSFUL");
        cb(null);
    });
};

// TODO GET /worker/:id for status
BrowserStack.prototype.title = function (cb) {
    console.log("in dummy title");
    this.request({
        method: "GET",
        url: this.baseUrl + "workers"
    }, function (err, res, body) {
        console.log("WORKERS", body);
        cb(body);
    });
};

module.exports = BrowserStack;
