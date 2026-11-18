'use client';

import { type ClipboardEvent, type DragEvent, type KeyboardEvent, type ReactElement, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import AttachFileIcon from '@mui/icons-material/AttachFile';
import type { AttachmentRef } from '@contract/attachments';
import { FileChips } from './file-chips';
import { useAttachments } from './use-attachments';

/** The dashboard's one message box: the text field, its hint, the files and the send action. */
export function Composer({
  value,
  onChange,
  hint,
  onSend,
  label,
  sendLabel,
  disabled = false,
  minRows = 3,
}: {
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  onSend: (text: string, attachments: AttachmentRef[]) => void;
  label: string;
  sendLabel: string;
  disabled?: boolean;
  minRows?: number;
}): ReactElement {
  const attachments = useAttachments();
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const canSend = !disabled && !attachments.busy && value.trim() !== '';

  const send = (): void => {
    if (canSend) {
      onSend(value, attachments.files);
    }
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      send();
    }
  };

  const onPaste = (event: ClipboardEvent): void => {
    const files = Array.from(event.clipboardData.files);
    if (files.length > 0) {
      event.preventDefault();
      attachments.add(files);
    }
  };

  const onDrop = (event: DragEvent): void => {
    setDragging(false);
    const files = Array.from(event.dataTransfer.files);
    if (files.length > 0) {
      event.preventDefault();
      attachments.add(files);
    }
  };

  return (
    <Box
      onDragOver={(event) => {
        if (Array.from(event.dataTransfer.types).includes('Files')) {
          event.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      sx={{
        display: 'grid',
        gap: 1,
        outline: dragging ? '2px dashed' : 'none',
        outlineColor: 'primary.main',
        borderRadius: 1,
      }}
    >
      <TextField
        // eslint-disable-next-line jsx-a11y/no-autofocus -- the message box is the first field of its dialog or column
        autoFocus
        label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        multiline
        minRows={minRows}
        slotProps={{ inputLabel: { shrink: true } }}
      />
      <FileChips files={attachments.files} onRemove={attachments.remove} />
      {attachments.problem ? (
        <Typography color="error" variant="body2" role="alert">
          {attachments.problem}
        </Typography>
      ) : null}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Typography variant="caption" color="text.secondary" sx={{ flex: 1, minHeight: '1.5em' }}>
          {hint}
        </Typography>
        <input
          ref={input}
          type="file"
          multiple
          hidden
          aria-label="Choose files"
          data-testid="composer-file-input"
          onChange={(event) => {
            attachments.add(Array.from(event.target.files ?? []));
            event.target.value = '';
          }}
        />
        <IconButton aria-label="Attach files" onClick={() => input.current?.click()} disabled={disabled}>
          <AttachFileIcon />
        </IconButton>
        <Button variant="contained" disabled={!canSend} onClick={send}>
          {sendLabel}
        </Button>
      </Box>
    </Box>
  );
}
