import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { StepEvent } from '@contract/step-events';
import { StepDocuments } from '../flow/step-detail/step-documents';
import { getHistory } from '../../../lib/endpoints';
import { historyView, visitView } from '../../../test/fixtures';
import { QueryWrapper } from '../../../test/query-wrapper';
import { commandEvents, stepEvent } from '../../../test/step-events';
import type { AgentRole } from './agent-card';
import { TranscriptFeed } from './transcript-feed';
import { issueLinks } from './transcript-model';

vi.mock('../../../lib/endpoints', () => ({ getHistory: vi.fn() }));

const launch = { runtime: 'claude', model: 'opus', chatId: null, resumed: false };
const requirements = JSON.stringify({
  prompt: '# Run lifecycle l13: one command path\n\nMore text.',
  tickets: [{ key: 'PROJ-30', summary: 'Ship the field', url: 'https://jira.example/browse/PROJ-30' }],
  plan: { name: 'Plan', overview: 'Do it in two steps.', items: ['first item', 'second item'], decision: 'approve' },
});

/** A command that ran inside an activity. */
function inActivity(seq: number, span: string, parent: string, args: string[], executable = 'git'): StepEvent[] {
  return commandEvents(seq, span, { executable, args }).map((event) => ({ ...event, parentSpanId: parent }));
}

/** One attempt that holds an event of every kind the window shows. */
function fixtureRun(): StepEvent[] {
  const tools = Array.from({ length: 10 }, (_, index) =>
    stepEvent(20 + index, {
      kind: 'agent.tool',
      tool: 'shell',
      target: `npm run step-${index}`,
      status: 'ok',
      durationMs: 1200,
      resultLine: 'exit 0',
    }),
  );
  return [
    stepEvent(1, {
      kind: 'attempt.started',
      stepKind: 'agent',
      agent: { ...launch, mode: 'agent', timeLimitMs: 1, session: 'fresh' },
    }),
    stepEvent(2, {
      kind: 'input.received',
      name: 'requirements',
      inputKind: 'requirements',
      documentId: 12112,
      summary: 'PROJ-30 Ship the field',
      meta: '1 tickets · plan: 2 items · plan approved',
    }),
    stepEvent(3, {
      kind: 'input.received',
      name: 'pipelineRef',
      inputKind: 'pipeline_ref',
      documentId: 'absent',
      summary: 'absent',
    }),
    stepEvent(4, { kind: 'handoff.received', handoffId: 77, issueIds: ['i-1'], from: 'pipeline' }),
    stepEvent(5, { kind: 'activity.started', spanId: 'act', title: 'Check out feature/ship-the-field' }),
    ...inActivity(6, 'c1', 'act', ['-C', '/app/worktrees/PROJ-30/swarmloop', 'branch', '--show-current']),
    ...inActivity(8, 'c2', 'act', ['-C', '/app/worktrees/PROJ-30/swarmloop', 'rev-parse', 'HEAD']),
    ...inActivity(10, 'c3', 'act', [
      '-C',
      '/app/worktrees/PROJ-30/swarmloop',
      'switch',
      '-c',
      'feature/ship-the-field',
    ]),
    stepEvent(12, {
      kind: 'activity.finished',
      spanId: 'act',
      title: 'Check out feature/ship-the-field',
      result: 'on feature/ship-the-field at a1b2c3d',
      failed: false,
      durationMs: 900,
    }),
    ...commandEvents(13, 'r1', {
      executable: 'git',
      args: ['-C', '/app/worktrees/PROJ-30/swarmloop', 'status', '--porcelain'],
    }),
    ...commandEvents(15, 'r2', { executable: 'git', args: ['rev-parse', 'HEAD'] }),
    stepEvent(17, {
      kind: 'session.changed',
      session: 'new chat',
      runtime: 'claude',
      model: 'opus',
      reason: 'no stored chat',
    }),
    stepEvent(18, {
      kind: 'context.manifest',
      sections: [
        { heading: 'prompt', size: 2283 },
        { heading: 'Requirements', size: 416 },
      ],
      artifacts: ['/work/swarmloop'],
      cut: [],
    }),
    stepEvent(19, { kind: 'agent.launched', ...launch }),
    ...tools,
    stepEvent(30, { kind: 'agent.message', text: 'All steps ran.', chars: 14 }),
    stepEvent(31, { kind: 'agent.finished', ...launch, killReason: null, tokensIn: 3000, tokensOut: 900, usd: 0.4 }),
    stepEvent(32, {
      kind: 'http.call',
      method: 'GET',
      url: 'https://jira.example/rest/api/2/issue/PROJ-30',
      statusCode: 200,
      durationMs: 340,
    }),
    stepEvent(33, {
      kind: 'artifact.produced',
      artifactKind: 'plan',
      documentId: 123,
      summary: 'plan: 2 checklist items: first item',
    }),
    stepEvent(34, {
      kind: 'issue.opened',
      issueId: 'i-1',
      source: 'pipeline',
      title: 'unit failed',
      line: 'expected 1 got 2',
      returnedTo: 'implement',
    }),
    stepEvent(35, { kind: 'issue.resolved', issueId: 'i-1', evidence: 'pipeline a-2' }),
    stepEvent(36, {
      kind: 'handoff.sent',
      handoffId: 78,
      targetStep: 'code-review',
      artifactKinds: ['implementation'],
      issueIds: [],
      summaries: ['added the field'],
    }),
    stepEvent(37, {
      kind: 'attempt.finished',
      route: 'ok',
      summary: 'implement done',
      facts: { details: ['checks: 8 of 8 passed'] },
    }),
    stepEvent(38, { kind: 'attempt.interrupted', route: 'wait', summary: 'stopped by a person' }),
  ];
}

