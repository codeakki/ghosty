import 'dotenv/config';

/** Stop the song on the pod and clear queued songs: npm run stop */
const res = await fetch(`http://127.0.0.1:${Number(process.env.PORT || 8787)}/stop`, {
  method: 'POST',
  headers: { 'x-device-token': process.env.GHOSTY_DEVICE_TOKEN?.trim() ?? '' },
});
const r = (await res.json()) as { cleared?: number; stoppedCurrent?: string | null };
console.log(res.ok ? `Stopped: ${r.stoppedCurrent ?? 'nothing playing'}; cleared ${r.cleared ?? 0} queued.` : `server said ${res.status}`);
