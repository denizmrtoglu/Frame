/**
 * PoC — the few Node built-ins the renderer touches, for the browser bundle.
 * Exposed as separate entry points via esbuild aliases (see build-web.js).
 */
exports.os = { release: () => 'remote', platform: () => (window.process && window.process.platform) || 'linux', EOL: '\n' };

exports.path = {
  sep: '/',
  join: (...parts) => exports.path.normalize(parts.filter(Boolean).join('/')),
  normalize: (p) => {
    const abs = p.startsWith('/');
    const out = [];
    for (const seg of p.split('/')) {
      if (!seg || seg === '.') continue;
      if (seg === '..') out.pop(); else out.push(seg);
    }
    return (abs ? '/' : '') + out.join('/');
  },
  basename: (p, ext) => { const b = p.replace(/\/+$/, '').split('/').pop() || ''; return ext && b.endsWith(ext) ? b.slice(0, -ext.length) : b; },
  dirname: (p) => { const i = p.replace(/\/+$/, '').lastIndexOf('/'); return i <= 0 ? (p.startsWith('/') ? '/' : '.') : p.slice(0, i); },
  extname: (p) => { const b = exports.path.basename(p); const i = b.lastIndexOf('.'); return i > 0 ? b.slice(i) : ''; },
  isAbsolute: (p) => p.startsWith('/'),
  resolve: (...parts) => exports.path.normalize(parts.reduce((acc, p) => (p.startsWith('/') ? p : `${acc}/${p}`), '/'))
};

exports.log = { warn: (...a) => console.warn(...a), info: (...a) => console.info(...a), error: (...a) => console.error(...a) };
