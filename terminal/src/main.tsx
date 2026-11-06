import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { unlockAudioOnFirstGesture } from './lib/audio';
import { Root } from './Root';

const root = document.getElementById('root');
if (!root) throw new Error('#root missing from index.html');

unlockAudioOnFirstGesture();

createRoot(root).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
