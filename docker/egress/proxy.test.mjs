import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { allowed, createApiServer, createProxyServer, policyFor } from './proxy.mjs';

function policies(policy) {
  const dir = mkdtempSync(join(tmpdir(), 'egress-policies-'));
  if (policy) {
    writeFileSync(join(dir, '127.0.0.1.json'), JSON.stringify(policy));
  }
  return dir;
}

function listen(server) {
  return new Promise((done) => server.listen(0, '127.0.0.1', () => done(server.address().port)));
}

function echoServer() {
  return net.createServer((socket) => socket.pipe(socket));
}

/** Opens a CONNECT tunnel and sends one line through it. Resolves with the status line and what came back. */
function tunnel(proxyPort, target) {
  return new Promise((done, fail) => {
    const socket = net.connect(proxyPort, '127.0.0.1', () =>
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`),
    );
    let data = '';
    socket.on('data', (chunk) => {
      data += chunk.toString();
      if (data.includes('\r\n\r\n') && data.startsWith('HTTP/1.1 200') && !data.includes('ping')) {
        socket.write('ping\n');
      }
      if (data.includes('ping') || data.startsWith('HTTP/1.1 403')) {
        socket.end();
      }
    });
    socket.on('close', () => done({ status: data.split('\r\n')[0], data }));
    socket.on('error', fail);
  });
}

test('a host is matched exactly or by a wildcard for its domain', () => {
  const policy = { hosts: ['api.anthropic.com', '*.cursor.sh'] };
  assert.equal(allowed(policy, 'api.anthropic.com'), true);
  assert.equal(allowed(policy, 'API.Anthropic.com.'), true);
  assert.equal(allowed(policy, 'evil-api.anthropic.com'), false);
  assert.equal(allowed(policy, 'api2.cursor.sh'), true);
  assert.equal(allowed(policy, 'cursor.sh'), true);
  assert.equal(allowed(policy, 'cursor.sh.evil.com'), false);
  assert.equal(allowed(null, 'api.anthropic.com'), false);
});

test('a policy is read for the caller address and ignored once it has expired', () => {
  const dir = policies({ hosts: ['a'], expires: 2000 });
  assert.deepEqual(policyFor('::ffff:127.0.0.1', dir, 1000)?.hosts, ['a']);
  assert.equal(policyFor('127.0.0.1', dir, 3000), null);
  assert.equal(policyFor('10.0.0.9', dir, 1000), null);
  assert.equal(policyFor('../../etc/passwd', dir, 1000), null);
});

test('CONNECT reaches an allowed host and is refused for any other', async () => {
  const echo = echoServer();
  const echoPort = await listen(echo);
  const proxy = createProxyServer({ policyDir: policies({ hosts: ['localhost'] }), ports: [echoPort] });
  const proxyPort = await listen(proxy);
  try {
    const ok = await tunnel(proxyPort, `localhost:${echoPort}`);
    assert.match(ok.status, /^HTTP\/1.1 200/);
    assert.match(ok.data, /ping/);
    const host = await tunnel(proxyPort, `example.com:${echoPort}`);
    assert.match(host.status, /^HTTP\/1.1 403/);
    const port = await tunnel(proxyPort, 'localhost:22');
    assert.match(port.status, /^HTTP\/1.1 403/);
  } finally {
    proxy.close();
    echo.close();
  }
});

test('a container without a policy gets nowhere', async () => {
  const proxy = createProxyServer({ policyDir: policies(null) });
  const proxyPort = await listen(proxy);
  try {
    assert.match((await tunnel(proxyPort, 'api.anthropic.com:443')).status, /^HTTP\/1.1 403/);
  } finally {
    proxy.close();
  }
});

test('the model API gets the real key, never the placeholder, and the answer streams back', async () => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    seen.push({ url: req.url, key: req.headers['x-api-key'], auth: req.headers.authorization, host: req.headers.host });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: one\n\n');
    setTimeout(() => res.end('data: two\n\n'), 20);
  });
  const upstreamPort = await listen(upstream);
  const api = createApiServer({
    policyDir: policies({
      hosts: [],
      api: { upstream: `http://127.0.0.1:${upstreamPort}`, header: 'x-api-key', value: 'sk-real' },
    }),
  });
  const apiPort = await listen(api);
  try {
    const body = await new Promise((done, fail) => {
      const req = http.request(
        {
          port: apiPort,
          host: '127.0.0.1',
          path: '/v1/messages',
          method: 'POST',
          headers: { 'x-api-key': 'sk-placeholder', authorization: 'Bearer nope' },
        },
        (res) => {
          let text = '';
          res.on('data', (chunk) => (text += chunk));
          res.on('end', () => done({ status: res.statusCode, text }));
        },
      );
      req.on('error', fail);
      req.end('{}');
    });
    assert.equal(body.status, 200);
    assert.equal(body.text, 'data: one\n\ndata: two\n\n');
    assert.deepEqual(seen, [
      { url: '/v1/messages', key: 'sk-real', auth: undefined, host: `127.0.0.1:${upstreamPort}` },
    ]);
  } finally {
    api.close();
    upstream.close();
  }
});

test('the model API refuses a container that has no key in its policy', async () => {
  const api = createApiServer({ policyDir: policies({ hosts: ['registry.npmjs.org'] }) });
  const apiPort = await listen(api);
  try {
    const status = await new Promise((done) =>
      http.get({ port: apiPort, host: '127.0.0.1', path: '/v1/messages' }, (res) => done(res.statusCode)),
    );
    assert.equal(status, 403);
  } finally {
    api.close();
  }
});

test('a plain http request goes through only to an allowed host', async () => {
  const site = http.createServer((_req, res) => res.end('hello'));
  const sitePort = await listen(site);
  const proxy = createProxyServer({ policyDir: policies({ hosts: ['localhost'] }) });
  const proxyPort = await listen(proxy);
  const get = (url) =>
    new Promise((done) =>
      http.get({ host: '127.0.0.1', port: proxyPort, path: url }, (res) => {
        let text = '';
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () => done({ status: res.statusCode, text }));
      }),
    );
  try {
    assert.deepEqual(await get(`http://localhost:${sitePort}/`), { status: 200, text: 'hello' });
    assert.equal((await get(`http://example.com:${sitePort}/`)).status, 403);
  } finally {
    proxy.close();
    site.close();
  }
});

test('a WebSocket upgrade to the model API carries the real key and then raw bytes', async () => {
  const seen = [];
  const upstream = http.createServer();
  upstream.on('upgrade', (req, socket) => {
    seen.push(req.headers.authorization);
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    socket.pipe(socket);
  });
  const upstreamPort = await listen(upstream);
  const api = createApiServer({
    policyDir: policies({
      hosts: [],
      api: { upstream: `http://127.0.0.1:${upstreamPort}`, header: 'authorization', value: 'Bearer sk-real' },
    }),
  });
  const apiPort = await listen(api);
  try {
    const echoed = await new Promise((done, fail) => {
      const req = http.request({
        port: apiPort,
        host: '127.0.0.1',
        path: '/v1/responses',
        headers: { connection: 'Upgrade', upgrade: 'websocket', authorization: 'Bearer sk-placeholder' },
      });
      req.on('upgrade', (res, socket) => {
        assert.equal(res.statusCode, 101);
        socket.write('frame');
        socket.once('data', (chunk) => {
          socket.destroy();
          done(chunk.toString());
        });
      });
      req.on('error', fail);
      req.end();
    });
    assert.equal(echoed, 'frame');
    assert.deepEqual(seen, ['Bearer sk-real']);
  } finally {
    api.close();
    upstream.close();
  }
});
