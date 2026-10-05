'use strict';

// Static-serving allowlist for server.js. Starts a real instance on an ephemeral
// loopback port; no credentials or outbound network needed.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { createServer, resolveStaticPath } = require('../../server');

const ROOT = path.resolve(__dirname, '..', '..');

let server;
let port;

test.before(async () => {
  server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

test.after(() => new Promise((resolve) => server.close(resolve)));

/** Raw GET: the path is sent exactly as given, so traversal attempts reach the server. */
function get(rawPath, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: rawPath, method }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('the dashboard and its assets are served', async () => {
  for (const p of ['/', '/index.html', '/app.js', '/style.css', '/manifest.json',
    '/favicon.svg', '/icons/icon-192.png', '/weather-icons/clear-day.svg', '/diag.html',
    '/app.js?v=40']) {
    const r = await get(p);
    assert.strictEqual(r.status, 200, `${p} should be 200`);
  }
  const index = await get('/');
  assert.match(index.body, /<title>Kitchen Dashboard<\/title>/);
  assert.match(index.headers['content-type'], /^text\/html/);
  assert.strictEqual(index.headers['x-content-type-options'], 'nosniff');
});

test('HEAD works and sends no body', async () => {
  const r = await get('/index.html', 'HEAD');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body, '');
});

test('repo internals, dotfiles and secrets are 404', async () => {
  for (const p of [
    '/.git/HEAD', '/.git/config', '/.env', '/.env.example', '/.gitignore',
    '/README.md', '/server.js', '/bootstrap.sh', '/package.json',
    '/api/package.json', '/api/src/lib/graph.js', '/api/test/server.test.js',
    '/deploy/kitchen-dash.service', '/icons/', '/icons/.hidden.png',
    '/icons/icon-192.svg', '/weather-icons/clear-day.png', '/nope.html',
  ]) {
    const r = await get(p);
    assert.strictEqual(r.status, 404, `${p} should be 404, got ${r.status}`);
  }
});

test('path traversal is 404, raw or encoded', async () => {
  for (const p of [
    '/../README.md', '/../../etc/passwd', '/icons/../README.md', '/icons/../.env',
    '/%2e%2e/README.md', '/%2e%2e%2fREADME.md', '/icons/..%2f..%2fREADME.md',
    '/icons/..%2fserver.js', '/%2e%2e%5cREADME.md', '/..%5c.env', '/index.html%00.png',
    '/%E0%A4%A',
  ]) {
    const r = await get(p);
    assert.strictEqual(r.status, 404, `${p} should be 404, got ${r.status}`);
  }
});

test('healthz and API routes still route', async () => {
  const h = await get('/healthz');
  assert.strictEqual(h.status, 200);
  assert.strictEqual(h.body, 'ok');
  // No coordinates -> validated 400 before any outbound call.
  const a = await get('/api/air');
  assert.strictEqual(a.status, 400);
  assert.deepStrictEqual(JSON.parse(a.body), { error: 'invalid_coordinates' });
});

test('non-GET methods are refused', async () => {
  assert.strictEqual((await get('/index.html', 'POST')).status, 405);
});

test('resolveStaticPath rejects what it must, and stays inside root', () => {
  assert.strictEqual(resolveStaticPath('/'), path.join(ROOT, 'index.html'));
  for (const p of ['/.env', '/a/../.env', '/..', '/icons/..\\README.md', '/README.md', '//etc/passwd']) {
    assert.strictEqual(resolveStaticPath(p), null, p);
  }
});

// Guards the allowlist against drift: everything index.html and manifest.json load
// must actually be servable, or the dashboard silently loses an asset.
test('every local asset referenced by index.html and manifest.json is allowlisted', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1])
    .filter((u) => !/^(?:[a-z]+:|#|\/\/)/i.test(u));
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  refs.push(...manifest.icons.map((i) => i.src));
  const icons = fs.readdirSync(path.join(ROOT, 'weather-icons')).map((f) => `weather-icons/${f}`);
  assert.ok(refs.length >= 10, `expected to find asset references, got ${refs.length}`);
  for (const ref of [...refs, ...icons]) {
    const clean = '/' + ref.split('?')[0].replace(/^\.\//, '');
    const full = resolveStaticPath(clean);
    assert.ok(full, `${ref} is referenced but not allowlisted`);
    assert.ok(fs.existsSync(full), `${ref} is allowlisted but missing`);
  }
});
