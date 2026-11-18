import type { ReactElement } from 'react';
import Chip from '@mui/material/Chip';
import Stack from '@mui/material/Stack';
import CloseIcon from '@mui/icons-material/Close';
import type { AttachmentRef } from '@contract/attachments';

/** One chip per attached file: its name and a cross that removes it. */
export function FileChips({
  files,
  onRemove,
}: {
  files: readonly AttachmentRef[];
  onRemove: (id: string) => void;
}): ReactElement | null {
  if (files.length === 0) {
    return null;
  }
  return (
    <Stack direction="row" gap={0.75} flexWrap="wrap" role="list" aria-label="Attached files">
      {files.map((file) => (
        <Chip
          key={file.id}
          role="listitem"
          size="small"
          variant="outlined"
          label={file.name}
          onDelete={() => onRemove(file.id)}
          deleteIcon={<CloseIcon titleAccess={`Remove ${file.name}`} />}
        />
      ))}
    </Stack>
  );
}
