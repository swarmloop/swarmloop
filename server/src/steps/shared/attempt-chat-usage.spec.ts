import { AttemptChatUsage } from './attempt-chat-usage';

const first = { usd: 1, tokensIn: 100, tokensOut: 10 };

describe('AttemptChatUsage', () => {
  it('adds the finished launches of the same attempt and chat', () => {
    const usage = new AttemptChatUsage();
    usage.add('run-1', 'attempt-1', 'chat-a', first);
    usage.add('run-1', 'attempt-1', 'chat-a', { usd: 0.5, tokensIn: 20, tokensOut: 2 });
    expect(usage.of('run-1', 'attempt-1', 'chat-a')).toEqual({ usd: 1.5, tokensIn: 120, tokensOut: 12 });
  });

  it('does not add them for another chat, another run or an unknown attempt', () => {
    const usage = new AttemptChatUsage();
    usage.add('run-1', 'attempt-1', 'chat-a', first);
    const none = { usd: 0, tokensIn: 0, tokensOut: 0 };
    expect(usage.of('run-1', 'attempt-1', 'chat-b')).toEqual(none);
    expect(usage.of('run-2', 'attempt-1', 'chat-a')).toEqual(none);
  });

  it('keeps the last reported totals of a chat in the attempt', () => {
    const usage = new AttemptChatUsage();
    expect(usage.reportedOf('run-1', 'attempt-1', 'chat-a')).toBeUndefined();
    usage.add('run-1', 'attempt-1', 'chat-a', { ...first, reported: { usd: 1.37, tokensIn: 100, tokensOut: 10 } });
    usage.add('run-1', 'attempt-1', 'chat-a', { ...first, reported: { usd: 1.5, tokensIn: 120, tokensOut: 12 } });
    expect(usage.reportedOf('run-1', 'attempt-1', 'chat-a')).toEqual({ usd: 1.5, tokensIn: 120, tokensOut: 12 });
    usage.add('run-1', 'attempt-1', 'chat-b', first);
    expect(usage.reportedOf('run-1', 'attempt-1', 'chat-b')).toBeNull();
    expect(usage.reportedOf('run-1', 'attempt-2', 'chat-a')).toBeUndefined();
  });

  it('drops them when a new attempt of the run starts', () => {
    const usage = new AttemptChatUsage();
    usage.add('run-1', 'attempt-1', 'chat-a', first);
    expect(usage.of('run-1', 'attempt-2', 'chat-a')).toEqual({ usd: 0, tokensIn: 0, tokensOut: 0 });
    usage.add('run-1', 'attempt-2', 'chat-a', { usd: 2, tokensIn: 5, tokensOut: 1 });
    expect(usage.of('run-1', 'attempt-1', 'chat-a')).toEqual({ usd: 0, tokensIn: 0, tokensOut: 0 });
    expect(usage.of('run-1', 'attempt-2', 'chat-a')).toEqual({ usd: 2, tokensIn: 5, tokensOut: 1 });
  });
});
