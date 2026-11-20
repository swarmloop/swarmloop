import { useId, useState, type ReactElement, type ReactNode } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Collapse from '@mui/material/Collapse';
import { DisclosureIcon } from '../../../components/ui/disclosure-icon';

/** A section folded under its title and count; `action` sits beside the button, not inside it. */
export function FoldedSection({
  title,
  count,
  action,
  children,
}: {
  title: string;
  count?: number;
  action?: ReactNode;
  children: ReactNode;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const label = count === undefined ? title : `${title} (${count})`;
  return (
    <Box sx={{ minWidth: 0 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Button
          size="small"
          color="inherit"
          aria-expanded={open}
          aria-controls={bodyId}
          startIcon={<DisclosureIcon open={open} />}
          onClick={() => setOpen(!open)}
          sx={{ justifyContent: 'flex-start', textTransform: 'none', flex: '1 1 0', minWidth: 0 }}
        >
          {label}
        </Button>
        {action}
      </Box>
      <Collapse in={open} unmountOnExit>
        <Box id={bodyId} sx={{ pl: 2, minWidth: 0 }}>
          {children}
        </Box>
      </Collapse>
    </Box>
  );
}
