import { chatHeld, chatLockBody, containerLockBody, chatResume, readChatLock } from './chat-lock';

describe('chat lock', () => {
  it('restores the feature when the chat process is gone', () => {
    const body = chatLockBody('waiting', 2_000_000_001);
    expect(readChatLock(body)).toEqual({ status: 'waiting', pid: 2_000_000_001 });
    expect(chatResume(body, 2_000_000_001)).toBe('waiting');
    expect(chatResume(body, process.pid)).toBeNull();
    expect(chatResume(chatLockBody('waiting', process.pid), process.pid)).toBeNull();
    expect(chatResume('clear\n', 2_000_000_001)).toBeNull();
    expect(chatHeld(body, 'running', 2_000_000_001)).toBe(true);
    expect(chatHeld(body, 'waiting', 2_000_000_001)).toBe(false);
  });

  it('treats a live sandbox as the owner of the feature', () => {
    const body = containerLockBody('waiting', 'swarmloop-demo-shell', 1_700_000_000_000);
    expect(readChatLock(body)).toEqual({ status: 'waiting', container: 'swarmloop-demo-shell', since: 1_700_000_000_000 });
    expect(readChatLock('waiting container swarmloop-demo-shell')).toEqual({ status: 'waiting', container: 'swarmloop-demo-shell' });
    expect(chatHeld(body, 'running', null)).toBe(true);
    expect(chatResume(body, null)).toBeNull();
  });
});
