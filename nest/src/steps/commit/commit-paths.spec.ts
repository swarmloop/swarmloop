import { allowedPaths, deniedIndexPaths, isDenied, parsePaths, renderPaths, stageSelection } from './commit-paths';

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

  it('adds an unstaged deletion and keeps a staged deletion and a rename source out of git add', () => {
    const porcelain = 'D  src/gone.ts\0 D src/drop.ts\0R  src/new.ts\0src/old.ts\0 M src/field.ts\0?? keep.ts\0?? .env\0';
    expect(stageSelection(porcelain, ['.env'])).toEqual({
      add: ['src/drop.ts', 'src/new.ts', 'src/field.ts', 'keep.ts'],
      staged: ['src/gone.ts', 'src/new.ts'],
    });
    expect(allowedPaths('demo', porcelain, ['.env']).map((item) => item.path)).toEqual([
      'src/gone.ts',
      'src/drop.ts',
      'src/new.ts',
      'src/field.ts',
      'keep.ts',
    ]);
    expect(deniedIndexPaths('M  .env\0D  src/gone.ts\0?? .env\0', ['.env'])).toEqual(['.env']);
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