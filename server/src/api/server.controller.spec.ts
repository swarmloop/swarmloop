import { ForbiddenException } from '@nestjs/common';
import type { PeopleService } from '../auth/people.service';
import { ContainerGate } from '../sandbox/container-gate';
import { ServerController } from './server.controller';

const people = { isAdmin: async (login: string) => login === 'ada' } as PeopleService;

describe('ServerController', () => {
  it('pauses on POST and resumes on DELETE, and a second DELETE changes nothing', async () => {
    const gate = new ContainerGate();
    const controller = new ServerController(gate, people);
    expect(await controller.pause('ada')).toEqual({ paused: true });
    expect(gate.paused()).toBe(true);
    expect(await controller.resume('ada')).toEqual({ paused: false });
    expect(await controller.resume('ada')).toEqual({ paused: false });
    expect(gate.paused()).toBe(false);
  });

  it('refuses a member and nobody', async () => {
    const controller = new ServerController(new ContainerGate(), people);
    await expect(controller.pause('bob')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(controller.resume(null)).rejects.toBeInstanceOf(ForbiddenException);
  });
});
