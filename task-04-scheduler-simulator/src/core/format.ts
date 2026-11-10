import { STATE_LABEL, type ProcessState } from './types';

export function formatNumber(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return value.toFixed(digits);
}

export function formatPercent(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return `${(value * 100).toFixed(digits)}%`;
}

export function formatHistory(history: readonly { time: number; state: ProcessState }[]): string {
  return history.map((entry) => `${entry.time} ${STATE_LABEL[entry.state]}`).join(' → ');
}

export function sliceSignature(
  slices: readonly { pid: number | null; start: number; end: number }[],
): string {
  return slices
    .map((slice) =>
      slice.pid === null ? `空闲[${slice.start},${slice.end})` : `P${slice.pid}[${slice.start},${slice.end})`,
    )
    .join(' ');
}
