/**
* HydraExpress Module
* @description A module that binds Hydra and ExpressJS. This simplifies building API enabled microservices.
* @author Carlos Justiniano
*/
'use strict';

const debug = require('debug')('hydra-express');
const Q = require('q');
const hydra = require('hydra');
const Utils = hydra.getUtilsHelper();
const ServerResponse = hydra.getServerResponseHelper();
let serverResponse = new ServerResponse();

const bodyParser = require('body-parser');
const cors = require('cors');
const express = require('express');
const helmet = require('helmet');
const http = require('http');
const path = require('path');
// const responseTime = require('response-time');

let app = express();

let defaultLogger = () => {
  let dump = (level, obj) => {
    console.log(level.toUpperCase());
    console.dir(obj, {colors: true, depth: null});
  };
  return {
    fatal: (obj) => dump('FATAL', obj),
    error: (obj) => dump('ERROR', obj),
    debug: (obj) => dump('DEBUG', obj),
    info: (obj) => dump('INFO', obj)
  };
};

/**
* @name HydraExpress
* @summary HydraExpress class
*/
class HydraExpress {
  /**
  * @name constructor
  * @return {undefined}
  */
  constructor() {
    this.config = null;
    this.server = null;
    this.testMode = false;
    this.appLogger = defaultLogger();
    this.registeredPlugins = [];
    this.ready = Q.defer(); // Resolved when ready for work.
  }

  /**
   * @name use
   * @summary Adds plugins to Hydra
   * @param {...object} plugins - plugins to register
   * @return {object} - Promise which will resolve when all plugins are registered
   */
  use(...plugins) {
    let proms = [];
    _.each(plugins, (plugin) => proms.push(this._registerPlugin(plugin)));
    return Q.all(proms);
  }

  /**
   * @name _registerPlugin
   * @summary Registers a plugin with Hydra
   * @param {object} plugin - HydraPlugin to use
   * @return {object} Promise or value
   */
  _registerPlugin(plugin) {
    this.registeredPlugins.push(plugin);
    return plugin.setHydraExpress(this);
  }

  /**
  * @name validateConfig
  * @summary Validates a configuration object to ensure all required fields are present
  * @private
  * @param {object} config - config object
  * @return {array} array - of missing fields or empty array
  */
  validateConfig(config) {
    let missingFields = [];
    let requiredMembers = {
      'hydra': {
        'serviceName': '',
        'serviceDescription': ''
      },
      'registerRoutesCallback': ''
    };

    Object.keys(requiredMembers).forEach((key) => {
      let type = typeof requiredMembers[key];
      if (type === 'string') {
        if (config[key] === undefined) {
          missingFields.push(key);
        }
      } else if (type === 'object') {
        if (config[key] === undefined) {
          missingFields.push(key);
        } else {
          Object.keys(requiredMembers[key]).forEach((key2) => {
            if (config[key][key2] === undefined) {
              missingFields.push(`${key}.${key2}`);
            }
          });
        }
      }
    });

    return missingFields;
  }

  /**
  * @name _init
  * @summary Initialize HydraExpress using a configuration object.
  * @private
  * @throws Throws an Error() if config is found to be invalid
  * @param {object} config - configuration as described in the projects readme
  * @return {object} Promise - promise resolving to hydraexpress ready or failure
  */
  _init(config) {
    return new Promise((resolve, reject) => {
      if (!config.hydra) {
        reject(new Error('Config missing hydra block'));
        return;
      }

      if (!config.hydra.redis) {
        reject(new Error('Config missing redis block'));
        return;
      }

      config.hydra.serviceIP = config.hydra.serviceIP || '';
      config.hydra.servicePort = config.hydra.servicePort || 0;
      config.hydra.serviceType = config.hydra.serviceType || '';

      let missingFields = this.validateConfig(config);
      if (missingFields.length) {
        reject(new Error(`Config missing fields: ${missingFields.join(' ')}`));
      } else if (!config.registerRoutesCallback) {
        reject(new Error('Config missing registerRoutesCallback parameter'));
      } else {
        config.hydra.serviceVersion = config.version;
        this.config = config;
        this.config.environment = this.config.environment || 'development';
        this.registerRoutesCallback = config.registerRoutesCallback;
        this.registerMiddlewareCallback = config.registerMiddlewareCallback;
        /**
        * Start the log event Listener as soon as possible in order to
        * receive redis initialization errors.
        *
        * @param {string} entry - log entry
        */
        hydra.on('log', (entry) => {
          if (entry.msg) {
            if (entry.msg.indexOf('Unavailable hydra-router instances') > -1) {
              // surpress this message since use of hydra-router is optional
              return;
            }
            entry.message = entry.msg;
          }
          this.log(entry.type, entry.message);
        });

        return this.start(resolve, reject);
      }
    });
  }

