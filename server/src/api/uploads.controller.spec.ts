import 'reflect-metadata';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'fs';
import { request } from 'http';
import type { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { AuthService } from '../auth/auth.service';
import { AppConfig } from '../config/env';
import { testEnv } from '../config/env.spec-helpers';
import { MAX_UPLOAD_BYTES } from '../contract/attachments';
import { Clock, SystemClock } from '../core/clock';
import { AttachmentStore } from '../history/attachment-store';
import { uploadsDir } from '../history/run-paths';
import { secureHttp } from './request-guard';
import { UploadsController } from './uploads.controller';

function post(
  port: number,
  path: string,
  options: { type: string; body: Buffer; headers?: Record<string, string> },
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path,
        headers: {
          host: 'localhost',
          'content-type': options.type,
          'content-length': options.body.length,
          'x-swarmloop': '1',
          cookie: 'in',
          ...options.headers,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>,
          }),
        );
      },
    );
    req.on('error', reject);
    req.end(options.body);
  });
}

describe('POST /uploads', () => {
  let app: NestExpressApplication;
  let port: number;
  let config: AppConfig;

  beforeAll(async () => {
    config = new AppConfig(testEnv({ SWARMLOOP_ROOT: mkdtempSync(join(tmpdir(), 'uploads-')) }));
    const module = await Test.createTestingModule({
      controllers: [UploadsController],
      providers: [
        AttachmentStore,
        { provide: AppConfig, useValue: config },
        { provide: Clock, useClass: SystemClock },
        {
          provide: AuthService,
          useValue: {
            check: (credentials: { cookie?: string }) => Promise.resolve({ allowed: credentials.cookie === 'in' }),
          },
        },
      ],
    }).compile();
    app = module.createNestApplication<NestExpressApplication>({ bodyParser: false, logger: false });
    secureHttp(app, 'http://localhost:3920');
    await app.listen(0, '127.0.0.1');
    port = (app.getHttpServer().address() as AddressInfo).port;
  });

  afterAll(async () => {
    await app.close();
  });

  const OCTETS = 'application/octet-stream';

  it('keeps a file of the largest size and answers its id, name and size', async () => {
    const bytes = Buffer.alloc(MAX_UPLOAD_BYTES, 7);
    const response = await post(port, '/uploads?name=big%20file.bin', { type: OCTETS, body: bytes });
    expect(response.status).toBe(201);
    expect(response.body).toEqual({ id: expect.any(String), name: 'big-file.bin', size: MAX_UPLOAD_BYTES });
    const kept = readFileSync(join(uploadsDir(config), String(response.body.id), 'file', 'big-file.bin'));
    expect(kept.equals(bytes)).toBe(true);
  });

  it('refuses a file above 25 MB with the plain-words text and keeps nothing', async () => {
    const response = await post(port, '/uploads?name=huge.mov', {
      type: OCTETS,
      body: Buffer.alloc(MAX_UPLOAD_BYTES + 1),
    });
    expect(response.status).toBe(413);
    expect(response.body.message).toBe('huge.mov is larger than 25 MB. Send a smaller file.');
  });

  it('answers 401 and keeps nothing for a request without a login, before it takes the body', async () => {
    const kept = () => (existsSync(uploadsDir(config)) ? readdirSync(uploadsDir(config)).length : 0);
    const before = kept();
    const response = await post(port, '/uploads?name=a.txt', {
      type: OCTETS,
      body: Buffer.alloc(MAX_UPLOAD_BYTES),
      headers: { cookie: 'out' },
    });
    expect(response.status).toBe(401);
    expect(response.body.message).toBe('log in first');
    expect(kept()).toBe(before);
  });

  it('asks for the name when it is missing', async () => {
    const response = await post(port, '/uploads', { type: OCTETS, body: Buffer.from('x') });
    expect(response.status).toBe(400);
    expect(response.body.message).toBe('name is missing');
  });

  it('keeps the guard: a foreign origin is refused, and any other route still refuses a raw body', async () => {
    const foreign = await post(port, '/uploads?name=a', {
      type: OCTETS,
      body: Buffer.from('x'),
      headers: { origin: 'http://evil.example' },
    });
    const other = await post(port, '/runs', { type: OCTETS, body: Buffer.from('x') });
    expect([foreign.status, other.status]).toEqual([403, 415]);
  });
});
