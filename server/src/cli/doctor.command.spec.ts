import 'reflect-metadata';
import type { ReadinessItem } from '../contract/api';
import type { ReadinessService } from '../readiness/readiness.service';
import type { AppConfig } from '../config/env';
import { DoctorCommand } from './doctor.command';

const config = { env: { SWARMLOOP_ROOT: '/unused', SWARMLOOP_TOKEN: 'machine-secret' } } as AppConfig;

async function doctor(items: ReadinessItem[]): Promise<string> {
  const out = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  try {
    await new DoctorCommand({ report: async () => ({ items }) } as ReadinessService, config).run();
    return out.mock.calls.map(([text]) => String(text)).join('');
  } finally {
    out.mockRestore();
  }
}

describe('DoctorCommand', () => {
  afterEach(() => {
    process.exitCode = undefined;
  });

  it('prints one line per item and exits 0 when nothing failed', async () => {
    const text = await doctor([
      { id: 'docker', status: 'ok', line: 'docker answers', action: 'nothing to do' },
      { id: 'images', status: 'warn', line: 'image is not pulled yet', action: 'pulled on the first run' },
    ]);
    expect(text).toBe(
      '[ok] docker: docker answers -> nothing to do\n[warn] images: image is not pulled yet -> pulled on the first run\nmachine token: machine-secret\n',
    );
    expect(process.exitCode).toBeUndefined();
  });

  it('exits 1 when an item failed', async () => {
    const text = await doctor([
      {
        id: 'docker',
        status: 'fail',
        line: 'docker is not running',
        action: 'start Docker or mount the Docker socket',
      },
    ]);
    expect(text).toContain('[fail] docker: docker is not running -> start Docker');
    expect(process.exitCode).toBe(1);
  });
});
