import 'reflect-metadata';
import type { CommandService, SubmitOptions } from '../pipeline/command.service';
import { PlannerRunPort, type PlannerRunCommand } from '../pipeline/backlog/planner/planner-run-port';
import type { QuestionPassOn } from '../pipeline/question-pass-on';
import type { PlanChatService } from './plan-chat.service';
import { PlannerRunCommands } from './planner-run-commands';

type Sent = { service: string; type: string; key: string; payload: unknown; options?: SubmitOptions };

function wired() {
  const sent: Sent[] = [];
  const commands = {
    submit: async (type: string, key: string, payload: unknown, options?: SubmitOptions) => {
      sent.push({ service: 'commands', type, key, payload, options });
      return { value: undefined, receipt: {} };
    },
  } as unknown as CommandService;
  const chat = {
    send: async (key: string, message: string, author: string, idempotencyKey: string) => {
      sent.push({ service: 'plan-chat', type: 'message', key, payload: { message, author, idempotencyKey } });
    },
  } as unknown as PlanChatService;
  const passes: { run: string; question: string | undefined; line: string }[] = [];
  const passOn = {
    passOrRefuse: async (run: string, question: string | undefined, line: string) => {
      passes.push({ run, question, line });
    },
  } as unknown as QuestionPassOn;
  const port = new PlannerRunPort();
  new PlannerRunCommands(port, commands, chat, passOn).onModuleInit();
  return { port, sent, passes };
}

describe('PlannerRunCommands', () => {
  it('sends each command the way the person routes do, with the key and the owner', async () => {
    const { port, sent } = wired();
    const commands: PlannerRunCommand[] = [
      { type: 'answer', run: 'r1', answers: [{ kind: 'question', id: 'Which?', body: 'yes' }] },
      { type: 'resume', run: 'r1' },
      { type: 'replay', run: 'r1', step: 'implement' },
      { type: 'skipTask', run: 'r1', task: 't1' },
      { type: 'stop', run: 'r1' },
    ];
    for (const command of commands) await port.send(command, 'ada', 'turn-action-0');
    const key = { idempotencyKey: 'turn-action-0' };
    expect(sent).toEqual([
      {
        service: 'commands',
        type: 'answer',
        key: 'r1',
        payload: { answers: [{ kind: 'question', id: 'Which?', body: 'yes' }] },
        options: key,
      },
      { service: 'commands', type: 'resume', key: 'r1', payload: { by: 'person' }, options: { ...key, actor: 'ada' } },
      {
        service: 'commands',
        type: 'replay',
        key: 'r1',
        payload: { step: 'implement', prompt: '' },
        options: { ...key, actor: 'ada' },
      },
      { service: 'commands', type: 'skip', key: 'r1', payload: { taskId: 't1' }, options: key },
      { service: 'commands', type: 'stop', key: 'r1', payload: {}, options: key },
    ]);
  });

  it('passes a question to the person through the pass-on service, not through a run command', async () => {
    const { port, sent, passes } = wired();
    await port.send({ type: 'passOn', run: 'r1', question: 'Which?', line: 'Only you can choose.' }, 'ada', 'k-0');
    expect(passes).toEqual([{ run: 'r1', question: 'Which?', line: 'Only you can choose.' }]);
    expect(sent).toEqual([]);
  });

  it('sends an answer that names no question as a message, which answers every open question', async () => {
    const { port, sent } = wired();
    await port.send(
      { type: 'answer', run: 'r1', answers: [{ body: ' first ' }, { kind: 'question', body: 'second' }] },
      'ada',
      'turn-action-1',
    );
    expect(sent).toEqual([
      {
        service: 'commands',
        type: 'answer',
        key: 'r1',
        payload: { message: 'first\n\nsecond' },
        options: { idempotencyKey: 'turn-action-1' },
      },
    ]);
  });

  it('sends a message to the planner of a run through the plan chat as the owner', async () => {
    const { port, sent } = wired();
    await port.send({ type: 'planChat', run: 'r1', message: 'use the helper' }, 'ada', 'turn-action-3');
    expect(sent).toEqual([
      {
        service: 'plan-chat',
        type: 'message',
        key: 'r1',
        payload: { message: 'use the helper', author: 'ada', idempotencyKey: 'turn-action-3' },
      },
    ]);
  });

  it('says plainly that nothing can be sent when no sender is registered', async () => {
    await expect(new PlannerRunPort().send({ type: 'stop', run: 'r1' }, 'ada', 'k')).rejects.toThrow(
      'cannot send a command to a run',
    );
  });
});
