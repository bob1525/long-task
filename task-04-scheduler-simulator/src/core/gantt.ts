import type { GanttSlice } from './types';

export interface GanttSegment {
  index: number;
  pid: number | null;
  start: number;
  end: number;
  label: string;
}

/**
 * View model for the chart. One segment per core slice: this function must
 * not merge, split, or drop intervals. The DOM test locks that identity.
 */
export function toGanttSegments(slices: readonly GanttSlice[]): GanttSegment[] {
  return slices.map((slice, index) => ({
    index,
    pid: slice.pid,
    start: slice.start,
    end: slice.end,
    label: slice.pid === null ? '空闲' : `P${slice.pid}`,
  }));
}

export const PID_COLORS = [
  '#0072B2',
  '#C45C00',
  '#009E73',
  '#B04E8A',
  '#6E4B9E',
  '#1A6B8A',
  '#8B1E3F',
  '#4D7C0F',
] as const;

export function colorForPid(pid: number): string {
  const index = ((pid - 1) % PID_COLORS.length + PID_COLORS.length) % PID_COLORS.length;
  return PID_COLORS[index] ?? PID_COLORS[0];
}

export interface HistorySpan {
  state: 'new' | 'ready' | 'running' | 'waiting' | 'terminated';
  start: number;
  end: number;
}

/** Collapse same-timestamp transitions so the lane shows the last state at that time. */
export function historySpans(
  history: readonly { time: number; state: HistorySpan['state'] }[],
  until: number,
): HistorySpan[] {
  if (history.length === 0 || until <= 0) return [];
  const points: { time: number; state: HistorySpan['state'] }[] = [];
  for (const entry of history) {
    const previous = points[points.length - 1];
    if (previous && previous.time === entry.time) previous.state = entry.state;
    else points.push({ time: entry.time, state: entry.state });
  }
  const spans: HistorySpan[] = [];
  for (let i = 0; i < points.length; i += 1) {
    const start = points[i].time;
    const next = i + 1 < points.length ? points[i + 1].time : until;
    const end = Math.min(next, until);
    if (end > start) spans.push({ state: points[i].state, start, end });
  }
  return spans;
}
