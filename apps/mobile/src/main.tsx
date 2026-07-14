import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MobileApp } from './MobileApp';
// The full desktop stylesheet is self-contained (CSS variables + all fn-* classes); mobile.css
// layers touch-friendly overrides on top of it.
import '../../web/src/styles.css';
import './mobile.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MobileApp />
  </StrictMode>,
);
