import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@mantine/core/styles.css';
import '@mantine/notifications/styles.css';
import './theme/fonts';
import './theme/tokens.css';
import './theme/global.css';
import { App } from './app/App';
import { createAppRouter } from './app/router';
import { createApi } from './api';

async function start() {
  const api = await createApi();
  const router = createAppRouter();
  createRoot(document.getElementById('root') as HTMLElement).render(
    <StrictMode>
      <App api={api} router={router} />
    </StrictMode>,
  );
}

void start();
