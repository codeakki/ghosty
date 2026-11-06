import { App } from './App';
import './styles/tokens.css';
import './styles/app.css';

/** The dense terminal (/pro), loaded on demand so its stylesheet never touches the Live view. */
export default function ProApp() {
  return <App />;
}
