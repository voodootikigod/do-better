// FIXME: this duplicates formatting logic that also lives in server.js
export function formatUptime(seconds) {
  const s = Math.floor(seconds % 60);
  const m = Math.floor(seconds / 60) % 60;
  const h = Math.floor(seconds / 3600);
  return `${h}h ${m}m ${s}s`;
}

// HACK: quick and dirty clamp, no input validation
export function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}
