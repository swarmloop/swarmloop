import { ContainerGate } from '../sandbox/container-gate';
import { ServerController } from './server.controller';

describe('ServerController', () => {
  it('pauses on POST and resumes on DELETE, and a second DELETE changes nothing', () => {
    const gate = new ContainerGate();
    const controller = new ServerController(gate);
    expect(controller.pause()).toEqual({ paused: true });
    expect(gate.paused()).toBe(true);
    expect(controller.resume()).toEqual({ paused: false });
    expect(controller.resume()).toEqual({ paused: false });
    expect(gate.paused()).toBe(false);
  });
});
