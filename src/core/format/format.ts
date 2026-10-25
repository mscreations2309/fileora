import { getLocales } from 'expo-localization';

/** Formatting follows the device locale. Sizes use SI units (1 KB = 1000 B), matching Android and iOS. */

function deviceLocale(): string {
  try {
    return getLocales()[0]?.languageTag ?? 'en-US';
  } catch {
    return 'en-US';
  }
}

let cachedLocale: string | null = null;
const numberFormats = new Map<number, Intl.NumberFormat>();

function locale(): string {
  cachedLocale ??= deviceLocale();
  return cachedLocale;
}

function numberFormat(maximumFractionDigits: number): Intl.NumberFormat {
  let format = numberFormats.get(maximumFractionDigits);
  if (!format) {
    format = new Intl.NumberFormat(locale(), { maximumFractionDigits });
    numberFormats.set(maximumFractionDigits, format);
  }
  return format;
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const;

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1000) return `${numberFormat(0).format(bytes)} B`;
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < UNITS.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${numberFormat(value < 10 ? 1 : 0).format(value)} ${UNITS[unit]}`;
}

export function formatCount(count: number): string {
  return numberFormat(0).format(count);
}

export function formatItemCount(count: number): string {
  return `${formatCount(count)} ${count === 1 ? 'item' : 'items'}`;
}

export function formatDateTime(epochMs: number | null | undefined): string {
  if (!epochMs) return 'Unknown';
  return new Intl.DateTimeFormat(locale(), { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(epochMs));
}

/** Compact date for list rows: time today, weekday this week, otherwise a short date. */
export function formatShortDate(epochMs: number | null | undefined, now: number = Date.now()): string {
  if (!epochMs) return '';
  const date = new Date(epochMs);
  const today = new Date(now);
  const sameDay = date.toDateString() === today.toDateString();
  if (sameDay) return new Intl.DateTimeFormat(locale(), { timeStyle: 'short' }).format(date);
  const ageDays = (now - epochMs) / 86_400_000;
  if (ageDays >= 0 && ageDays < 6) return new Intl.DateTimeFormat(locale(), { weekday: 'short' }).format(date);
  const sameYear = date.getFullYear() === today.getFullYear();
  return new Intl.DateTimeFormat(
    locale(),
    sameYear ? { month: 'short', day: 'numeric' } : { year: 'numeric', month: 'short', day: 'numeric' },
  ).format(date);
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function formatPercent(fraction: number): string {
  return new Intl.NumberFormat(locale(), { style: 'percent', maximumFractionDigits: 0 }).format(
    Math.min(1, Math.max(0, fraction)),
  );
}
