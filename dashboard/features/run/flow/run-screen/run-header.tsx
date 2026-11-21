'use client';

import { useState, type ReactElement } from 'react';
import type { Route } from 'next';
import Link from 'next/link';
import HourglassBottom from '@mui/icons-material/HourglassBottom';
import DataUsage from '@mui/icons-material/DataUsage';
import OpenInNew from '@mui/icons-material/OpenInNew';
import Paid from '@mui/icons-material/Paid';
import Schedule from '@mui/icons-material/Schedule';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import MuiLink from '@mui/material/Link';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { BacklogLabel } from '../../../../components/ui/backlog-label';
import { ConfirmDialog } from '../../../shell';
import { etaText } from '../../../../lib/eta-words';
import { duration, money, tokens, when } from '../../../../lib/format';
import { runWord } from '../../run-word';
import { RunStateIcon, toneColor } from '../../run-state-word';
import type { FlowView } from '@contract/api';
import { epicFigures } from '@contract/epic-figures';
import { personLabel } from '@contract/people';

export function RunHeader({
  flow,
  openMs,
  now,
  onRebase,
  onStop,
  onOpenRequirements,
}: {
  flow: FlowView;
  openMs: number;
  now: number;
  onRebase: () => Promise<void>;
  onStop: () => void;
  onOpenRequirements: () => void;
}): ReactElement {
  const [rebaseOpen, setRebaseOpen] = useState(false);
  const metric = flow.metrics;
  const figures = flow.epic
    ? epicFigures(
        {
          epicUsd: flow.epic.usd,
          ownUsd: metric.usd,
          epicMs: flow.epic.durationMs,
          taskCount: flow.tasks?.length ?? 0,
          workedMs: null,
        },
        { money, duration },
      )
    : null;
  const word = runWord(flow);
  /** The merge commit of each merged repository that has a link; the short sha is code. */
  const commits = Object.entries(flow.merge && 'merged' in flow.merge ? flow.merge.merged : {}).flatMap(
    ([repo, fact]) => (fact.sha && fact.url ? [{ repo, sha: fact.sha, url: fact.url }] : []),
  );
  const metricItems: { Icon: typeof Schedule; text: string; tip: string }[] = [
    {
      Icon: Schedule,
      text: figures ? figures.time : duration(metric.durationMs + openMs),
      tip: figures
        ? figures.timeTip
        : 'Total time the steps have run. Reviewers that run together count as the slowest one, then the report and the remaining time in that step. Time waiting on a person, and time sitting idle after a failure, is not included.',
    },
    {
      Icon: Paid,
      text: figures ? figures.money : money(metric.usd),
      tip: figures ? figures.moneyTip : 'Session spend',
    },
    ...(flow.eta ? [{ Icon: HourglassBottom, ...etaText(flow.eta, now) }] : []),
    { Icon: DataUsage, text: `${tokens(metric.tokens)} tok`, tip: 'Session tokens' },
  ];
  return (
    <>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 2 }}>
        <Box sx={{ minWidth: 0, overflow: 'hidden' }}>
          {flow.mergeRequests.length > 0 || commits.length > 0 ? (
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1.5, mb: 0.5 }}>
              {flow.mergeRequests.map((request) => (
                <MuiLink
                  key={request.url}
                  href={request.url}
                  target="_blank"
                  rel="noreferrer"
                  variant="body2"
                  sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}
                >
                  {`${request.repo} · ${request.state}`}
                  <OpenInNew sx={{ fontSize: 14 }} />
                </MuiLink>
              ))}
              {commits.map((commit) => (
                <MuiLink
                  key={commit.repo}
                  href={commit.url}
                  target="_blank"
                  rel="noreferrer"
                  variant="body2"
                  title={`Merge commit in ${commit.repo}`}
                  sx={{ fontFamily: 'var(--font-mono)' }}
                >
                  {commit.sha.slice(0, 7)}
                </MuiLink>
              ))}
            </Box>
          ) : null}
          <Tooltip title={flow.title}>
            <Button
              color="inherit"
              onClick={onOpenRequirements}
              sx={{ p: 0, minWidth: 0, textTransform: 'none', justifyContent: 'flex-start', maxWidth: '100%' }}
            >
              <Typography variant="h5" noWrap>
                {flow.title}
              </Typography>
            </Button>
          </Tooltip>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, color: toneColor(word.tone) }}>
            <RunStateIcon view={word} />
            <Typography variant="body2" sx={{ color: 'inherit' }}>
              {word.word}
            </Typography>
          </Box>
          <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 0.75 }}>
            <Typography sx={{ fontFamily: 'var(--font-mono)', fontSize: 13 }} color="text.secondary">
              {flow.key}
            </Typography>
            {flow.backlog ? <BacklogLabel label={flow.backlog} /> : null}
            {flow.startedBy ? (
              <Typography variant="body2" color="text.secondary">
                Started by {personLabel(flow.startedBy)}
              </Typography>
            ) : null}
            {flow.startedBy && flow.ownerSince ? (
              <Typography variant="body2" color="text.secondary">
                Owned by {flow.startedBy} since {when(flow.ownerSince)}, before personal tokens it ran as machine
              </Typography>
            ) : null}
            {flow.projects.map((project) => (
              <Chip
                key={project}
                size="small"
                variant="outlined"
                label={project}
                sx={{ height: 22, bgcolor: 'transparent', fontFamily: 'var(--font-mono)', fontSize: 12 }}
              />
            ))}
            {flow.workspace === 'removed' ? (
              <Chip size="small" variant="outlined" label="workspace removed" sx={{ height: 22, fontSize: 12 }} />
            ) : null}
          </Box>
        </Box>
        <Box sx={{ display: 'flex', gap: 1, flexShrink: 0 }}>
          {flow.actions.includes('rebase') ? (
            <Button variant="outlined" onClick={() => setRebaseOpen(true)}>
              Rebase
            </Button>
          ) : null}
          {flow.actions.includes('stop') ? (
            <Button color="error" variant="outlined" onClick={onStop}>
              Stop
            </Button>
          ) : null}
          <Button component={Link} href={`/runs/${flow.key}/history` as Route} color="inherit">
            All history
          </Button>
        </Box>
      </Box>
      <ConfirmDialog
        open={rebaseOpen}
        title={`Rebase ${flow.key} onto its base branch?`}
        body="The branch moves onto the newest base and the merge request goes back to draft. Checks, code review and CI run again. A conflict goes to the agent."
        verb="Rebase"
        tone="danger"
        onConfirm={onRebase}
        onClose={() => setRebaseOpen(false)}
      />
      <Box
        sx={{
          mt: 1.5,
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          columnGap: 2,
          rowGap: 0.75,
          fontSize: 13,
          color: 'text.secondary',
        }}
      >
        {metricItems.map(({ Icon, text, tip }) => (
          <Tooltip key={tip} title={tip}>
            <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
              <Icon sx={{ fontSize: 16 }} />
              {text}
            </Box>
          </Tooltip>
        ))}
      </Box>
    </>
  );
}
