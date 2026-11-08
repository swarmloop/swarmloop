import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SwarmloopError } from '../core/swarmloop-error';
import { imageOf, resolveImage } from './image-resolver';

const DIGEST = `sha256:${'a'.repeat(64)}`;

function manifest(body: unknown): string {
  const path = join(mkdtempSync(join(tmpdir(), 'swarmloop-manifest-')), 'release.json');
  writeFileSync(path, typeof body === 'string' ? body : JSON.stringify(body));
  return path;
}

describe('resolveImage', () => {
  it('names the local image build.sh tags when there is no manifest', () => {
    expect(resolveImage('agent-claude', undefined)).toEqual({ ref: 'swarmloop-agent-claude', registry: false });
    expect(resolveImage('agent-codex', '')).toEqual({ ref: 'swarmloop-agent-codex', registry: false });
    expect(resolveImage('egress', undefined)).toEqual({ ref: 'swarmloop-egress', registry: false });
  });

  it('takes the reference and the version from the manifest', () => {
    const path = manifest({ version: '1.4.0', images: { 'agent-cursor': `ghcr.io/acme/agent-cursor@${DIGEST}` } });
    expect(resolveImage('agent-cursor', path)).toEqual({
      ref: `ghcr.io/acme/agent-cursor@${DIGEST}`,
      registry: true,
      version: '1.4.0',
    });
  });

  it('reads the manifest again on every call', () => {
    const path = manifest({ version: '1', images: { egress: `r/egress@${DIGEST}` } });
    expect(resolveImage('egress', path).version).toBe('1');
    writeFileSync(path, JSON.stringify({ version: '2', images: { egress: `r/egress@${DIGEST}` } }));
    expect(resolveImage('egress', path).version).toBe('2');
  });

  it('refuses a manifest of the wrong shape, an unreadable one, and a missing component', () => {
    expect(() => resolveImage('egress', manifest({ images: {} }))).toThrow(SwarmloopError);
    expect(() => resolveImage('egress', manifest('not json'))).toThrow('cannot be read');
    expect(() => resolveImage('egress', join(tmpdir(), 'swarmloop-no-such-manifest.json'))).toThrow('cannot be read');
    expect(() => resolveImage('egress', manifest({ version: '1', images: {} }))).toThrow('has no image for egress');
  });
});

describe('imageOf', () => {
  it('counts only a digest-pinned reference as a registry reference', () => {
    expect(imageOf(`r/x@${DIGEST}`).registry).toBe(true);
    expect(imageOf('r/x:latest').registry).toBe(false);
    expect(imageOf('local-name').registry).toBe(false);
  });
});
