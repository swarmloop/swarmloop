import 'reflect-metadata';
import { Body, Controller, Get, Post } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { request } from 'http';
import type { AddressInfo } from 'net';
import { isAllowedHost } from './allowed-hosts';
import { secureHttp } from './request-guard';

const created: unknown[] = [];

@Controller()
class RunsStub {
  @Post('runs')
  create(@Body() body: unknown): { ok: true } {
    created.push(body);
    return { ok: true };
  }

  @Get('health')
  health(): { status: string } {
    return { status: 'ok' };
  }
}

function send(
  port: number,
  options: { method: string; path: string; host?: string; type?: string; body?: string },
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: options.host ?? `127.0.0.1:${port}` };
    if (options.type) headers['content-type'] = options.type;
    const req = request({ port, host: '127.0.0.1', method: options.method, path: options.path, headers }, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end(options.body);
  });
}

describe('isAllowedHost', () => {
  const publicUrl = 'http://panel.example:8080';

  it.each([
    '127.0.0.1',
    '127.0.0.1:3920',
    'localhost',
    'LOCALHOST:3921',
    '[::1]:3920',
    'panel.example',
    'panel.example:8080',
    'server:3920',
    'dashboard:3921',
  ])('answers %s', (host) => {
    expect(isAllowedHost(host, publicUrl)).toBe(true);
  });

  it.each([undefined, '', 'evil.example', 'evil.example:3920', '127.0.0.1.evil.example', 'localhost.evil.example:80'])(
    'refuses %s',
    (host) => {
      expect(isAllowedHost(host, publicUrl)).toBe(false);
    },
  );
});

describe('http guard', () => {
  let app: NestExpressApplication;
  let port: number;

  beforeAll(async () => {
    const module = await Test.createTestingModule({ controllers: [RunsStub] }).compile();
    app = module.createNestApplication<NestExpressApplication>({ bodyParser: false, logger: false });
    secureHttp(app, 'http://panel.example:8080');
    await app.listen(0, '127.0.0.1');
    port = (app.getHttpServer().address() as AddressInfo).port;
  });

  beforeEach(() => {
    created.length = 0;
  });

  afterAll(async () => {
    await app.close();
  });

  it('refuses a urlencoded form post and creates nothing', async () => {
    const response = await send(port, {
      method: 'POST',
      path: '/runs',
      type: 'application/x-www-form-urlencoded',
      body: 'prompt=x',
    });
    expect(response.status).toBe(415);
    expect(created).toEqual([]);
  });

  it('refuses a text/plain post and a post without a content type', async () => {
    const plain = await send(port, { method: 'POST', path: '/runs', type: 'text/plain', body: '{"prompt":"x"}' });
    const bare = await send(port, { method: 'POST', path: '/runs' });
    expect([plain.status, bare.status]).toEqual([415, 415]);
    expect(created).toEqual([]);
  });

  it('takes a JSON post, with or without a charset', async () => {
    const plain = await send(port, { method: 'POST', path: '/runs', type: 'application/json', body: '{"a":1}' });
    const charset = await send(port, {
      method: 'POST',
      path: '/runs',
      type: 'application/json; charset=utf-8',
      body: '{"a":2}',
    });
    expect([plain.status, charset.status]).toEqual([201, 201]);
    expect(created).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('answers a read without a content type', async () => {
    expect((await send(port, { method: 'GET', path: '/health' })).status).toBe(200);
  });

  it('answers a foreign Host with 421 and the four own hosts normally', async () => {
    const foreign = await send(port, { method: 'GET', path: '/health', host: 'evil.example:3920' });
    expect(foreign.status).toBe(421);
    for (const host of ['127.0.0.1:3920', 'localhost:3920', 'panel.example:8080', 'server:3920']) {
      expect((await send(port, { method: 'GET', path: '/health', host })).status).toBe(200);
    }
  });
});
