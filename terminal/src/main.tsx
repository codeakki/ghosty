import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { unlockAudioOnFirstGesture } from './lib/audio';
import './styles/tokens.css';
import './styles/app.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root missing from index.html');

unlockAudioOnFirstGesture();

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
