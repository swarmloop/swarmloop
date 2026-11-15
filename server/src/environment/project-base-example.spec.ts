import { readFileSync } from 'fs';
import { join } from 'path';
import { fromSwarmloop } from './environment-config';

describe('the project base example', () => {
  it('is a valid .swarmloop.json with at least one check', () => {
    const text = readFileSync(join(__dirname, '../../../skills/implement/project-base.md'), 'utf8');
    const block = /```json\n([\s\S]*?)\n```/.exec(text)?.[1] ?? '';

    expect(() => fromSwarmloop(block)).not.toThrow();
    expect(fromSwarmloop(block).checks.length).toBeGreaterThan(0);
  });
});
