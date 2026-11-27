// Bulk selection for deleting false positives: by day, time of day, and kind.
// Pure functions (unit-tested), shared by dashcam clips, wrong-side reports and ride events.
import { stamp } from './dashcam.js';

const mins = (hhmm) => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + (m || 0); };

// t (epoch ms) on `day` ("YYYY-MM-DD", local) between from and to ("HH:MM", may wrap midnight)
export function inTimeRange(t, { day = null, from = '00:00', to = '24:00' } = {}) {
  const st = stamp(t);
  if (day && st.slice(0, 10) !== day) return false;
  const a = mins(from), b = mins(to), m = mins(st.slice(11, 16));
  return a <= b ? m >= a && m < b : m >= a || m < b;
}

// ---- wrong-side reports ----
// Automatic reports made before the 27 Nov 2026 detector fix: that detector took slower
// traffic we overtook for oncoming vehicles (and parked ones too). The new one always
// records the least speed toward us it is sure of (oncomingMinKmh); the old one never did.
export const fromOldDetector = (r) => !!r.auto && r.auto.oncomingMinKmh == null;
export const REPORT_KINDS = [
  ['all', 'All reports'],
  ['auto-old', 'Automatic, old detector (before the 27 Nov fix): mostly false'],
  ['auto-no-plate', 'Automatic, no plate read'],
  ['auto-no-vehicle', 'Automatic, no vehicle found in the photos'],
  ['unreviewed', 'Not reviewed yet (status new)'],
  ['dismissed', 'Dismissed by me'],
  ['manual', 'Captured by hand'],
];
export function reportMatches(r, kind) {
  switch (kind) {
    case 'all': return true;
    case 'auto-old': return fromOldDetector(r);
    case 'auto-no-plate': return !!r.auto && !r.plate;
    case 'auto-no-vehicle': return !!r.auto && r.analysis?.status !== 'pending' && !r.analysis?.vehicle;
    case 'unreviewed': return (r.status || 'new') === 'new';
    case 'dismissed': return r.status === 'dismissed';
    case 'manual': return !r.auto;
    default: return kind?.startsWith('type:') ? (r.vehicleType || r.analysis?.vehicle?.type || '') === kind.slice(5) : false;
  }
}
export function selectReports(reports, { kind = 'all', ...range } = {}) {
  return reports.filter((r) => reportMatches(r, kind) && inTimeRange(r.t, range)).map((r) => r.id);
}

// ---- dashcam clips: by why they were locked ----
export function clipMatches(c, kind) {
  if (kind === 'any') return true;
  if (kind === 'unlocked') return !c.locked;
  return !!c.locked && (c.incidents || []).includes(kind); // a lock reason, e.g. "Crash-level impact"
}
export function selectClips(clips, { kind = 'unlocked', ...range } = {}) {
  return clips.filter((c) => clipMatches(c, kind) && inTimeRange(c.start, range)).map((c) => c.id);
}

// ---- ride events: remove what wasn't real and recount ----
export const EVENT_COUNTS = { pothole: 'potholes', bump: 'bumps', rough: 'roughStretches', brake: 'hardBrakes', accel: 'hardAccels' };
export function selectEvents(events, { types = [], ...range } = {}) {
  return events.filter((e) => (!types.length || types.includes(e.type)) && inTimeRange(e.t, range)).map((e) => e.id);
}
export function removeEvents(ride, ids) {
  const drop = new Set(ids);
  const removed = ride.events.filter((e) => drop.has(e.id));
  if (!removed.length) return ride;
  const events = ride.events.filter((e) => !drop.has(e.id));
  const summary = { ...ride.summary };
  for (const [type, key] of Object.entries(EVENT_COUNTS)) if (key in summary || removed.some((e) => e.type === type)) summary[key] = events.filter((e) => e.type === type).length;
  return { ...ride, events, summary, removedEvents: [...(ride.removedEvents || []), ...removed.map((e) => ({ id: e.id, type: e.type, t: e.t, removedAt: Date.now() }))] };
}
