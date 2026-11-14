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

  it.each<SubtaskStatus>(['running', 'waiting', 'blocked'])(
    'puts %s in person when its run needs a person',
    (status) => {
      expect(taskGroup(status, true)).toBe('person');
    },
  );

  it.each<SubtaskStatus>(['merged', 'skipped'])('keeps %s settled whatever its run reads', (status) => {
    expect(taskGroup(status, true)).toBe('settled');
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

  it('lists a task that needs a person with the blocked ones, ahead of the running tasks', () => {
    const needs = new Set(['e']);
    const { open } = orderTasks(tasks, (task) => taskGroup(task.status, needs.has(task.id)));
    expect(ids(open)).toEqual(['d', 'e', 'g', 'c', 'b']);
  });

  it('puts merged and skipped tasks last, in plan order', () => {
    const { settled } = orderTasks(tasks, (task) => taskGroup(task.status));
    expect(ids(settled)).toEqual(['a', 'f']);
  });
});
