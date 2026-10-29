import { allowedPaths, isDenied, parsePaths, renderPaths } from './commit-paths';

describe('commit paths', () => {
  it('drops a denied path and keeps the rest', () => {
    const porcelain = ' M src/field.ts\0?? .env\0?? docker/docker-compose.dev.yml\0?? fresh/.env\0?? fresh/keep.ts\0R  src/new.ts\0src/old.ts\0';
    expect(allowedPaths('demo', porcelain, ['.env', 'docker/docker-compose.dev.yml'])).toEqual([
      { repo: 'demo', path: 'src/field.ts' },
      { repo: 'demo', path: 'fresh/keep.ts' },
      { repo: 'demo', path: 'src/new.ts' },
    ]);
    expect(isDenied('config/.env', ['.env'])).toBe(true);
  });

  it('round-trips the planned list', () => {
    const body = renderPaths([
      { repo: 'demo', path: 'src/field.ts' },
      { repo: 'web', path: 'app/page.ts' },
    ]);
    expect(parsePaths(body)).toEqual([
      { repo: 'demo', path: 'src/field.ts' },
      { repo: 'web', path: 'app/page.ts' },
    ]);
  });

});