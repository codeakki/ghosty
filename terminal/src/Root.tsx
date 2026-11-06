import { lazy, Suspense } from 'react';
import { LiveApp } from './live/LiveApp';
import { useRoute } from './live/router';

// The dense terminal is only loaded at /pro (separate chunk + stylesheet).
const ProApp = lazy(() => import('./ProApp'));

/** `/`, `/device`, `/feed` → the simple Live view. `/pro` → the dense terminal. */
export function Root() {
  const route = useRoute();
  if (route === 'pro') {
    return (
      <Suspense fallback={<p style={{ padding: 24, fontFamily: 'system-ui' }}>Loading the Pro terminal…</p>}>
        <ProApp />
      </Suspense>
    );
  }
  return <LiveApp route={route} />;
}
