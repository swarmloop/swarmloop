import { chatHeld, chatLockBody, containerLockBody, chatResume, lockRelease, readChatLock } from './chat-lock';

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
    expect(readChatLock(body)).toEqual({
      status: 'waiting',
      container: 'swarmloop-demo-shell',
      since: 1_700_000_000_000,
    });
    expect(readChatLock('waiting container swarmloop-demo-shell')).toEqual({
      status: 'waiting',
      container: 'swarmloop-demo-shell',
    });
    expect(chatHeld(body, 'running', null)).toBe(true);
    expect(chatResume(body, null)).toBeNull();
  });

  describe('the reason line', () => {
    const reason = { code: 'STOPPED', message: 'stopped by a person' };

    it('is written only when a reason is given', () => {
      expect(chatLockBody('blocked', 7)).toBe('blocked 7\n');
      expect(chatLockBody('blocked', 7, null)).toBe('blocked 7\n');
      expect(chatLockBody('blocked', 7, reason)).toBe(`blocked 7\n${JSON.stringify(reason)}\n`);
      expect(containerLockBody('blocked', 'shell-a', 5)).toBe('blocked container shell-a 5\n');
      expect(containerLockBody('blocked', 'shell-a', 5, reason)).toBe(
        `blocked container shell-a 5\n${JSON.stringify(reason)}\n`,
      );
    });

    it('is read back from a chat lock and a container lock', () => {
      expect(readChatLock(chatLockBody('blocked', 7, reason))).toEqual({ status: 'blocked', pid: 7, reason });
      expect(readChatLock(containerLockBody('blocked', 'shell-a', 5, reason))).toEqual({
        status: 'blocked',
        container: 'shell-a',
        since: 5,
        reason,
      });
      expect(chatResume(chatLockBody('blocked', 2_000_000_001, reason), 2_000_000_001)).toBe('blocked');
    });

    it('reads no reason from a body written before, and releases with null', () => {
      const old = readChatLock('blocked 7\n');
      expect(old?.reason).toBeUndefined();
      expect(lockRelease(old!)).toEqual({ status: 'blocked', reason: null });
      expect(lockRelease(readChatLock(chatLockBody('blocked', 7, reason))!)).toEqual({ status: 'blocked', reason });
    });
  });
});
