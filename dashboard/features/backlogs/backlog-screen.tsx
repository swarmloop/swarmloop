'use client';

import { type ReactElement, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import { BacklogChat } from './chat/backlog-chat';
import { BacklogHeader } from './backlog-header';
import { BacklogSections } from './panel/backlog-sections';
import { MilestonePanel } from './panel/milestone-panel';
import { useBacklog } from './use-backlog';
import { usePhone } from './use-phone';

type PhoneTab = 'chat' | 'milestone' | 'backlog';

/** Where the viewport height leaves room under the app bar and the header, so nothing shifts while content loads. */
const BodyHeight = 'calc(100vh - 64px - 56px - 48px)';

export function BacklogScreen({ name }: { name: string }): ReactElement {
  const { view, chat, login, error, onView, onChat } = useBacklog(name);
  const phone = usePhone();
  const [tab, setTab] = useState<PhoneTab>('chat');
  if (error) {
    return <Alert severity="error">{error}</Alert>;
  }
  if (!view || !chat) {
    return <Box sx={{ minHeight: BodyHeight }} aria-busy="true" />;
  }
  const props = { view, chat, login, onView, onChat };
  const parts = {
    chat: <BacklogChat {...props} />,
    milestone: <MilestonePanel {...props} />,
    backlog: <BacklogSections {...props} />,
  };
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      <BacklogHeader view={view} login={login} onView={onView} />
      {phone ? (
        <>
          <Tabs
            value={tab}
            onChange={(_event, next: PhoneTab) => setTab(next)}
            aria-label="Backlog parts"
            variant="fullWidth"
          >
            <Tab value="chat" label="Chat" />
            <Tab value="milestone" label="Milestone" />
            <Tab value="backlog" label="Backlog" />
          </Tabs>
          <Box sx={{ height: BodyHeight, overflowY: 'auto' }}>{parts[tab]}</Box>
        </>
      ) : (
        <Box sx={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 420px', gap: 3, height: BodyHeight }}>
          <Box sx={{ minWidth: 0, overflowY: 'auto' }}>{parts.chat}</Box>
          <Box sx={{ minWidth: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
            {parts.milestone}
            {parts.backlog}
          </Box>
        </Box>
      )}
    </Box>
  );
}
