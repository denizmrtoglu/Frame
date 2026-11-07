#!/usr/bin/env node
/**
 * PoC — bundle Frame's unchanged renderer for a browser:
 * `electron` and the few Node built-ins it touches resolve to stand-ins.
 * Output: dist/renderer.web.js (served by server/index.js).
 */
const path = require('path');
const esbuild = require(path.join(__dirname, '../node_modules/esbuild'));

const web = path.join(__dirname, 'web');
const virtual = {
  'electron': `module.exports = require(${JSON.stringify(path.join(web, 'electron-renderer-shim.js'))});`,
  'os': `module.exports = require(${JSON.stringify(path.join(web, 'node-shims.js'))}).os;`,
  'path': `module.exports = require(${JSON.stringify(path.join(web, 'node-shims.js'))}).path;`,
  'electron-log/renderer': `module.exports = require(${JSON.stringify(path.join(web, 'node-shims.js'))}).log;`
};

const shimPlugin = {
  name: 'frame-web-shims',
  setup(build) {
    build.onResolve({ filter: /^(electron|os|path|electron-log\/renderer)$/ }, (args) => ({ path: args.path, namespace: 'frame-shim' }));
    build.onLoad({ filter: /.*/, namespace: 'frame-shim' }, (args) => ({ contents: virtual[args.path], loader: 'js', resolveDir: web }));
  }
};

esbuild.build({
  entryPoints: [path.join(__dirname, '../src/renderer/index.js')],
  bundle: true,
  outfile: path.join(__dirname, '../dist/renderer.web.js'),
  platform: 'browser',
  format: 'iife',
  plugins: [shimPlugin],
  logLevel: 'info'
}).catch(() => process.exit(1));
