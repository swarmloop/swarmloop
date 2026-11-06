import type { Step } from '../steps/step';
import { flagError } from './flag-error';

const step = (capabilities: Step['capabilities']) => ({ capabilities }) as Step;

describe('flagError', () => {
  it('refuses a prompt for a step without the prompt capability', () => {
    expect(flagError(step({}), { prompt: 'x' })).toBe('prompt is only valid for requirements');
    expect(flagError(step({}), { promptFile: 'p.md' })).toBe('prompt is only valid for requirements');
  });

  it('refuses a path for a step without the path capability', () => {
    expect(flagError(step({ prompt: true }), { path: '/tmp/x' })).toBe('path is only valid for code-review');
  });

  it('refuses both for a missing step', () => {
    expect(flagError(null, { prompt: 'x' })).toBe('prompt is only valid for requirements');
    expect(flagError(null, { path: '/tmp/x' })).toBe('path is only valid for code-review');
  });

  it('allows what the capabilities cover', () => {
    expect(flagError(step({ prompt: true }), { prompt: 'x' })).toBeNull();
    expect(flagError(step({ path: true }), { path: '/tmp/x' })).toBeNull();
    expect(flagError(step({}), {})).toBeNull();
  });
});