  /**
  * @name _shutdown
  * @summary Shutdown hydra-express safely.
  * @return {object} Promise - promise resolving to hydraexpress ready or failure
  */
  _shutdown() {
    return new Promise((resolve, reject) => {
      // A 1-second delay allows for active requests to finish before we kill the server.
      // (A vanilla Hydra-express feature)
      setTimeout(() => {
        this.server.close(() => {
        this.log('error', 'Service is shutting down.');
        hydra.shutdown()
          .then((result) => {
            resolve(result);
          })
          .catch((err) => {
            reject(err);
          });
        });
      }, 1000);
    });
  }

  /**
  * @name getExpress
  * @summary Retrieve the ExpressJS object
  * @return {object} express - ExpressJS object
  */
  getExpress() {
    return express;
  }

  /**
  * @name getExpressApp
  * @summary Retrieve the ExpressJS app object
  * @return {object} app - express app object
  */
  getExpressApp() {
    return app;
  }

  /**
  * @name getHydra
  * @summary Retrieve the Hydra object
  * @private
  * @return {object} hydra - Hydra object
  */
  getHydra() {
    return hydra;
  }

  /**
  * @name getRuntimeConfig
  * @summary Retrieve loaded configuration object
  * @return {object} config - immutable object
  */
  getRuntimeConfig() {
    return Object.assign({}, this.config);
  }

  /**
   * @name log
   * @summary logs a message
   * @private
   * @param {string} type - type of message: 'info', 'start', 'error'
   * @param {string} message - message to log
  * @return {undefined}
   */
  log(type, message) {
    let msg = (typeof message === 'object') ? Utils.safeJSONStringify(message) : message;
    debug(`${type} ${msg}`);
    let suppressLogEmit = true;
    switch (type) {
      case 'fatal':
        this.appLogger.fatal({
          event: type,
          message: msg
        });
        hydra.sendToHealthLog('fatal', message, suppressLogEmit);
        break;
      case 'error':
        this.appLogger.error({
          event: type,
          message: msg
        });
        hydra.sendToHealthLog('fatal', message, suppressLogEmit);
        break;
      case 'debug':
        this.appLogger.debug({
          event: type,
          message: msg
        });
        break;
      default:
        this.appLogger.info({
          event: type,
          message: msg
        });
        break;
    }
  }

  /**
  * @name start
  * @summary Starts the HydraExpress server
  * @param {function} resolve - promise resolve
  * @param {function} _reject - promise reject
  * @private
  * @return {undefined}
  */
  start(resolve, reject) {
    let serviceInfo;
    return hydra.init(this.config, this.testMode)
    .then((config) => {
      this.config = config;
      let proms = [];
      this.registeredPlugins.forEach(plugin => {
        proms.push(plugin.setConfig(config));
      });
      return Q.all(proms);
    })
    .then(() => hydra.registerService())
    .then((_serviceInfo) => {
      serviceInfo = _serviceInfo;
      this.initService();
      let proms = [];
      this.registeredPlugins.forEach(plugin => {
        proms.push(plugin.onServiceReady());
      });
      return Q.all(proms);
    })
    .then(() => {
      resolve(serviceInfo);
      this.ready.resolve();
    })
    .catch((err) => {
      this.ready.reject(err);
      process.emit('cleanup');
      reject(err);
    });
  }

