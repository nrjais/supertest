/**
 * Module dependencies.
 */

var request = require('superagent');
var util = require('util');
var http = require('http');
var https = require('https');
var assert = require('chai').assert;
var Request = request.Request;

/**
 * Expose `Test`.
 */

module.exports = Test;

/**
 * Initialize a new `Test` with the given `app`,
 * request `method` and `path`.
 *
 * @param {Server} app
 * @param {String} method
 * @param {String} path
 * @api public
 */

function Test(app, method, path) {
  Request.call(this, method.toUpperCase(), path);
  this.redirects(0);
  this.buffer();
  this.app = app;
  this._asserts = [];
  this.assertFunction = [];
  this.url = typeof app === 'string'
    ? app + path
    : this.serverAddress(app, path);
  this.bodyAsserts = this.assertBody();
  this.headersAsserts = this.assertHeaders();
  this.cookieAsserts = this.assertCookie();
}

/**
 * Inherits from `Request.prototype`.
 */

Test.prototype.__proto__ = Request.prototype;

/**
 * Returns a URL, extracted from a server.
 *
 * @param {Server} app
 * @param {String} path
 * @returns {String} URL address
 * @api private
 */

Test.prototype.serverAddress = function (app, path) {
  var addr = app.address();
  var port;
  var protocol;

  if (!addr) this._server = app.listen(0);
  port = app.address().port;
  protocol = app instanceof https.Server ? 'https' : 'http';
  return protocol + '://127.0.0.1:' + port + path;
};

/**
 * Expectations:
 *
 *   .expect(200)
 *   .expect(200, fn)
 *   .expect(200, body)
 *   .expect('Some body')
 *   .expect('Some body', fn)
 *   .expect('Content-Type', 'application/json')
 *   .expect('Content-Type', 'application/json', fn)
 *   .expect(fn)
 *
 * @return {Test}
 * @api public
 */

Test.prototype.expect = function (a, b, c) {
  // callback
  if (typeof a === 'function') {
    this._asserts.push(a);
    return this;
  }
  if (typeof b === 'function') this.end(b);
  if (typeof c === 'function') this.end(c);

  // status
  if (typeof a === 'number') {
    this._asserts.push(this._assertStatus.bind(this, a));
    // body
    if (typeof b !== 'function' && arguments.length > 1) {
      this._asserts.push(this._assertBody.bind(this, b));
    }
    return this;
  }

  // header field
  if (typeof b === 'string' || typeof b === 'number' || b instanceof RegExp) {
    this._asserts.push(this._assertHeader.bind(this, { name: '' + a, value: b }));
    return this;
  }

  // body
  this._asserts.push(this._assertBody.bind(this, a));

  return this;
};

/**
 * Defer invoking superagent's `.end()` until
 * the server is listening.
 *
 * @param {Function} fn
 * @api public
 */

Test.prototype.end = function (fn) {
  var self = this;
  var server = this._server;
  var end = Request.prototype.end;
  end.call(this, function (err, res) {
    if (server && server._handle) return server.close(assert);

    function assert() {
      self.assertFunction.forEach(fn => fn(res));
      self.assert(err, res, fn);
    }
    assert();
  });

  return this;
};

/**
 * Perform assertions and invoke `fn(err, res)`.
 *
 * @param {?Error} resError
 * @param {Response} res
 * @param {Function} fn
 * @api private
 */

Test.prototype.assert = function (resError, res, fn) {
  var error;
  var i;

  // check for unexpected network errors or server not running/reachable errors
  // when there is no response and superagent sends back a System Error
  // do not check further for other asserts, if any, in such case
  // https://nodejs.org/api/errors.html#errors_common_system_errors
  var sysErrors = {
    ECONNREFUSED: 'Connection refused',
    ECONNRESET: 'Connection reset by peer',
    EPIPE: 'Broken pipe',
    ETIMEDOUT: 'Operation timed out'
  };

  if (!res && resError && (resError instanceof Error) && (resError.syscall === 'connect')
    && (Object.getOwnPropertyNames(sysErrors).indexOf(resError.code) >= 0)) {
    error = new Error(resError.code + ': ' + sysErrors[resError.code]);
    fn.call(this, error, null);
    return;
  }

  // asserts
  for (i = 0; i < this._asserts.length && !error; i += 1) {
    error = this._assertFunction(this._asserts[i], res);
  }

  // set unexpected superagent error if no other error has occurred.
  if (!error && resError instanceof Error && (!res || resError.status !== res.status)) {
    error = resError;
  }

  fn.call(this, error || null, res);
};

/**
 * Perform assertions on a response body and return an Error upon failure.
 *
 * @param {Mixed} body
 * @param {Response} res
 * @return {?Error}
 * @api private
 */

