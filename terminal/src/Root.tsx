import { lazy, Suspense } from 'react';
import { LiveApp } from './live/LiveApp';
import { useRoute } from './live/router';

// The dense terminal is only loaded at /pro (separate chunk + stylesheet), the landing page only at /.
const ProApp = lazy(() => import('./ProApp'));
const Landing = lazy(() => import('./landing/Landing'));

/** `/` → the landing page. `/live`, `/device`, `/feed`, `/simulate` → the Live app. `/pro` → the dense terminal. */
export function Root() {
  const route = useRoute();
  if (route === 'home') {
    return (
      <Suspense fallback={<div style={{ minHeight: '100dvh', background: '#07090d' }} />}>
        <Landing />
      </Suspense>
    );
  }
  if (route === 'pro') {
    return (
      <Suspense fallback={<p style={{ padding: 24, fontFamily: 'system-ui' }}>Loading the Pro terminal…</p>}>
        <ProApp />
      </Suspense>
    );
  }
  return <LiveApp route={route} />;
}