  /**
   * @name initService
   * @summary Initialize service
   * @private
   * @return {undefined}
   */
  initService() {
    // app.use(responseTime());

    /**
    * @description Stamp every request with the process id that handled it.
    * @param {object} req - express request object
    * @param {object} res - express response object
    * @param {function} next - express next handler
    */
    app.use((req, res, next) => {
      res.set('x-process-id', process.pid);
      next();
    });

    /**
    * @description Fatal error handler.
    * @param {function} err - error handler function
    */
    let cleanupDone = false;
    process.on('cleanup', () => {
      if (!cleanupDone) {
        cleanupDone = true;
        this._shutdown();
        // Safety handler to ensure we exit eventually.
        setTimeout(() => {
          process.exit();
        }, 30000); // 30s is default k8s grace period.
      }
    });

    /**
    * Security.
    */
    const ninetyDaysInMilliseconds = 7776000000;
    app.use(helmet());
    app.use(helmet.hidePoweredBy({setTo: `${hydra.getServiceName()}/${hydra.getInstanceVersion()}`}));
    app.use(helmet.hsts({maxAge: ninetyDaysInMilliseconds}));

    if (this.config.cors) {
      app.use(cors(Object.assign({}, this.config.cors)));
      app.options(cors(Object.assign({}, this.config.cors)));
    } else {
      app.use(cors());
      app.options(cors());
    }

    if (this.config.bodyParser) {
      let bodyParserConfig = Object.assign({json: {}, urlencoded: {extended: false}}, this.config.bodyParser);
      app.use(bodyParser.json(bodyParserConfig.json));
      app.use(bodyParser.urlencoded(bodyParserConfig.urlencoded));
    } else {
      app.use(bodyParser.json());
      app.use(bodyParser.urlencoded({extended: false}));
    }

    this.registerMiddlewareCallback && this.registerMiddlewareCallback();

    if (this.config.publicFolder) {
      this.config.appPath = path.join('./', this.config.publicFolder);
    } else {
      this.config.appPath = path.join('./', 'public');
    }

    app.use('/', express.static(this.config.appPath));

    app.set('port', this.config.servicePort);

    this.server = http.createServer(app);

    /**
     * @param {object} error - error object
     * @description on handler for errors.
     */
    this.server.on('error', (error) => {
      if (error.syscall !== 'listen') {
        throw error;
      }

      let bind = (typeof port === 'string') ? `Pipe ${this.config.hydra.servicePort}` : `Port ${this.config.hydra.servicePort}`;
      switch (error.code) {
        case 'EACCES':
          this.log('error', `${bind} requires elevated privileges`);
          process.exit(1);
          break;
        case 'EADDRINUSE':
          this.log('error', `${bind} is already in use`);
          process.exit(1);
          break;
        default:
          throw error;
      }
    });


    /**
     * @description listen handler for server.
     */
    this.server.listen(this.config.hydra.servicePort, () => {
      this.registerRoutesCallback && this.registerRoutesCallback();

      app.use('/*', (req, res) => {
        res.sendFile(path.resolve(this.config.appPath + '/index.html'));
      });

      /**
      * Post middleware init. Make sure to do this last.
      */

      /**
      * @param {object} req - express request object
      * @param {object} res - express response object
      * @param {function} next - express next handler
      */
      app.use((req, res, next) => {
        let err = new Error('Not Found');
        err.status = ServerResponse.HTTP_NOT_FOUND;
        next(err);
      });

      /**
      * @param {object} err - express err object
      * @param {object} req - express request object
      * @param {object} res - express response object
      * @param {function} _next - express next handler
      */
      app.use((err, req, res, _next) => {
        let errCode = err.status || ServerResponse.HTTP_SERVER_ERROR;
        if (err.status !== ServerResponse.HTTP_NOT_FOUND) {
          this.appLogger.fatal({
            event: 'error',
            error: err.name,
            stack: err.stack
          });
        }
        res.status(errCode).json({
          code: errCode
        });
      });
    });
  }

  /**
  * @name _registerRoutes
  * @summary Register API routes.
  * @private
  * @param {object} routes - object with key/value pairs of routeBase: express api object
  * @return {undefined}
  */
  _registerRoutes(routes) {
    let routesList = [];
    Object.keys(routes).forEach((routePath) => {
      routes[routePath].stack.forEach((route) => {
        let routeInfo = route.route;
        // Skip router-level middleware, which will show up in the routes stack,
        // but with an undefined route property
        if (routeInfo) {
          Object.keys(routeInfo.methods).forEach((method) => {
            routesList.push(`[${method}]${routePath}${routeInfo.path}`);
          });
        }
      });
      app.use(routePath, routes[routePath]);
    });
    hydra.registerRoutes(routesList);
  }

