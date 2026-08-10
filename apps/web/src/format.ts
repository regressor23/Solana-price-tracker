/** Shared number formatting for the HUD and the debug view. */

const usdFmt = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export const usd = (value: number): string => usdFmt.format(value);

/** Compact money for wall totals: $1.9M, $412K, $88. */
export function usdCompact(value: number): string {
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(2)}`;
}

/** Fractions in, signed percent out. */
export function pct(fraction: number, digits = 3): string {
  return `${fraction >= 0 ? '+' : ''}${(fraction * 100).toFixed(digits)}%`;
}

export function num(value: number, digits = 0): string {
  return value.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/** Human age of a timestamp: "3s", "2m", "—". */
export function age(at: number | null, now = Date.now()): string {
  if (at === null || at === 0) return '—';
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`;
}

export const clock = (at = Date.now()): string =>
  new Date(at).toISOString().slice(11, 19);
