'use client';

import type { ReactElement } from 'react';
import { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import { getSession, logout } from '../../lib/endpoints';

/** The logged-in user and a Logout button. Nothing shows when nobody is logged in, as on a server without a login. */
export function Account(): ReactElement | null {
  const [user, setUser] = useState<string | null>(null);

  useEffect(() => {
    getSession().then(
      (session) => setUser(session.user),
      () => setUser(null),
    );
  }, []);

  if (!user) {
    return null;
  }
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mr: 2 }}>
      <Typography variant="body2" color="text.secondary">
        {user}
      </Typography>
      <Button color="inherit" onClick={() => void logout().finally(() => window.location.assign('/login'))}>
        Logout
      </Button>
    </Box>
  );
}
