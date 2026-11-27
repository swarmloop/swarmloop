import { BadRequestException } from '@nestjs/common';
import { SwarmloopError } from '../core/swarmloop-error';
import { CheckoutsController } from './checkouts.controller';
import type { RemoteListService } from './remote-list.service';

function controller(remote: Partial<Record<keyof RemoteListService, jest.Mock>>): CheckoutsController {
  return new CheckoutsController({} as never, remote as unknown as RemoteListService);
}

describe('CheckoutsController remote routes', () => {
  it('answers a create with the accepted command and passes the key and actor on', async () => {
    const create = jest.fn().mockResolvedValue({ commandId: 'c1' });
    const body = { owner: 'acme', name: 'x' };
    await expect(controller({ create }).createRepository(body, 'ann', 'key')).resolves.toEqual({ commandId: 'c1' });
    expect(create).toHaveBeenCalledWith(body, 'key', 'ann');
  });

  it('turns a failure of the body check into a bad request', async () => {
    const create = jest.fn().mockRejectedValue(new SwarmloopError('bad body'));
    await expect(controller({ create }).createRepository({}, null)).rejects.toThrow(BadRequestException);
  });

  it('answers the list from the service and the refresh with its retry view', async () => {
    const view = jest.fn().mockResolvedValue('list');
    const retry = jest.fn().mockResolvedValue('retried');
    const subject = controller({ view, retry });
    await expect(subject.listRemote('ann')).resolves.toBe('list');
    await expect(subject.refreshRemote('ann')).resolves.toBe('retried');
    expect(retry).toHaveBeenCalledWith('ann');
  });

  it('turns a setup failure of the list or the refresh into a bad request', async () => {
    const view = jest.fn().mockRejectedValue(new SwarmloopError('no host'));
    const retry = jest.fn().mockRejectedValue(new SwarmloopError('no host'));
    const subject = controller({ view, retry });
    await expect(subject.listRemote(null)).rejects.toThrow(BadRequestException);
    await expect(subject.refreshRemote(null)).rejects.toThrow(BadRequestException);
  });
});