function feed(events: StepEvent[], role: AgentRole | null = null) {
  return render(<TranscriptFeed runKey="run-1" events={events} issues={issueLinks(events)} role={role} />, {
    wrapper: QueryWrapper,
  });
}

const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

describe('the step window for a fixture run', () => {
  it('has no raw id, bracket, timestamp or absolute path as the main line of any card', () => {
    feed(fixtureRun());

    const mains = screen.getAllByTestId('card-main').map((node) => node.textContent ?? '');
    expect(mains.length).toBeGreaterThan(8);
    for (const text of mains) {
      expect(text).not.toMatch(/document \d+/);
      expect(text).not.toMatch(/handoff \d+/);
      expect(text).not.toMatch(/^[[{]/);
      expect(text).not.toMatch(ISO);
      expect(text).not.toMatch(/\/app\/|\/work\/|\/checkouts\//);
    }
    const whole = screen.getByTestId('transcript-feed').textContent ?? '';
    expect(whole).not.toMatch(ISO);
    expect(whole).not.toContain('{');
    expect(whole).not.toMatch(/\/app\/|\/checkouts\//);
  });

  it('shows no read-only git query as a top-level card, only a count', () => {
    feed(fixtureRun());

    const whole = screen.getByTestId('transcript-feed').textContent ?? '';
    expect(whole).not.toMatch(/rev-parse|--show-current|status --porcelain|show-ref|merge-base|ls-tree/);
    expect(screen.getByText('2 git reads')).toBeInTheDocument();
  });

  it('shows the branch as one activity card whose commands open on request, with the repo name for the path', async () => {
    const user = userEvent.setup();
    feed(fixtureRun());

    expect(screen.getByText('Check out feature/ship-the-field')).toBeInTheDocument();
    expect(screen.getByText('on feature/ship-the-field at a1b2c3d')).toBeInTheDocument();
    expect(screen.getByText(/2 git reads · 1 commands|1 commands · 2 git reads/)).toBeInTheDocument();
    expect(screen.queryByText(/switch -c/)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Show commands' }));

    expect(screen.getByText('git -C swarmloop switch -c feature/ship-the-field')).toBeInTheDocument();
  });

  it('shows what the attempt came to, and the changed files and the checks of an implement attempt', () => {
    feed(fixtureRun());

    expect(screen.getByText('Done, next: code-review · checks: 8 of 8 passed')).toBeInTheDocument();
    expect(screen.getAllByText('Stopped: stopped by a person')).toHaveLength(2);
  });

  it('words the cards of the table in sentences', () => {
    feed(fixtureRun());

    expect(screen.getByText('Jira: read PROJ-30')).toBeInTheDocument();
    expect(screen.getByText('plan: 2 checklist items: first item')).toBeInTheDocument();
    expect(screen.getByText('Passed to code-review')).toBeInTheDocument();
    expect(screen.getByText('added the field')).toBeInTheDocument();
    expect(screen.getByText('From pipeline: 1 issues')).toBeInTheDocument();
    expect(screen.getByText(/Resolved in attempt 1: pipeline passed/)).toBeInTheDocument();
    expect(screen.getByText('returned to implement')).toBeInTheDocument();
    expect(screen.getByText('pipelineRef is not available')).toBeInTheDocument();
  });

  it('folds the session and the context into the agent card, and shows the cost in its footer', async () => {
    const user = userEvent.setup();
    feed(fixtureRun());

    expect(screen.getByText('claude · opus · new chat: no stored chat')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show context' }));
    expect(screen.getByText('Context: prompt 2.3k chars, requirements 0.4k, workspace: swarmloop')).toBeInTheDocument();
    expect(screen.getByText(/3k in · 900 out · \$0\.40/)).toBeInTheDocument();
  });

  it('names the role, runtime and model of the agent, and the subtask tier', () => {
    feed(fixtureRun(), { role: 'review', tier: 'main' });
    expect(screen.getByText('review · claude · opus · new chat: no stored chat')).toBeInTheDocument();
    cleanup();
    feed(fixtureRun(), { role: 'implement', tier: 'subtask' });
    expect(screen.getByText('implement · claude · opus · subtask · new chat: no stored chat')).toBeInTheDocument();
  });

  it('lists the tool calls in order, eight first, and the rest on `show all`', async () => {
    const user = userEvent.setup();
    feed(fixtureRun());

    const listed = screen.getAllByText(/^shell npm run step-/).map((node) => node.textContent ?? '');
    expect(listed).toHaveLength(8);
    expect(listed.map((text) => /step-(\d)/.exec(text)?.[1])).toEqual(['0', '1', '2', '3', '4', '5', '6', '7']);
    await user.click(screen.getByRole('button', { name: 'show all 11' }));
    expect(screen.getAllByText(/^shell npm run step-/)).toHaveLength(10);
    expect(screen.getByText('All steps ran.')).toBeInTheDocument();
  });

  it('says that tool details are not available when a runtime recorded only messages', () => {
    feed([
      stepEvent(1, { kind: 'agent.launched', ...launch, runtime: 'other' }),
      stepEvent(2, { kind: 'agent.message', text: 'I changed the config.', chars: 21 }),
      stepEvent(3, {
        kind: 'agent.finished',
        ...launch,
        runtime: 'other',
        killReason: null,
        tokensIn: 1,
        tokensOut: 1,
        usd: 0,
      }),
    ]);

    expect(screen.getByText('tool details not available from other')).toBeInTheDocument();
  });

  it('shows a host suspension as one line that says it is not counted', () => {
    feed([stepEvent(1, { kind: 'host.suspended', durationMs: 40 * 60_000 })]);

    expect(screen.getByText('40m 0s, not counted')).toBeInTheDocument();
  });

  it('turns the kill reason of an agent into a problem card', () => {
    feed([
      stepEvent(1, { kind: 'agent.launched', ...launch }),
      stepEvent(2, { kind: 'agent.finished', ...launch, killReason: 'time limit', tokensIn: 1, tokensOut: 1, usd: 0 }),
    ]);

    expect(screen.getByRole('article', { name: 'Error: killed: time limit' })).toBeInTheDocument();
  });
});

describe('the requirements input card', () => {
  const history = historyView({
    documents: [{ kind: 'requirements', attempt: 1, body: requirements, createdAt: '2026-01-01T00:00:00.000Z' }],
  });

  it('shows the ticket as its title, one meta line, and the structured document on request', async () => {
    const user = userEvent.setup();
    vi.mocked(getHistory).mockResolvedValue(history);
    feed(fixtureRun().slice(0, 3));

    expect(screen.getAllByText('requirements').length).toBeGreaterThan(0);
    expect(screen.getByText('PROJ-30 Ship the field')).toBeInTheDocument();
    expect(screen.getByText('1 tickets · plan: 2 items · plan approved')).toBeInTheDocument();
    expect(screen.getByText('document 12112')).toBeInTheDocument();
    expect(screen.queryByText('first item')).not.toBeInTheDocument();

    await user.click(screen.getAllByRole('button', { name: 'Show document' })[0]);

    expect(await screen.findByRole('link', { name: 'PROJ-30 Ship the field' })).toHaveAttribute(
      'href',
      'https://jira.example/browse/PROJ-30',
    );
    expect(screen.getByRole('heading', { name: 'Run lifecycle l13: one command path' })).toBeInTheDocument();
    const list = within(screen.getByRole('list', { name: 'Plan checklist' }));
    expect(list.getAllByRole('listitem').map((item) => item.textContent)).toEqual(['☐ first item', '☐ second item']);
    expect(screen.getByText('Do it in two steps.')).toBeInTheDocument();
  });

  it('shows the first line of the prompt as its title for a run with only a prompt', () => {
    feed([
      stepEvent(1, {
        kind: 'input.received',
        name: 'requirements',
        inputKind: 'requirements',
        documentId: 5,
        summary: 'Run lifecycle l13: one command path',
        meta: 'plan not approved yet',
      }),
    ]);

    expect(screen.getByText('Run lifecycle l13: one command path')).toBeInTheDocument();
    expect(screen.getByText('plan not approved yet')).toBeInTheDocument();
  });
});

describe('a running agent step with events', () => {
  const events = [
    stepEvent(1, {
      kind: 'attempt.started',
      stepKind: 'agent',
      agent: { ...launch, mode: 'agent', timeLimitMs: 1, session: 'fresh' },
    }),
    stepEvent(2, { kind: 'agent.launched', ...launch }),
  ];

  function documents(logs: string) {
    return (
      <StepDocuments
        runKey="run-1"
        events={events}
        issues={new Map()}
        shownChecks={[]}
        check={null}
        setCheck={vi.fn()}
        visit={visitView({
          status: 'running',
          exchanges: [{ model: 'claude-opus', durationMs: 2500, request: 'list files', response: 'three files' }],
        })}
        logs={logs}
        document=""
      />
    );
  }

  it('shows the live log as it streams, and the exchanges', () => {
    const view = render(documents('starting the agent'), { wrapper: QueryWrapper });

    expect(screen.getByText('starting the agent')).toBeInTheDocument();
    expect(screen.getByText(/claude-opus · /)).toBeInTheDocument();

    view.rerender(documents('starting the agent\nnote\n    reading the plan'));

    expect(screen.getByText(/reading the plan/)).toBeInTheDocument();
  });
});
