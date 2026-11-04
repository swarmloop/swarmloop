// The only way out of a swarmloop sandbox. Every sandbox container has a fixed address on an internal network, and
// the server writes a policy for that address before the container starts: the hosts it may reach and, for model
// APIs that allow it, the real key. The container itself only gets a placeholder key.
//
// :3128  forward proxy. CONNECT host:443 (and plain http:// requests) only to the hosts of the policy.
// :3129  model API. Requests are sent to the policy's upstream with the real key in place of the placeholder.
import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { join } from 'node:path';

const POLICY_DIR = process.env.EGRESS_POLICY_DIR ?? '/policies';
const PROXY_PORT = Number(process.env.EGRESS_PROXY_PORT ?? 3128);
const API_PORT = Number(process.env.EGRESS_API_PORT ?? 3129);
const HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/** The policy of the container at this address, or null when there is none or it has expired. */
export function policyFor(address, dir = POLICY_DIR, now = Date.now()) {
  const ip = String(address ?? '').replace(/^::ffff:/, '');
  if (!/^[0-9.]+$/.test(ip) && !/^[0-9a-f:]+$/i.test(ip)) {
    return null;
  }
  try {
    const policy = JSON.parse(readFileSync(join(dir, `${ip}.json`), 'utf8'));
    if (typeof policy.expires === 'number' && policy.expires < now) {
      return null;
    }
    return policy;
  } catch {
    return null;
  }
}

/** An entry is a host name, or `*.domain` for the domain and every name below it. */
export function allowed(policy, host) {
  const name = String(host ?? '')
    .toLowerCase()
    .replace(/\.$/, '');
  return (policy?.hosts ?? []).some((entry) => {
    const rule = String(entry).toLowerCase();
    if (rule.startsWith('*.')) {
      const domain = rule.slice(2);
      return name === domain || name.endsWith(`.${domain}`);
    }
    return name === rule;
  });
}

function splitHostPort(target, fallbackPort) {
  const match = /^\[?([^\]]+?)\]?(?::(\d+))?$/.exec(target ?? '');
  return match ? { host: match[1], port: Number(match[2] ?? fallbackPort) } : null;
}

function log(event, fields) {
  process.stdout.write(`${JSON.stringify({ event, ...fields })}\n`);
}

function deny(socket, address, host, reason) {
  log('denied', { from: address, host, reason });
  socket.end(
    `HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\n\r\nswarmloop egress: ${host} is not allowed (${reason})\n`,
  );
}

function forwardHeaders(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!HOP_HEADERS.has(name.toLowerCase())) {
      out[name] = value;
    }
  }
  return out;
}

export function createProxyServer(options = {}) {
  const dir = options.policyDir ?? POLICY_DIR;
  const server = http.createServer((req, res) => {
    const address = req.socket.remoteAddress;
    let url;
    try {
      url = new URL(req.url ?? '');
    } catch {
      res.writeHead(400).end('swarmloop egress: absolute URL expected\n');
      return;
    }
    const policy = policyFor(address, dir);
    if (url.protocol !== 'http:' || !allowed(policy, url.hostname)) {
      log('denied', { from: address, host: url.hostname, reason: policy ? 'host' : 'no policy' });
      res.writeHead(403, { 'content-type': 'text/plain' }).end(`swarmloop egress: ${url.hostname} is not allowed\n`);
      return;
    }
    const upstream = http.request(
      {
        host: url.hostname,
        port: url.port || 80,
        path: `${url.pathname}${url.search}`,
        method: req.method,
        headers: forwardHeaders(req.headers),
      },
      (answer) => {
        res.writeHead(answer.statusCode ?? 502, forwardHeaders(answer.headers));
        answer.pipe(res);
      },
    );
    upstream.on('error', (error) => {
      if (res.headersSent) {
        res.destroy();
      } else {
        res.writeHead(502).end(`swarmloop egress: ${error.message}\n`);
      }
    });
    req.pipe(upstream);
  });
  server.on('connect', (req, socket, head) => {
    const address = socket.remoteAddress;
    const target = splitHostPort(req.url, 443);
    const policy = policyFor(address, dir);
    if (!target) {
      deny(socket, address, req.url, 'bad target');
      return;
    }
    if (!policy) {
      deny(socket, address, target.host, 'no policy');
      return;
    }
    const ports = options.ports ?? [443];
    if (!ports.includes(target.port) || !allowed(policy, target.host)) {
      deny(socket, address, `${target.host}:${target.port}`, 'host');
      return;
    }
    const outbound = net.connect(target.port, target.host, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) {
        outbound.write(head);
      }
      outbound.pipe(socket);
      socket.pipe(outbound);
    });
    const close = () => {
      outbound.destroy();
      socket.destroy();
    };
    outbound.on('error', (error) => {
      if (!socket.destroyed) {
        socket.end(`HTTP/1.1 502 Bad Gateway\r\n\r\nswarmloop egress: ${error.message}\n`);
      }
      close();
    });
    socket.on('error', close);
  });
  return server;
}

