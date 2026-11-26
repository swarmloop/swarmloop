import type { ReactElement } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import type { FlowItem } from '@contract/api';
import { FoldedText } from '../../../components/ui/folded-text';
import { MarkdownBody } from '../../../components/ui/markdown-body';
import { when } from '../../../lib/format';
import { askerName } from '../conversation/talk-entries';

/** A question for the person: what is decided first, each side on the point in dispute, the whole text folded. */
export function QuestionCard({ item }: { item: Pick<FlowItem, 'label' | 'parts'> }): ReactElement {
  const { parts } = item;
  if (!parts) {
    return <MarkdownBody text={item.label} />;
  }
  return (
    <Box sx={{ display: 'grid', gap: 1 }}>
      {parts.asker ? (
        <Typography variant="body2" color="text.secondary">
          {`${askerName(parts.asker)} asks`}
        </Typography>
      ) : null}
      <FoldedText text={[parts.decide, ...parts.sides.map((side) => side.text)].join('\n')}>
        <Box sx={{ display: 'grid', gap: 1 }}>
          <Typography sx={{ fontWeight: 600 }}>{parts.decide}</Typography>
          {parts.sides.map((side) => (
            <Box key={side.who}>
              <Typography variant="body2" color="text.secondary">
                {side.who}
              </Typography>
              <MarkdownBody text={side.text} />
            </Box>
          ))}
        </Box>
      </FoldedText>
      {parts.full ? (
        <Box component="details">
          <Box component="summary" sx={{ cursor: 'pointer', fontSize: 14 }}>
            Show the whole review
          </Box>
          <MarkdownBody text={parts.full} />
        </Box>
      ) : null}
      <Typography variant="caption" color="text.secondary">
        Asked {when(parts.askedAt)}
      </Typography>
    </Box>
  );
}
