import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { duration } from '../../../../lib/format';
import { visitView } from '../../../../test/fixtures';
import { QueryWrapper } from '../../../../test/query-wrapper';
import { expectNoRawJson } from '../../../../test/raw-json';
import { stepEvent } from '../../../../test/step-events';
import { StepDocuments } from './step-documents';

const checks = [
  { name: 'requirements', decision: 'decision: ok', body: 'all met' },
  { name: 'security', decision: 'decision: return', body: 'token leaked' },
];

function documents(overrides: Partial<ComponentProps<typeof StepDocuments>> = {}) {
  const props = {
    shownChecks: checks,
    check: null,
    setCheck: vi.fn(),
    visit: visitView(),
    logs: '',
    document: '',
    runKey: 'run-1',
    events: [],
    issues: new Map(),
    ...overrides,
  };
  render(<StepDocuments {...props} />, { wrapper: QueryWrapper });
  return props;
}

describe('StepDocuments', () => {
  it('selects a check by its name when its button is clicked', async () => {
    const user = userEvent.setup();
    const props = documents();

    await user.click(screen.getByRole('button', { name: 'requirements ok' }));
    expect(props.setCheck).toHaveBeenLastCalledWith('requirements');

    await user.click(screen.getByRole('button', { name: 'security return' }));
    expect(props.setCheck).toHaveBeenLastCalledWith('security');
  });

  it('shows the log text and the markdown document', () => {
    documents({ logs: 'starting the agent', document: '# Report heading' });

    expect(screen.getByText('starting the agent')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Report heading' })).toBeInTheDocument();
  });

  it('shows each exchange with its model and duration', () => {
    documents({
      visit: visitView({
        exchanges: [{ model: 'claude-opus', durationMs: 2500, request: 'list files', response: 'three files' }],
      }),
    });

    expect(screen.getByText(`claude-opus · ${duration(2500)}`)).toBeInTheDocument();
  });

  it('puts the log of a visit with no events in a card marked legacy', () => {
    documents({ logs: 'starting the agent' });

    expect(screen.getByText('legacy: details not recorded')).toBeInTheDocument();
    expect(screen.getByText('starting the agent')).toBeInTheDocument();
  });

  it('shows the transcript, the live log and the exchanges of an agent step when events were recorded', () => {
    documents({
      logs: 'starting the agent',
      events: [stepEvent(1, { kind: 'artifact.produced', artifactKind: 'diff', documentId: 4, summary: 'a diff' })],
      visit: visitView({
        exchanges: [{ model: 'claude-opus', durationMs: 2500, request: 'list files', response: 'three files' }],
      }),
    });

    expect(screen.getByText('a diff')).toBeInTheDocument();
    expect(screen.queryByText('legacy: details not recorded')).not.toBeInTheDocument();
    expect(screen.getByText('starting the agent')).toBeInTheDocument();
    expect(screen.getByText(`claude-opus · ${duration(2500)}`)).toBeInTheDocument();
  });

  it('shows neither the transcript nor the legacy log while the events load', () => {
    documents({ logs: 'starting the agent', events: null });

    expect(screen.queryByText('legacy: details not recorded')).not.toBeInTheDocument();
    expect(screen.queryByText('starting the agent')).not.toBeInTheDocument();
  });

  describe('a plan visit', () => {
    const requirements = JSON.stringify({
      prompt: 'Ship the field',
      plan: { name: '', overview: '', items: ['first item'], decision: null },
    });
    const streamLine = '{"type":"system","subtype":"init","session_id":"s1"}';
    const stored = [
      { kind: 'requirements', attempt: 1, body: requirements, createdAt: 't' },
      { kind: 'log', attempt: 1, body: streamLine, createdAt: 't' },
    ];
    const recorded = [
      stepEvent(1, {
        kind: 'artifact.produced',
        artifactKind: 'requirements',
        documentId: 1,
        summary: '1 checklist items: first item',
      }),
      stepEvent(2, { kind: 'artifact.produced', artifactKind: 'log', documentId: 2, summary: streamLine }),
      stepEvent(3, {
        kind: 'handoff.sent',
        handoffId: 3,
        targetStep: 'implement',
        artifactKinds: ['requirements', 'log'],
        issueIds: [],
        summaries: ['1 checklist items: first item', streamLine],
      }),
    ];

    it('shows the cards of its events and no raw document, no log artifact and no stream line', () => {
      documents({ shownChecks: [], visit: visitView({ documents: stored }), events: recorded });

      expect(screen.getAllByText('1 checklist items: first item')).toHaveLength(2);
      expect(screen.getAllByText('artifact', { exact: false }).length).toBeGreaterThan(0);
      expect(screen.queryByText(/"subtype"/)).not.toBeInTheDocument();
      expect(screen.queryByText('Ship the field')).not.toBeInTheDocument();
      expectNoRawJson(document.body);
    });

    it('shows each document of a visit with no events once under its kind', () => {
      documents({
        shownChecks: [],
        visit: visitView({
          documents: [...stored, { kind: 'plan_notes', attempt: 1, body: '# Notes', createdAt: 't' }],
        }),
        logs: streamLine,
      });

      expect(screen.getAllByText('requirements')).toHaveLength(1);
      expect(screen.getAllByText('plan_notes')).toHaveLength(1);
      expect(screen.getAllByText('Ship the field')).toHaveLength(1);
      expect(screen.getByRole('heading', { name: 'Notes' })).toBeInTheDocument();
      expect(within(document.body).queryAllByText(/"subtype"/)).toEqual([]);
      expectNoRawJson(document.body);
    });
  });
});
