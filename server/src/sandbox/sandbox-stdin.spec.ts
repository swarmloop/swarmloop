import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import { SandboxService } from './sandbox.service';

jest.mock('child_process', () => ({
  ...jest.requireActual<object>('child_process'),
  spawn: jest.fn(() => new EventEmitter()),
}));

describe('SandboxService stdin', () => {
  const stdinOf = (args: string[]) => {
    new SandboxService().spawnDocker(args);
    const options = jest.mocked(spawn).mock.lastCall?.[2] as { stdio: string[] };
    return options.stdio[0];
  };

  it('opens a stdin pipe for a launch with -i, and no stdin for every other launch', () => {
    expect(stdinOf(['run', '--rm', '-i', '--name', 'one', 'image'])).toBe('pipe');
    expect(stdinOf(['run', '--rm', '--name', 'two', 'image', 'tool', '-i'])).toBe('ignore');
  });
});
