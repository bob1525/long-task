import { useMemo, useState } from 'react';
import {
  ALGORITHM_CATALOG,
  compareAlgorithms,
  comparisonToJson,
  formatNumber,
  formatPercent,
  type AlgorithmId,
  type ProcessSpec,
  type SchedulerOptions,
  type SimulationResult,
} from '../core';
import { downloadText } from './download';
import { GanttChart } from './GanttChart';

interface CompareViewProps {
  processes: ProcessSpec[];
  quantum: number;
  mlfqQuantums: number[];
}

function metric(result: SimulationResult, key: 'waiting' | 'turnaround' | 'response'): number | null {
  return result.averages[key];
}

function winners(
  results: readonly SimulationResult[],
  valueOf: (result: SimulationResult) => number | null,
  mode: 'min' | 'max',
): Set<AlgorithmId> {
  const scored = results.flatMap((result) => {
    const value = valueOf(result);
    return value === null ? [] : [{ id: result.options.algorithm, value }];
  });
  if (scored.length === 0) return new Set();
  const target =
    mode === 'min' ? Math.min(...scored.map((item) => item.value)) : Math.max(...scored.map((item) => item.value));
  return new Set(scored.filter((item) => item.value.toFixed(6) === target.toFixed(6)).map((item) => item.id));
}

export function CompareView({ processes, quantum, mlfqQuantums }: CompareViewProps) {
  const [selected, setSelected] = useState<AlgorithmId[]>(ALGORITHM_CATALOG.map((item) => item.id));
  const [report, setReport] = useState<SimulationResult[] | null>(null);
  const [error, setError] = useState('');

  const bestWaiting = useMemo(() => (report ? winners(report, (result) => metric(result, 'waiting'), 'min') : new Set()), [report]);
  const bestTurnaround = useMemo(
    () => (report ? winners(report, (result) => metric(result, 'turnaround'), 'min') : new Set()),
    [report],
  );
  const bestResponse = useMemo(
    () => (report ? winners(report, (result) => metric(result, 'response'), 'min') : new Set()),
    [report],
  );
  const bestCpu = useMemo(
    () => (report ? winners(report, (result) => result.cpuUtilization, 'max') : new Set()),
    [report],
  );

  function toggle(id: AlgorithmId) {
    setSelected((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));
  }

  function generate() {
    if (selected.length === 0) {
      setError('至少选择一种算法');
      return;
    }
    try {
      const runs: SchedulerOptions[] = ALGORITHM_CATALOG.filter((item) => selected.includes(item.id)).map((item) => ({
        algorithm: item.id,
        quantum,
        mlfqQuantums,
      }));
      setReport(compareAlgorithms(processes, runs));
      setError('');
    } catch (caught) {
      setReport(null);
      setError(caught instanceof Error ? caught.message : '无法生成对比');
    }
  }

  return (
    <section className="compare" data-testid="compare-view">
      <div className="compare-toolbar">
        <div className="check-grid">
          {ALGORITHM_CATALOG.map((item) => (
            <label key={item.id}>
              <input
                type="checkbox"
                data-testid={`compare-toggle-${item.id}`}
                checked={selected.includes(item.id)}
                onChange={() => toggle(item.id)}
              />
              {item.short}
            </label>
          ))}
        </div>
        <button type="button" data-testid="btn-compare" onClick={generate} disabled={processes.length === 0}>
          生成对比报告
        </button>
        <button
          type="button"
          data-testid="btn-export-compare"
          disabled={!report}
          onClick={() => {
            if (!report) return;
            downloadText('schedule-comparison.json', comparisonToJson(report), 'application/json');
          }}
        >
          导出对比 JSON
        </button>
      </div>
      <p className="note">
        {`同一组进程分别从 t=0 独立跑完。RR 时间片 ${quantum}，MLFQ 时间片 ${mlfqQuantums.join('/')}。改过时间片后要重新生成。高亮表示该列更优（等待、周转、响应更低，CPU 利用率更高）。`}
      </p>
      {error ? <p className="error">{error}</p> : null}
      {report ? (
        <>
          <div className="table-scroll">
            <table className="report" data-testid="compare-table">
              <thead>
                <tr>
                  <th>算法</th>
                  <th>平均等待</th>
                  <th>平均周转</th>
                  <th>平均响应</th>
                  <th>CPU 利用率</th>
                  <th>完成时刻</th>
                </tr>
              </thead>
              <tbody>
                {report.map((result) => {
                  const id = result.options.algorithm;
                  const info = ALGORITHM_CATALOG.find((item) => item.id === id);
                  return (
                    <tr key={id} data-testid={`compare-row-${id}`}>
                      <th>{info?.short ?? id}</th>
                      <td data-testid={`compare-${id}-waiting`} className={bestWaiting.has(id) ? 'is-best' : undefined}>
                        {formatNumber(result.averages.waiting)}
                      </td>
                      <td data-testid={`compare-${id}-turnaround`} className={bestTurnaround.has(id) ? 'is-best' : undefined}>
                        {formatNumber(result.averages.turnaround)}
                      </td>
                      <td data-testid={`compare-${id}-response`} className={bestResponse.has(id) ? 'is-best' : undefined}>
                        {formatNumber(result.averages.response)}
                      </td>
                      <td data-testid={`compare-${id}-cpu`} className={bestCpu.has(id) ? 'is-best' : undefined}>
                        {formatPercent(result.cpuUtilization)}
                      </td>
                      <td>{result.makespan}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="compare-gantts">
            {report.map((result) => {
              const info = ALGORITHM_CATALOG.find((item) => item.id === result.options.algorithm);
              return (
                <article key={result.options.algorithm} className="compare-block">
                  <GanttChart
                    slices={result.slices}
                    unitPx={40}
                    rootTestId={`compare-gantt-${result.options.algorithm}`}
                    sliceTestId="compare-gantt-slice"
                    caption={info?.label ?? result.options.algorithm}
                  />
                  <table className="mini">
                    <thead>
                      <tr>
                        <th>PID</th>
                        <th>完成</th>
                        <th>周转</th>
                        <th>等待</th>
                        <th>响应</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.processes.map((proc) => (
                        <tr key={proc.pid}>
                          <td>P{proc.pid}</td>
                          <td>{proc.completionTime ?? '—'}</td>
                          <td>{proc.turnaroundTime ?? '—'}</td>
                          <td>{proc.waitingTime}</td>
                          <td>{proc.responseTime ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </article>
              );
            })}
          </div>
        </>
      ) : (
        <p className="gantt-empty">选择算法后生成表格。报告里的甘特图直接使用各算法核心输出的时间片。</p>
      )}
    </section>
  );
}
