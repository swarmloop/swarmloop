import { mainWaitFor } from './main-readings';

describe('mainWaitFor', () => {
  it('gives no wait for a main that passes', () => {
    expect(mainWaitFor('web', { state: 'green' }, false)).toBeNull();
    expect(mainWaitFor('web', { state: 'none' }, false)).toBeNull();
  });

  it('waits for a red, pending or unread main', () => {
    expect(mainWaitFor('web', { state: 'red' }, false)).toBe('waits for a green main of web');
    expect(mainWaitFor('web', { state: 'pending' }, false)).toBe('waits for a green main of web');
    expect(mainWaitFor('web', undefined, false)).toBe('waits for a green main of web');
  });

  it('says why a main cannot be read', () => {
    expect(mainWaitFor('web', { state: 'unreadable', note: 'host down' }, false)).toBe(
      'waits for a green main of web: host down',
    );
  });

  it('gives no wait to the task that fixes this main', () => {
    expect(mainWaitFor('web', { state: 'red' }, true)).toBeNull();
  });
});
