import type { FlowRepository } from '../history/flow.repository';
import type { CommandService } from '../pipeline/command.service';
import type { PipelineService } from '../pipeline/pipeline.service';
import { RunCommand } from './run.command';

describe('RunCommand', () => {
  it("sends its Resume marked as a person's", async () => {
    const inProcess = jest.fn().mockResolvedValue({ exitCode: 0, message: 'ok' });
    const command = new RunCommand(
      {} as PipelineService,
      { inProcess } as unknown as CommandService,
      {} as FlowRepository,
    );
    const write = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await command.run(['proj-1'], { prompt: 'go' });
    write.mockRestore();
    expect(inProcess).toHaveBeenCalledWith('resume', 'proj-1', { prompt: 'go', by: 'person' }, expect.any(Function));
  });
});