/** The policy's model API for this caller, or null. */
function apiFor(address, dir) {
  const policy = policyFor(address, dir);
  const api = policy?.api;
  if (!api?.upstream || !api.header || typeof api.value !== 'string') {
    log('denied', { from: address, host: 'model api', reason: policy ? 'no key' : 'no policy' });
    return null;
  }
  return api;
}

/** The upstream URL and the headers with the real key in place of whatever the CLI sent. */
function upstreamRequest(api, req, headers) {
  const base = new URL(api.upstream);
  const target = new URL(`${base.pathname.replace(/\/$/, '')}${req.url ?? '/'}`, base);
  delete headers.authorization;
  delete headers['x-api-key'];
  delete headers.host;
  headers[api.header] = api.value;
  return { target, headers, client: target.protocol === 'https:' ? https : http };
}

/** The model API with the real key. The placeholder the CLI sends never leaves this process. */
export function createApiServer(options = {}) {
  const dir = options.policyDir ?? POLICY_DIR;
  const server = http.createServer((req, res) => {
    const api = apiFor(req.socket.remoteAddress, dir);
    if (!api) {
      res.writeHead(403, { 'content-type': 'text/plain' }).end('swarmloop egress: no model key for this container\n');
      return;
    }
    const { target, headers, client } = upstreamRequest(api, req, forwardHeaders(req.headers));
    const upstream = client.request(target, { method: req.method, headers }, (answer) => {
      res.writeHead(answer.statusCode ?? 502, forwardHeaders(answer.headers));
      answer.pipe(res);
    });
    upstream.on('error', (error) => {
      if (res.headersSent) {
        res.destroy();
      } else {
        res.writeHead(502).end(`swarmloop egress: ${error.message}\n`);
      }
    });
    req.on('aborted', () => upstream.destroy());
    req.pipe(upstream);
  });
  // A WebSocket to the model API, such as the Responses stream of Codex: same key swap, then raw bytes both ways.
  server.on('upgrade', (req, socket, head) => {
    const api = apiFor(req.socket.remoteAddress, dir);
    if (!api) {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    const kept = { ...req.headers };
    for (const name of [
      'proxy-authorization',
      'proxy-connection',
      'keep-alive',
      'te',
      'trailer',
      'transfer-encoding',
    ]) {
      delete kept[name];
    }
    const { target, headers, client } = upstreamRequest(api, req, kept);
    const upstream = client.request(target, { method: req.method, headers });
    upstream.on('upgrade', (answer, upSocket, upHead) => {
      const lines = [`HTTP/1.1 ${answer.statusCode} ${answer.statusMessage}`];
      for (let at = 0; at < answer.rawHeaders.length; at += 2) {
        lines.push(`${answer.rawHeaders[at]}: ${answer.rawHeaders[at + 1]}`);
      }
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (upHead?.length) {
        socket.write(upHead);
      }
      if (head?.length) {
        upSocket.write(head);
      }
      upSocket.pipe(socket);
      socket.pipe(upSocket);
      const close = () => {
        upSocket.destroy();
        socket.destroy();
      };
      upSocket.on('error', close);
      socket.on('error', close);
    });
    upstream.on('response', (answer) => {
      socket.end(`HTTP/1.1 ${answer.statusCode} ${answer.statusMessage}\r\n\r\n`);
      answer.resume();
    });
    upstream.on('error', () => socket.destroy());
    upstream.end();
  });
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  createProxyServer().listen(PROXY_PORT, '0.0.0.0', () => log('listening', { port: PROXY_PORT }));
  createApiServer().listen(API_PORT, '0.0.0.0', () => log('listening', { port: API_PORT }));
}
