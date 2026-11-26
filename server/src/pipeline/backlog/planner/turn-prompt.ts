import { Injectable } from '@nestjs/common';
import type { BacklogEventRecord, BacklogMessageRecord } from '../../../history/backlog-writers';
import type { SandboxMount } from '../../../core/sandbox-mount';
import { AppConfig } from '../../../config/env';
import { root } from '../../../history/run-paths';
import { skillPrompt } from '../../../steps/shared/skill-prompt';
import { writeTurnBriefFiles } from './turn-brief-files';
import { decodeSeen, diffSeen, encodeSeen, type StateChanges } from './turn-changes';
import { NONE, backlogText, briefPath, eventText, messageText, milestoneText, tasksText } from './turn-lines';
import { BacklogTurnState, type TurnState } from './turn-state';

type Section = { heading: string; body: string };

/** What the planner reads at a turn, as plain sections. Run keys, slugs and refs are the only names it shows. */
function sectionsOf(state: TurnState): Section[] {
  const { backlog } = state;
  const planned = state.planned.map(milestoneText);
  const messages = state.messages.map(messageText);
  return [
    {
      heading: 'Backlog',
      body: backlogText(backlog),
    },
    { heading: 'Active milestone', body: state.active ? milestoneText(state.active) : NONE },
    { heading: 'Planned milestones', body: planned.length > 0 ? planned.join('\n\n') : NONE },
    { heading: 'Backlog items', body: tasksText(state.items) },
    {
      heading: 'Decisions',
      body: [
        ...(state.decisions.length > 0 ? state.decisions.map((item) => `- ${item.text} (${item.who})`) : [NONE]),
        ...(state.olderDecisions > 0
          ? [
              '',
              `${state.olderDecisions} older decisions are left out; all of them, newest first, are in /work/brief/decisions.md.`,
            ]
          : []),
      ].join('\n'),
    },
    {
      heading: 'Messages, oldest first',
      body: [
        ...(messages.length > 0 ? messages : [NONE]),
        '',
        `${state.olderMessages} older messages are left out. The latest messages of the chat, and how many are older, are at GET /backlogs/${backlog.name}/messages.`,
      ].join('\n'),
    },
    { heading: 'Events of this turn', body: state.events.length > 0 ? state.events.map(eventText).join('\n') : NONE },
  ];
}

/** What a resumed chat reads: only what changed in the database since it last saw the state, and the items of this turn. */
function changesSections(changes: StateChanges, state: TurnState): Section[] {
  const changed = [
    ...changes.changed.map((item) => item.text),
    ...changes.gone.map((key) => `no longer in the backlog: ${key}`),
    ...changes.briefs.map((slug) => `its brief changed: ${briefPath(slug)}`),
  ];
  return [
    { heading: 'Changed tasks, milestones and requirements', body: changed.length > 0 ? changed.join('\n') : NONE },
    {
      heading: 'New decisions',
      body:
        changes.decisions.length > 0
          ? changes.decisions.map((item) => `- ${item.text} (${item.who})`).join('\n')
          : NONE,
    },
    {
      heading: 'Messages of this turn, oldest first',
      body: state.messagesOfTurn.length > 0 ? state.messagesOfTurn.map(messageText).join('\n') : NONE,
    },
    { heading: 'Events of this turn', body: state.events.length > 0 ? state.events.map(eventText).join('\n') : NONE },
  ];
}

/** What the follow-up of a turn tells the agent first. */
const FOLLOW_UP_HEAD =
  'These messages and events came while you worked. Give your whole answer again, with its result block, taking them in.';

/** Builds the prompt of a planner turn from the state the database gives, never from a run's chat. */
@Injectable()
export class BacklogTurnPrompt {
  constructor(
    private readonly state: BacklogTurnState,
    private readonly config: AppConfig,
  ) {}

  /**
   * `fresh` starts a chat with the short state brief; `prompt` is what a chat that has seen the state before reads, and
   * equals `fresh` when the stored state is missing or unreadable; `seen` is what to store once the chat has answered.
   */
  async build(
    backlogName: string,
    turnKey: string,
    mounts: SandboxMount[],
    names: string[],
  ): Promise<{ prompt: string; fresh: string; seen: string }> {
    const state = await this.state.read(backlogName, turnKey);
    writeTurnBriefFiles(root(this.config), state.backlog.id, state);
    const requirements = `Plan the backlog ${backlogName}: answer the messages and the events of this turn.`;
    const fresh = skillPrompt('backlog-plan', requirements, names, sectionsOf(state), mounts);
    const seen = decodeSeen(state.lastSeen);
    const prompt =
      seen === null
        ? fresh
        : [
            `${requirements} What changed since your last turn:`,
            ...changesSections(diffSeen(seen, state), state).flatMap(({ heading, body }) => ['', `${heading}:`, body]),
          ].join('\n');
    return { prompt, fresh, seen: encodeSeen(state) };
  }

  /** The follow-up of a turn: the messages and events that came after its brief, written as the brief writes them. */
  async followUp(
    backlogName: string,
    turnKey: string,
    added: { messages: BacklogMessageRecord[]; events: BacklogEventRecord[] },
  ): Promise<string> {
    const messages = added.messages.map((message) =>
      messageText({ author: message.author, at: message.createdAt, text: message.text }),
    );
    const events = await this.state.eventsOf(backlogName, turnKey, added.events);
    return [
      FOLLOW_UP_HEAD,
      ...(messages.length > 0 ? ['', 'Messages, oldest first', ...messages] : []),
      ...(events.length > 0 ? ['', 'Events', ...events.map(eventText)] : []),
    ].join('\n');
  }
}
