/**
 * XadillaX created at 2015-03-04 11:24:50
 *
 * Copyright (c) 2015 Huaban.com, all rights
 * reserved
 */
require("sugar");

var EventEmitter = require("events").EventEmitter;
var util = require("util");
var async = require("async");

var helper = require("./helper");
var Request = require("./request");
var Response = require("./response");
var Zookeeper = require("./server_zookeeper");

var emptyFunc = function(){};

/**
 * illyria server
 * @param {Object} [options] the illyria server options
 * @param {Object} [zookeeperOptions] the zookeeper options
 * @constructor
 */
var IllyriaServer = function(options, zookeeperOptions) {
    EventEmitter.call(this);

    this.modules = {};
    this.middlewares = [];

    this.options = options || {};
    this.zookeeperOptions = zookeeperOptions || {};

    this.zookeeper = undefined;
    if(this.zookeeperOptions && Object.keys(this.zookeeperOptions).length) {
        this.zookeeper = new Zookeeper(
            this.zookeeperOptions.connectString,
            this.zookeeperOptions,
            this.zookeeperOptions.root,
            this.zookeeperOptions.prefix,
            this.zookeeperOptions.version
        );
    }

    this.server = helper.createServer(options, this._onClientConnected.bind(this));
};

util.inherits(IllyriaServer, EventEmitter);

/**
 * server listen
 * @param {Number} [port] the server port
 * @param {String} [host] the server host
 * @param {Function} callback the callback function
 */
IllyriaServer.prototype.listen = function(port, host, callback) {
    if(typeof port === "function" || undefined === port) {
        callback = (undefined === port) ? callback : port;
        port = this.options.port;
    } else {
        this.options.port = port;
    }

    if(typeof host === "function" || undefined === host) {
        callback = (undefined === host) ? callback : host;
        host = this.options.host;
    } else {
        this.options.host = host;
    }

    if(undefined === host && this.zookeeper) {
        throw new Error("You must specify your server host when you use zookeeper.");
    }

    if(undefined === port) {
        throw new Error("You must specify a port number.");
    }

    if(undefined === this.options.host) host = this.options.host = "0.0.0.0";

    var self = this;
    this.server.listen(port, host, function() {
        if(!self.zookeeper) return callback();

        /* istanbul ignore next */
        if([ "0.0.0.0", "127.0.0.1", "localhost" ].indexOf(host) >= 0 &&
            !process.env.ZK_NO_WARN) {
            console.warn("===============================================================");
            console.warn("| :: You're using Zookeeper client, but your host is " + host + ".");
            console.warn("| :: It may occur some problems.");
            console.warn("| :: [ ⬆️ WARNNING ⬆️ ]");
            console.warn("===============================================================");
        }

        self.zookeeper.setServerInformation(host, port);
        self.zookeeper.connect(function(err) {
            if(err) return self.server.close(), callback(err);
            callback();
        });
    });
};

/**
 * use a middleware
 * @param {Function} func the middleware function
 */
IllyriaServer.prototype.use = function(func) {
    this.middlewares.push(func);
};

/**
 * expose a router module to server
 * @param {Object|String} module the whole module defination or a module name
 * @param {Object} [methods] the methods object when `module` is a string
 * @param {Object} [options] the options
 */
IllyriaServer.prototype.expose = function(module, methods, options) {
    if((arguments.length === 1 || arguments.length === 2) &&
        typeof module === "object") {
        this.modules[module.name] = module.methods;
        options = methods || {};
        methods = module.methods;
        module = module.name;
    } else if((arguments.length === 2 || arguments.length === 3) &&
        typeof module === "string" && typeof methods === "object") {
        this.modules[module] = methods;
        options = options || {};
    } else {
        throw new Error("Bad arguments while exposing module and methods.");
    }

    // deal with options...
    var self = this;

    function _switch(name, type) {
        var _name;
        switch(type) {
            case "upperCamel": _name = name.camelize(true); break;
            case "lowerCamel": _name = name.camelize(false); break;
            case "underscore": _name = name.underscore(); break;
            default: _name = name; break;
        }

        return _name;
    }
    
    // method copies...
    if(options.alias) {
        if(typeof options.alias === "object" && !(options.alias instanceof Array)) {
            options.alias = [ options.alias ];
        }
    
        options.alias.forEach(function(alias) {
            var _module;
            var _methods = {};

            _module = _switch(module, alias.module);

            for(var key in methods) {
                if(!methods.hasOwnProperty(key)) continue;

                var _key = _switch(key, alias.method);
                _methods[_key] = methods[key];
            }

            self.expose(_module, _methods);
        });
    }
};

