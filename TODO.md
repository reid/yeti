Stickshift
==========

This is the branch for manual test automation. Here's what's broken.

results() is being called on the server yeti instance, not the client.

results show undefined numbers.

When a manual test is submitted, next() happens when it shouldn't.

When the other YUI fixtures are used, things appear to work correctly.

 - Race condition that only happens for no YUI Test on the page?
 - Timer calling next()?
 - next in the /results response?
 - Dump EventSource data / run tcpdump, et. al.
 - Run Yeti server in client in different windows: where is results() called, etc.

Need to clear XHR Data / Submit... message on pollback.

Cleanup
-------

 - run.js needs a high-level XHR API to use internally.

Misc.
-----
 - Remove evaluator function from run.js; replaced with json2.js.