  /**
   * @name sendResponse
   * @summary Send a server response to caller.
   * @param {number} httpCode - HTTP response code
   * @param {object} res - Node HTTP response object
   * @param {object} data - An object to send
   * @return {undefined}
   */
  _sendResponse(httpCode, res, data) {
    serverResponse.sendResponse(httpCode, res, data);
  }
}

/* ************************************************************************************************ */
/* ************************************************************************************************ */
/* ************************************************************************************************ */
/* ************************************************************************************************ */
/* ************************************************************************************************ */
/* ************************************************************************************************ */
/* ************************************************************************************************ */
/* ************************************************************************************************ */
/* ************************************************************************************************ */

/**
* @name IHydraExpress
* @summary Interface to a HydraExpress class
*/
class IHydraExpress extends HydraExpress {
  /**
  * @name constructor
  * @return {undefined}
  */
  constructor() {
    super();
  }

  /**
  * @name init
  * @summary Initializes the HydraExpress module
  * @param {object} config - application configuration object
  * @param {string} version - version of application
  * @param {function} registerRoutesCallback - callback function to register routes
  * @param {function} registerMiddlewareCallback - callback function to register middleware
  * @return {object} Promise - promise resolving to hydraexpress ready or failure
  */
  init(config, version, registerRoutesCallback, registerMiddlewareCallback) {
    if (typeof config === 'string') {
      const configHelper = hydra.getConfigHelper();
      return configHelper.init(config)
        .then(() => {
          return this.init(configHelper.getObject(), version, registerRoutesCallback, registerMiddlewareCallback);
        })
        .catch((_err) => {
          throw new Error(`Unable to load config from ${config}`);
        });
    }

    let inner = {};
    if (typeof version === 'function') {
      registerMiddlewareCallback = registerRoutesCallback;
      registerRoutesCallback = version;
      // inner.version = config.version || require(`${__dirname}/package.json`).version;
    } else if (version) {
      inner.version = version;
    }

    if (registerRoutesCallback) {
      inner.registerRoutesCallback = registerRoutesCallback;
    }
    if (registerMiddlewareCallback) {
      inner.registerMiddlewareCallback = registerMiddlewareCallback;
    }
    if (config.testMode === true) {
      this.testMode = true;
    }
    return super._init(Object.assign({}, config, inner));
  }

  /**
  * @name shutdown
  * @summary Shutdown hydra-express safely.
  * @return {object} Promise - promise resolving to hydraexpress ready or failure
  */
  shutdown() {
    return super._shutdown();
  }

  /**
  * @name getExpress
  * @summary Retrieve the underlying ExpressJS object
  * @return {object} express - expressjs object
  */
  getExpress() {
    return super.getExpress();
  }

  /**
  * @name getHydra
  * @summary Retrieve the underlying Hydra object
  * @return {object} hydra - hydra object
  */
  getHydra() {
    return super.getHydra();
  }

  /**
  * @name getRuntimeConfig
  * @summary Retrieve loaded configuration object
  * @return {object} config - immutable object
  */
  getRuntimeConfig() {
    return super.getRuntimeConfig();
  }

  /**
  * @name log
  * @summary Logger. Use to log messages
  * @param {string} type - type of message: 'fatal', 'error', 'debug', 'info'
  * @param {string} str - string message to log
  * @return {undefined}
  */
  log(type, str) {
    super.log(type, str);
  }

  /**
  * @name registerRoutes
  * @summary Register API routes.
  * @param {string} routeBaseUrl - route base url, ex: /v1/offers
  * @param {object} api - express api object
  * @return {undefined}
  */
  registerRoutes(routeBaseUrl, api) {
    super._registerRoutes(routeBaseUrl, api);
  }

  /**
   * @name sendResponse
   * @summary Send a server response to caller.
   * @param {number} httpCode - HTTP response code
   * @param {object} res - Node HTTP response object
   * @param {object} data - An object to send
   * @return {undefined}
   */
  sendResponse(httpCode, res, data) {
    super._sendResponse(httpCode, res, data);
  }
}

module.exports = new IHydraExpress;