/**
 * close the server
 * @param {Function} callback the callback function
 */
IllyriaServer.prototype.close = function(callback) {
    if(this.zookeeper) this.zookeeper.disconnect();
    this.server.close(callback);
};

/**
 * event when a new client is connected
 * @param {ISocket} socket the socket object
 * @private
 */
IllyriaServer.prototype._onClientConnected = function(socket) {
    var moduleNames = Object.keys(this.modules);
    var self = this;

    // add client count
    if(this.zookeeper) {
        this.zookeeper.incClientCount();
        socket.on("close", function() {
            self.zookeeper.decClientCount();
        });
    }

    // add received event
    socket.addReceivedEvent = function(moduleName, methodName, listener) {
        var callFunc = function() {
            var params = [].slice.call(arguments);
            params = (params.length === 1) ? params[0] : {};
            var msgId = this.event[1];

            var req = new Request(socket, params);
            var resp = new Response(socket, msgId);
            
            if(self.middlewares.length > 0) {
                async.mapSeries(self.middlewares, function(task, callback) {
                    task(req, resp, callback);
                }, function(){
                    listener(req, resp);
                });
            } else {
                listener(req, resp);
            }
        };
        callFunc.listener = listener;

        var castFunc = function() {
            var params = [].slice.call(arguments);
            params = (params.length === 1) ? params[0] : {};
            var msgId = this.event[1];

            var req = new Request(socket, params);
            var resp = new Response(socket, msgId);

            // cast reply now!!!!!!!!!!!!
            resp.socket.replyCast([ msgId ]);

            // hack resp's send
            resp.json = resp.error = resp.send = emptyFunc;
            
            if(self.middlewares.length > 0) {
                async.mapSeries(self.middlewares, function(task, callback) {
                    task(req, resp, callback);
                }, function(){
                    listener(req, resp);
                });
            } else {
                listener(req, resp);
            }
        };
        castFunc.listener = listener;

        this.eventFuncs = this.eventFuncs || {};
        var key = moduleName + "♥" + methodName;
        this.eventFuncs[key + "❤️call"] = this.eventFuncs[key] || [];
        this.eventFuncs[key + "❤️cast"] = this.eventFuncs[key] || [];
        this.eventFuncs[key + "❤️call"].push(callFunc);
        this.eventFuncs[key + "❤️cast"].push(castFunc);
        
        console.log(moduleName, '---*******----', methodName);
        //moduleName = 'com.raycloud.dubbo.request.KmzsNodeTest';
        this.data([ "*", "call", moduleName, methodName ], callFunc);
        this.data([ "*", "cast", moduleName, methodName ], castFunc);
    };

    // remove received event
    socket.removeReceivedEvent = function(moduleName, methodName, listener) {
        var key = moduleName + "♥" + methodName + "❤️call";
        if(this.eventFuncs && this.eventFuncs[key]) {
            var funcs = this.eventFuncs[key];
            for(var i = 0; i < funcs.length; i++) {
                var func = funcs[i];
                if(func.listener === listener) {
                    this.undata([ "*", "call", moduleName, methodName ], func);
                    funcs.removeAt(i);
                    break;
                }
            }
        }

        key = moduleName + "♥" + methodName + "❤️cast";
        if(this.eventFuncs && this.eventFuncs[key]) {
            var funcs = this.eventFuncs[key];
            for(var i = 0; i < funcs.length; i++) {
                var func = funcs[i];
                if(func.listener === listener) {
                    this.undata([ "*", "cast", moduleName, methodName ], func);
                    funcs.removeAt(i);
                    break;
                }
            }
        }
    };

    // add all methods into sockets
    moduleNames.forEach(function(name) {
        var module = self.modules[name];
        var methods = Object.keys(module);

        methods.forEach(function(method) {
            socket.addReceivedEvent(name, method, module[method]);
        });
    });
};

/**
 * create a illyria server
 * @param {Object} [options] the illyria server options
 * @param {Object} [zookeeperOptions] the zookeeper options
 * @return {IllyriaServer}
 */
IllyriaServer.createServer = function(options, zookeeperOptions) {
    options = options || {};
    return new IllyriaServer(options, zookeeperOptions);
};

module.exports = IllyriaServer;