Test.prototype._assertBody = function (body, res) {
  var isregexp = body instanceof RegExp;
  var a;
  var b;

  // parsed
  if (typeof body === 'object' && !isregexp) {
    try {
      assert.deepEqual(body, res.body);
    } catch (err) {
      a = util.inspect(body);
      b = util.inspect(res.body);
      return error('expected ' + a + ' response body, got ' + b, body, res.body);
    }
  } else if (body !== res.text) {
    // string
    a = util.inspect(body);
    b = util.inspect(res.text);

    // regexp
    if (isregexp) {
      if (!body.test(res.text)) {
        return error('expected body ' + b + ' to match ' + body, body, res.body);
      }
    } else {
      return error('expected ' + a + ' response body, got ' + b, body, res.body);
    }
  }
};

/**
 * Perform assertions on a response header and return an Error upon failure.
 *
 * @param {Object} header
 * @param {Response} res
 * @return {?Error}
 * @api private
 */

Test.prototype._assertHeader = function (header, res) {
  var field = header.name;
  var actual = res.header[field.toLowerCase()];
  var fieldExpected = header.value;

  if (typeof actual === 'undefined') return new Error('expected "' + field + '" header field');
  // This check handles header values that may be a String or single element Array
  if ((actual instanceof Array && actual.toString() === fieldExpected) ||
    fieldExpected === actual) {
    return;
  }
  if (fieldExpected instanceof RegExp) {
    if (!fieldExpected.test(actual)) {
      return new Error('expected "' + field + '" matching ' +
        fieldExpected + ', got "' + actual + '"');
    }
  } else {
    return new Error('expected "' + field + '" of "' + fieldExpected + '", got "' + actual + '"');
  }
};

/**
 * Perform assertions on the response status and return an Error upon failure.
 *
 * @param {Number} status
 * @param {Response} res
 * @return {?Error}
 * @api private
 */

Test.prototype._assertStatus = function (status, res) {
  var a;
  var b;
  if (res.status !== status) {
    a = http.STATUS_CODES[status];
    b = http.STATUS_CODES[res.status];
    return new Error('expected ' + status + ' "' + a + '", got ' + res.status + ' "' + b + '"');
  }
};

/**
 * Performs an assertion by calling a function and return an Error upon failure.
 *
 * @param {Function} fn
 * @param {Response} res
 * @return {?Error}
 * @api private
 */
Test.prototype._assertFunction = function (check, res) {
  var err;
  try {
    err = check(res);
  } catch (e) {
    err = e;
  }
  if (err instanceof Error) return err;
};

/**
 * Return an `Error` with `msg` and results properties.
 *
 * @param {String} msg
 * @param {Mixed} expected
 * @param {Mixed} actual
 * @return {Error}
 * @api private
 */

function error(msg, expected, actual) {
  var err = new Error(msg);
  err.expected = expected;
  err.actual = actual;
  err.showDiff = true;
  return err;
}

Test.prototype.assertBody = function () {
  let a = {};
  let functions = Object.keys(assert);
  let self = this;
  functions.forEach(fun => {
    let ass = assert[fun];
    a[fun] = function (...args) {
      let fn = function (res) {
        ass(res.text, ...args);
      }
      self.assertFunction.push(fn);
      return self;
    }
  });
  return a;
}

const getAllKeysInLowerCase = function(object){
  let keys = Object.keys(object);
  return keys.reduce((obj,key)=>{
    let value = object[key];
    obj[key.toLowerCase()] = value;
    return obj;
  },{});
}

const cookieParser = function(cookies){
  return cookies.reduce((c,cookie)=>{
    let cookieKV = cookie.split(/=/);
    let cookiePair = [cookieKV.shift(), cookieKV.join('=')];
    c[cookiePair[0]] = cookiePair[1];
    return c;
  },{});
}

Test.prototype.assertHeaders = function () {
  let a = {};
  let functions = Object.keys(assert);
  let self = this;
  functions.forEach(fun => {
    let ass = assert[fun];
    a[fun] = function (key, ...args) {
      let fn = function (res) {
        let headers = getAllKeysInLowerCase(res.headers);
        let header = headers[key.toLowerCase()];
        ass(header, ...args);
      }
      self.assertFunction.push(fn);
      return self;
    }
  });
  return a;
}

Test.prototype.assertCookie = function () {
  let a = {};
  let functions = Object.keys(assert);
  let self = this;
  functions.forEach(fun => {
    let ass = assert[fun];
    a[fun] = function (...args) {
      let fn = function (res) {
        let headers = getAllKeysInLowerCase(res.headers);
        let cookies = cookieParser(headers['set-cookie']);
        let key = args.shift();
        assert.isDefined(cookies);
        ass(cookies[key], ...args);
      }
      self.assertFunction.push(fn);
      return self;
    }
  });

  return a;
}

Test.prototype.redirectsTo = function(location, sc){
  this.expect(sc || 302);
  this.headers.equal('Location', location);
  return this;
}

Test.prototype.contentType = function(type){
  this.headers.equal('content-type', type);
  return this;
}

Test.prototype.__defineGetter__('body', function () {
  return this.bodyAsserts;
});

Test.prototype.__defineGetter__('headers', function () {
  return this.headersAsserts;
});

Test.prototype.__defineGetter__('cookie', function () {
  return this.cookieAsserts;
});