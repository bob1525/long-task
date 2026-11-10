import { useId } from 'react';
import { colorForPid, toGanttSegments, type GanttSlice } from '../core';

interface GanttChartProps {
  slices: readonly GanttSlice[];
  unitPx?: number;
  sliceTestId?: string;
  rootTestId?: string;
  caption?: string;
}

export function GanttChart({
  slices,
  unitPx = 46,
  sliceTestId = 'gantt-slice',
  rootTestId = 'gantt',
  caption,
}: GanttChartProps) {
  const patternId = `idle-${useId().replace(/:/g, '')}`;
  const segments = toGanttSegments(slices);
  const end = Math.max(1, ...segments.map((segment) => segment.end));
  const left = 48;
  const top = 16;
  const barHeight = 52;
  const axisHeight = 28;
  const width = left + end * unitPx + 20;
  const height = top + barHeight + axisHeight + 8;

  return (
    <figure className="gantt-card" data-testid={rootTestId}>
      {caption ? (
        <figcaption className="gantt-caption" data-testid={rootTestId === 'gantt' ? 'gantt-caption' : undefined}>
          {caption}
        </figcaption>
      ) : null}
      {segments.length === 0 ? (
        <p className="gantt-empty">按下「单步」或「开始」后，甘特图按每次分派画出一段。相邻的同名色块若被间隙分开，表示时间片用尽后再次分派，两段不合并。</p>
      ) : (
        <div className="gantt-scroll">
          <svg
            className="gantt-svg"
            width={width}
            height={height}
            role="img"
            aria-label={caption ?? '甘特图'}
          >
            <defs>
              <pattern id={patternId} width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(35)">
                <rect width="8" height="8" fill="#e7e0d4" />
                <line x1="0" y1="0" x2="0" y2="8" stroke="#8d8476" strokeWidth="3" />
              </pattern>
            </defs>
            {Array.from({ length: end }, (_, time) => (
              <line
                key={`grid-${time}`}
                x1={left + time * unitPx}
                x2={left + time * unitPx}
                y1={top - 4}
                y2={top + barHeight + 6}
                stroke="#e4dccc"
                strokeWidth="1"
              />
            ))}
            {segments.map((segment) => {
              const x = left + segment.start * unitPx + 2;
              const barWidth = Math.max(4, (segment.end - segment.start) * unitPx - 4);
              const idle = segment.pid === null;
              const fill = idle ? `url(#${patternId})` : colorForPid(segment.pid ?? 1);
              const showRange = barWidth >= 68;
              return (
                <g
                  key={segment.index}
                  data-testid={sliceTestId}
                  data-pid={segment.pid === null ? 'idle' : String(segment.pid)}
                  data-start={segment.start}
                  data-end={segment.end}
                >
                  <rect x={x} y={top} width={barWidth} height={barHeight} rx="6" fill={fill} />
                  <text
                    x={x + barWidth / 2}
                    y={top + (showRange ? 22 : 31)}
                    textAnchor="middle"
                    className={idle ? 'gantt-label is-idle' : 'gantt-label'}
                  >
                    {segment.label}
                  </text>
                  {showRange ? (
                    <text x={x + barWidth / 2} y={top + 40} textAnchor="middle" className={idle ? 'gantt-range is-idle' : 'gantt-range'}>
                      {segment.start}–{segment.end}
                    </text>
                  ) : null}
                  <title>{`${segment.label} [${segment.start}, ${segment.end})`}</title>
                </g>
              );
            })}
            {Array.from({ length: end + 1 }, (_, time) => (
              <text key={`tick-${time}`} x={left + time * unitPx} y={top + barHeight + 22} textAnchor="middle" className="gantt-tick">
                {time}
              </text>
            ))}
          </svg>
        </div>
      )}
      {segments.length > 0 ? (
        <ul className="legend">
          {[...new Set(segments.flatMap((segment) => (segment.pid === null ? [] : [segment.pid])))].map((pid) => (
            <li key={pid}>
              <i style={{ background: colorForPid(pid) }} />
              P{pid}
            </li>
          ))}
          {segments.some((segment) => segment.pid === null) ? (
            <li>
              <i className="legend-idle" />
              空闲
            </li>
          ) : null}
        </ul>
      ) : null}
    </figure>
  );
}
