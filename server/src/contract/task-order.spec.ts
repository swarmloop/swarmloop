import type { SubtaskStatus } from './subtask';
import { orderTasks, taskGroup } from './task-order';

describe('taskGroup', () => {
  it.each<[SubtaskStatus, string]>([
    ['blocked', 'person'],
    ['running', 'running'],
    ['green', 'running'],
    ['waiting', 'waiting'],
    ['pending', 'waiting'],
    ['merged', 'settled'],
    ['skipped', 'settled'],
  ])('puts %s in %s', (status, group) => {
    expect(taskGroup(status)).toBe(group);
  });
});

describe('orderTasks', () => {
  const tasks: { id: string; status: SubtaskStatus }[] = [
    { id: 'a', status: 'merged' },
    { id: 'b', status: 'waiting' },
    { id: 'c', status: 'running' },
    { id: 'd', status: 'blocked' },
    { id: 'e', status: 'running' },
    { id: 'f', status: 'skipped' },
    { id: 'g', status: 'blocked' },
  ];
  const ids = (list: { id: string }[]): string[] => list.map((task) => task.id);

  it('lists a person first, then running, then waiting, and keeps plan order inside a group', () => {
    const { open } = orderTasks(tasks, (task) => taskGroup(task.status));
    expect(ids(open)).toEqual(['d', 'g', 'c', 'e', 'b']);
  });

  it('puts merged and skipped tasks last, in plan order', () => {
    const { settled } = orderTasks(tasks, (task) => taskGroup(task.status));
    expect(ids(settled)).toEqual(['a', 'f']);
  });
});
