/**
 * PoC — stand-in for `electron-log/main`: the subset logger.js uses, writing
 * to stdout (and through the same hooks, so redaction still applies).
 */

const os = require('os');
const path = require('path');

const hooks = [];
const levels = ['error', 'warn', 'info', 'verbose', 'debug', 'silly'];

function emit(level, scope, data) {
  let message = { level, scope, data };
  for (const hook of hooks) message = hook(message) || message;
  const tag = scope ? `[${scope}]` : '';
  (console[level] || console.log)(`${level.toUpperCase()} ${tag}`, ...message.data);
}

function makeLogger(scope) {
  const l = {};
  for (const lv of levels) l[lv] = (...data) => emit(lv, scope, data);
  l.log = l.info;
  return l;
}

const root = makeLogger(null);
module.exports = Object.assign(root, {
  initialize() {},
  hooks,
  scope: (name) => makeLogger(name),
  transports: {
    file: { level: 'info', maxSize: 0, archiveLogFn: null, getFile: () => ({ path: path.join(os.homedir(), '.frame-server', 'logs', 'main.log') }) },
    console: { level: 'info' }
  }
});
