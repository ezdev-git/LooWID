'use strict';
/*global unescape: true */
/**
 * Local proxy (load balancing for development)
 * node proxy [n] -> Run proxy over 443 try to find nodes, from BasePort + 1 to BasePort + n
 */
// This example demonstrates using sticky session
// support
var httpProxy   = require('http-proxy');
var fs = require('fs');
var http = require('http');
var https = require('https');
var logger = require('./log.js').getLog('proxy');

var sport = process.env.LOOWID_HTTPS_PORT || 443;
var port = process.env.LOOWID_HTTP_PORT || 80;
var basePort = Number(process.env.LOOWID_BASE_PORT || 8000);

var isRunningTests = function() {
	return (process.argv[2] && process.argv[2].indexOf('jasmine_node:')===0) || process.argv[3]==='test';
};

//
//Create the HTTPS proxy server in front of a HTTP server
//

var targets = [];

var parseCookies = function(request) {
    var list = {}, rc = request.headers.cookie;
    if (rc) { 
    	rc.split(';').forEach(function( cookie ) {
    		var parts = cookie.split('=');
    		list[parts.shift().trim()] = decodeURI(parts.join('='));
    	});
    }
    return list;
};

var findStickyServer = function(req) {
	var sid = unescape(parseCookies(req).stickyid);
	var id = targets.indexOf(sid);
	if (id<0) {
		sid = targets[Math.floor(Math.random()*targets.length)];
		req.headers.stickyid = sid; 
	}
	logger.debug(sid+req.url);
	return sid;
};

var addBackend = function(srv) {
	var i = targets.indexOf(srv);
	if (i<0) {
		logger.info('Add backend '+srv);
		targets.push(srv);
	}
};

var removeBackend = function(srv) {
	var i = targets.indexOf(srv);
	if (i>=0) {
		logger.info('Remove backend '+srv);
		targets.splice(i,1);
	}
};

var validateBackend = function(h,p) {
	var options = {
		host: h,
		path: '/img/icons/favicon.ico',
		port: p
	};
	var req = http.get(options,function(response){
		addBackend('http://'+h+':'+p);
	});
	req.on('error',function(err){
		removeBackend('http://'+h+':'+p);
	});
};

var backends = isNaN(process.argv[2])?Number(process.env.JASMINE_NODES || 2):(process.argv[2]-0);

var checkServers = function() {
	for (var j=1; j<=backends; j+=1) {
		validateBackend('localhost',basePort+j);
	}
	// Check new servers every 5 seconds !!
	setTimeout(checkServers,5000);
};

var proxy = null;
var httpServer = null;

try {
	
	var credentials = {};
	var certificateAvailable = true;
	
	try {
		var fs = require('fs');
		// Generado con http://www.cert-depot.com/
		var privateKey = fs.readFileSync(process.env.PRIVATE_KEY || 'private.pem','utf-8');
		var certificate = fs.readFileSync(process.env.PUBLIC_KEY || 'public.pem','utf-8');
		var credentials = {
			key : privateKey,
			cert : certificate
		};
	} catch (ex) {
		logger.warn(ex.message);
		certificateAvailable = false;
	}
	
	if (!isRunningTests() && certificateAvailable) {
	
		proxy = httpProxy.createProxyServer({
			target: 'http://localhost',
			ssl: credentials,
			ws:true,
			secure:true
		});
		
		httpServer = https.createServer(credentials, function(req, res){
			var tg = findStickyServer(req);
			proxy.web(req, res, {target:tg}, function(){
				removeBackend(tg);
			});
		}).listen(sport, '0.0.0.0');
	
		var server = http.createServer(function (req, res) {
		  // optional, for HSTS
		  // see https://en.wikipedia.org/wiki/HTTP_Strict_Transport_Security
		  res.setHeader('Strict-Transport-Security', 'max-age=8640000; includeSubDomains');
	
		  if (req.headers['x-forwarded-proto'] !== 'https') {
		    var url = 'https://' + req.headers.host + (sport!==443?':'+sport:'') + '/';
		    res.writeHead(301, {'location': url});
		    return res.end('Redirecting to <a href="' + url + '">' + url + '</a>.');
		  }
		});
	
		server.listen(port);
		logger.info('Listen for redirect on port ' + port);
		
	} else {
		// Test is always running under http
		proxy = httpProxy.createProxyServer({
			target: 'http://localhost',
			ws:true
		});
		
		httpServer = http.createServer(function(req, res){
			var tg = findStickyServer(req);
			proxy.web(req, res, {target:tg}, function(){
				removeBackend(tg);
			});
		}).listen(sport, '0.0.0.0');
			
	}

} catch (ex) {
	
	logger.warn(ex.message);
	
}
	
process.on('uncaughtException', function (err) {
	if (err.errno === 'ECONNRESET') {
		// Backend server fail !!
		checkServers();
	} else {
		logger.error(err);
	}
});

httpServer.on('upgrade', function (req, socket, head) {
	var tg = findStickyServer(req);
    proxy.ws(req, socket, head, {target:tg}, function(){
		removeBackend(tg);
	});
});

logger.info('Running load balancer in port '+sport);
// Look for backends !!
setTimeout(checkServers,5000);

exports.isReady = function() {
	return targets.length===backends;
};
