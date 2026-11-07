import type { ReactElement, ReactNode } from 'react';
import Box from '@mui/material/Box';
import Link from '@mui/material/Link';
import Typography from '@mui/material/Typography';
import { requirementsView } from '@contract/requirements-view';
import { MarkdownBody } from '../../../components/ui/markdown-body';

function Section({ title, children }: { title: string; children: ReactNode }): ReactElement {
  return (
    <Box sx={{ mt: 1 }}>
      <Typography variant="overline" color="text.secondary">
        {title}
      </Typography>
      {children}
    </Box>
  );
}

function Linked({ text, url }: { text: string; url?: string | null }): ReactElement {
  return <Box>{url ? <Link href={url}>{text}</Link> : text}</Box>;
}

/** The requirements document of a run for a person: the prompt, the tickets, the pages and files, and the plan as a checklist. */
export function RequirementsDetail({ body }: { body: string }): ReactElement {
  const view = requirementsView(body);
  if (!view) {
    return <MarkdownBody text={body} />;
  }
  return (
    <Box sx={{ minWidth: 0 }}>
      {view.prompt ? (
        <Section title="Prompt">
          <MarkdownBody text={view.prompt} />
        </Section>
      ) : null}
      {view.tickets.length > 0 ? (
        <Section title="Tickets">
          {view.tickets.map((ticket, index) => (
            <Linked
              key={ticket.key ?? index}
              text={[ticket.key, ticket.summary].filter(Boolean).join(' ')}
              url={ticket.url}
            />
          ))}
        </Section>
      ) : null}
      {view.epics.length > 0 ? (
        <Section title="Epic">
          {view.epics.map((epic, index) => (
            <Linked key={epic.key ?? index} text={[epic.key, epic.summary].filter(Boolean).join(' ')} url={epic.url} />
          ))}
        </Section>
      ) : null}
      {view.pages.length > 0 ? (
        <Section title="Pages">
          {view.pages.map((page, index) => (
            <Linked key={page.id ?? index} text={page.title ?? page.id ?? 'page'} url={page.url} />
          ))}
        </Section>
      ) : null}
      {view.files.length > 0 ? (
        <Section title="Files">
          {view.files.map((file, index) => (
            <Linked key={file.name ?? index} text={file.name ?? 'file'} url={file.url} />
          ))}
        </Section>
      ) : null}
      {view.plan ? (
        <Section title={view.plan.name ? `Plan: ${view.plan.name}` : 'Plan'}>
          {view.plan.overview ? <MarkdownBody text={view.plan.overview} /> : null}
          <Box component="ul" aria-label="Plan checklist" sx={{ m: 0, pl: 2.5, listStyle: 'none' }}>
            {view.plan.items.map((item) => (
              <li key={item}>
                <span aria-hidden>{'☐'} </span>
                {item}
              </li>
            ))}
          </Box>
        </Section>
      ) : null}
    </Box>
  );
}
