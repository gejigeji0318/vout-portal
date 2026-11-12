import '@fontsource-variable/noto-sans-jp';
import '@mantine/core/styles.css';
import '@mantine/notifications/styles.css';
import './global.css';
import { MantineProvider } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { SessionProvider } from './session';
import { theme } from './theme';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MantineProvider theme={theme} defaultColorScheme="light">
      <Notifications position="top-right" />
      <SessionProvider><App /></SessionProvider>
    </MantineProvider>
  </StrictMode>,
);
