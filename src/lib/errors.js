'use strict';
class AppError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; this.expose = true; }
}
function fail(msg, status = 400) { throw new AppError(msg, status); }
function assert(cond, msg, status = 400) { if (!cond) fail(msg, status); }
module.exports = { AppError, fail, assert };
