import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createTheme } from '@mui/material/styles';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryWrapper } from '../../../test/query-wrapper';
import { commandEvents, stepEvent } from '../../../test/step-events';
import { BUBBLE_WIDTH } from './tokens';
import { TranscriptFeed } from './transcript-feed';

vi.mock('../../../lib/endpoints', () => ({ getHistory: vi.fn() }));

const original: typeof window.matchMedia = window.matchMedia.bind(window);

/** A window of this width: jsdom has no layout, so the media queries answer from it. */
function windowOf(width: number, reducedMotion = false): void {
  window.matchMedia = (query: string) => {
    const min = /min-width:\s*(\d+)px/.exec(query)?.[1];
    const matches = min ? width >= Number(min) : reducedMotion && query.includes('prefers-reduced-motion');
    return { ...original(query), matches };
  };
}

afterEach(() => {
  window.matchMedia = original;
});

const input = (seq: number, name: string) =>
  stepEvent(seq, { kind: 'input.received', name, inputKind: name, documentId: 'absent', summary: 'absent' });
const artifact = stepEvent(9, { kind: 'artifact.produced', artifactKind: 'diff', documentId: 4, summary: 'a diff' });

function feed(events: Parameters<typeof TranscriptFeed>[0]['events'], live?: boolean, now?: number) {
  return render(<TranscriptFeed runKey="run-1" events={events} live={live} now={now} />, { wrapper: QueryWrapper });
}

const widthOf = (element: HTMLElement) => getComputedStyle(element).width;

describe('Bubble', () => {
  it.each([
    [1280, BUBBLE_WIDTH.wide],
    [1000, BUBBLE_WIDTH.medium],
    [700, BUBBLE_WIDTH.narrow],
    [400, BUBBLE_WIDTH.phone],
  ])('gives every bubble of a lane the same width at %ipx', (width, expected) => {
    windowOf(width);
    feed([input(1, 'plan'), input(2, 'diff'), artifact, ...commandEvents(10, 's', { executable: 'make' })]);

    const bubbles = screen.getAllByRole('article');
    expect(bubbles).toHaveLength(4);
    expect(bubbles.map(widthOf)).toEqual(bubbles.map(() => expected));
  });

  it('does not change the width of a bubble for a 300-character command', () => {
    windowOf(1280);
    feed([...commandEvents(1, 's', { executable: 'curl', args: ['x'.repeat(300)] })]);
    const long = widthOf(screen.getByRole('article'));
    document.body.replaceChildren();
    feed([...commandEvents(1, 's', { executable: 'ls' })]);

    expect(widthOf(screen.getByRole('article'))).toBe(long);
    expect(long).toBe(BUBBLE_WIDTH.wide);
  });

  it('shows one avatar for consecutive bubbles of one actor', () => {
    feed([input(1, 'plan'), input(2, 'diff'), artifact]);

    expect(screen.getAllByTestId('AccountTreeIcon')).toHaveLength(1);
    expect(screen.getAllByTestId('DnsIcon')).toHaveLength(1);
    expect(screen.getAllByText('Pipeline')).toHaveLength(1);
  });

  it('shows a problem with the icon, the word and the error border', () => {
    feed(commandEvents(1, 's', { executable: 'make', exitCode: 2, actor: 'server' }));

    const bubble = screen.getByRole('article', { name: 'Error: exit code 2' });
    expect(within(bubble).getByTestId('ErrorOutlineIcon')).toBeInTheDocument();
    expect(within(bubble).getByText('Error')).toBeInTheDocument();
    expect(bubble).toHaveStyle({ borderColor: createTheme().palette.error.main });
  });

  it('names a bubble by its actor and title', () => {
    feed([artifact]);

    expect(screen.getByRole('article', { name: 'Server Artifact' })).toBeInTheDocument();
  });

  it('is a polite log, and every detail toggle says whether it is open', async () => {
    const user = userEvent.setup();
    feed([...commandEvents(1, 's', { executable: 'ls', output: 'a\nb' }), artifact]);

    const log = screen.getByRole('log');
    expect(log).toHaveAttribute('aria-live', 'polite');
    const toggles = within(log).getAllByRole('button', { name: /^(Show|Hide) / });
    expect(toggles.length).toBeGreaterThan(0);
    toggles.forEach((toggle) => expect(toggle).toHaveAttribute('aria-expanded', 'false'));
    await user.click(screen.getByRole('button', { name: 'Show output · 2 lines' }));
    expect(screen.getByRole('button', { name: 'Hide output · 2 lines' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('turns the fade off under reduced motion', () => {
    windowOf(1280);
    feed([artifact]);
    expect(getComputedStyle(screen.getByRole('article')).animationName).toContain('swarmloop-fade');
    document.body.replaceChildren();

    windowOf(1280, true);
    feed([artifact]);
    expect(getComputedStyle(screen.getByRole('article')).animationName).toBe('none');
  });

  it('marks a running bubble with a progress line', () => {
    feed([stepEvent(1, { kind: 'activity.started', spanId: 'a', title: 'Check out' })]);

    expect(within(screen.getByRole('article')).getByRole('progressbar')).toBeInTheDocument();
  });
});

describe('TranscriptFeed chrome', () => {
  it('shows three skeleton bubbles at the real width while the events are read', () => {
    windowOf(1280);
    feed(null);

    const skeletons = screen.getAllByTestId('skeleton-bubble');
    expect(skeletons).toHaveLength(3);
    expect(skeletons.map(widthOf)).toEqual(skeletons.map(() => BUBBLE_WIDTH.wide));
  });

  it('shows one muted line when no bubble is left', () => {
    feed([]);

    expect(screen.getByText('Nothing to show yet')).toBeInTheDocument();
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
  });

  it('counts the cards of each filter', () => {
    feed([input(1, 'plan'), artifact, ...commandEvents(10, 's', { executable: 'make', exitCode: 1, actor: 'server' })]);

    expect(screen.queryByRole('button', { name: /^(all|inputs|actions|problems) \d/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '1 problem' })).toBeInTheDocument();
  });

  it('says whether the feed is live or since when it is not updating', () => {
    const last = Date.parse('2026-01-01T00:00:00.000Z');
    const view = feed([artifact], true, last + 60_000);
    expect(screen.getByText('live')).toBeInTheDocument();

    view.unmount();
    const silent = feed([artifact], true, last + 3 * 60_000);
    expect(screen.getByText('no output for 3 min')).toBeInTheDocument();

    silent.unmount();
    feed([artifact], false, last + 3 * 60_000);
    expect(screen.queryByText(/live|no output|not updating/)).not.toBeInTheDocument();
  });
});
