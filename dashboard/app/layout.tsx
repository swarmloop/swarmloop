import { IBM_Plex_Mono, IBM_Plex_Sans } from 'next/font/google';
import InitColorSchemeScript from '@mui/material/InitColorSchemeScript';
import { Shell } from '../components/shell';
import { ThemeRegistry } from './theme-registry';

const sans = IBM_Plex_Sans({ subsets: ['latin'], weight: ['400', '500', '600'], variable: '--font-sans' });
const mono = IBM_Plex_Mono({ subsets: ['latin'], weight: ['400', '500'], variable: '--font-mono' });

export const metadata = { title: 'swarmloop' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${sans.variable} ${mono.variable}`}>
        <InitColorSchemeScript attribute="data" defaultMode="system" />
        <ThemeRegistry>
          <Shell>{children}</Shell>
        </ThemeRegistry>
      </body>
    </html>
  );
}
