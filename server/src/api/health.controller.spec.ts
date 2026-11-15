import { EventEmitter } from 'events';
import { ContainerGate } from '../sandbox/container-gate';
import { HealthController } from './health.controller';

describe('HealthController', () => {
  it('reports ok', () => {
    expect(new HealthController(new ContainerGate()).health()).toEqual({ status: 'ok', paused: false, containers: 0 });
  });

  it('counts the containers that run and says when the server is paused', async () => {
    const gate = new ContainerGate();
    const health = new HealthController(gate);
    const child = new EventEmitter();
    child.once('close', await gate.admit(() => undefined, 'run'));
    expect(health.health().containers).toBe(1);
    child.emit('close');
    expect(health.health().containers).toBe(0);
    gate.pause();
    expect(health.health().paused).toBe(true);
  });
});
