import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '@web/App';
import '@web/styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
