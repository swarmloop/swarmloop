import { ERROR_CODES } from '../contract/error-codes';
import { readDefaultSettings } from '../config/load-env';
import { imageMissing, imageName } from './image-resolver';

describe('imageName', () => {
  it('names the local image without a registry', () => {
    expect(imageName('agent-claude', {})).toBe('swarmloop-agent-claude');
    expect(imageName('egress', { SWARMLOOP_REGISTRY: '', SWARMLOOP_VERSION: '1.0.0' })).toBe('swarmloop-egress');
  });

  it('names the release image compose pulls, latest unless a version is set', () => {
    expect(imageName('agent-codex', { SWARMLOOP_REGISTRY: 'ghcr.io/swarmloop' })).toBe(
      'ghcr.io/swarmloop/swarmloop-agent-codex:latest',
    );
    expect(imageName('egress', { SWARMLOOP_REGISTRY: 'ghcr.io/swarmloop', SWARMLOOP_VERSION: '0.2.0' })).toBe(
      'ghcr.io/swarmloop/swarmloop-egress:0.2.0',
    );
  });

  it('takes the tag from the shipped default when the version is empty', () => {
    const tag = readDefaultSettings().SWARMLOOP_VERSION;
    expect(tag).toBe('latest');
    expect(imageName('egress', { SWARMLOOP_REGISTRY: 'ghcr.io/swarmloop', SWARMLOOP_VERSION: '' })).toBe(
      `ghcr.io/swarmloop/swarmloop-egress:${tag}`,
    );
  });
});

describe('imageMissing', () => {
  it('says how to get the image and blocks the run with IMAGE_MISSING', () => {
    const error = imageMissing('swarmloop-egress');
    expect(error.message).toContain('docker compose up -d');
    expect(error.code).toBe(ERROR_CODES.IMAGE_MISSING);
  });
});
