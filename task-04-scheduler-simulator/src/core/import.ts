import type { ProcessSpec } from './types';

export interface ImportIssue {
  /** 1-based line for CSV, or 1-based process index for JSON. */
  line: number;
  message: string;
}

export interface ImportResult {
  processes: ProcessSpec[];
  errors: ImportIssue[];
}

function issue(line: number, message: string): ImportIssue {
  return { line, message };
}

function parseInteger(value: string, label: string, line: number, minimum: number, errors: ImportIssue[]): number | null {
  if (!/^-?\d+$/.test(value.trim())) {
    errors.push(issue(line, `${label}必须是整数`));
    return null;
  }
  const parsed = Number(value);
  if (parsed < minimum) {
    errors.push(issue(line, `${label}必须是大于等于 ${minimum} 的整数`));
    return null;
  }
  return parsed;
}

function specFromFields(
  line: number,
  fields: { pid: string; arrival: string; burst: string; priority: string; ioAfter: string; ioDuration: string },
  seen: Set<number>,
  errors: ImportIssue[],
): ProcessSpec | null {
  const before = errors.length;
  const pid = parseInteger(fields.pid, 'PID', line, 1, errors);
  const arrivalTime = parseInteger(fields.arrival, '到达时间', line, 0, errors);
  const burstTime = parseInteger(fields.burst, '服务时间', line, 1, errors);
  const priority = parseInteger(fields.priority, '优先级', line, Number.NEGATIVE_INFINITY, errors);
  if (pid !== null && seen.has(pid)) errors.push(issue(line, `PID ${pid} 重复`));
  const ioAfterText = fields.ioAfter.trim();
  const ioDurationText = fields.ioDuration.trim();
  let ioBursts: ProcessSpec['ioBursts'];
  if (ioAfterText !== '' || ioDurationText !== '') {
    const afterCpu = parseInteger(ioAfterText === '' ? 'x' : ioAfterText, 'I/O 触发', line, 1, errors);
    const duration = parseInteger(ioDurationText === '' ? 'x' : ioDurationText, 'I/O 时长', line, 1, errors);
    if (afterCpu !== null && burstTime !== null && afterCpu >= burstTime) {
      errors.push(issue(line, 'I/O 触发点必须小于服务时间'));
    }
    if (afterCpu !== null && duration !== null) ioBursts = [{ afterCpu, duration }];
  }
  if (errors.length > before || pid === null || arrivalTime === null || burstTime === null || priority === null) {
    return null;
  }
  seen.add(pid);
  const spec: ProcessSpec = { pid, arrivalTime, burstTime, priority };
  if (ioBursts) spec.ioBursts = ioBursts;
  return spec;
}

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const ch = line[index];
    if (quoted) {
      if (ch === '"') {
        if (line[index + 1] === '"') {
          current += '"';
          index += 1;
        } else quoted = false;
      } else current += ch ?? '';
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      cells.push(current.trim());
      current = '';
    } else current += ch ?? '';
  }
  cells.push(current.trim());
  return cells;
}

function importCsv(text: string): ImportResult {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const errors: ImportIssue[] = [];
  while (lines.length > 0 && lines[lines.length - 1]?.trim() === '') lines.pop();
  if (lines.length === 0 || lines[0]?.trim() === '') {
    return { processes: [], errors: [issue(1, '缺少表头 pid, arrival, burst, priority')] };
  }
  const header = parseCsvLine(lines[0] ?? '').map((cell) => cell.toLowerCase());
  const column = (names: string[]): number => names.map((name) => header.indexOf(name)).find((index) => index >= 0) ?? -1;
  const pidCol = column(['pid']);
  const arrivalCol = column(['arrival', 'arrivaltime']);
  const burstCol = column(['burst', 'bursttime', 'service']);
  const priorityCol = column(['priority']);
  const ioAfterCol = column(['io_after', 'ioafter']);
  const ioDurationCol = column(['io_duration', 'ioduration']);
  if (pidCol < 0 || arrivalCol < 0 || burstCol < 0 || priorityCol < 0) {
    return { processes: [], errors: [issue(1, '表头必须包含 pid, arrival, burst, priority')] };
  }
  const processes: ProcessSpec[] = [];
  const seen = new Set<number>();
  for (let index = 1; index < lines.length; index += 1) {
    const raw = lines[index] ?? '';
    if (raw.trim() === '') continue;
    const cells = parseCsvLine(raw);
    const line = index + 1;
    const spec = specFromFields(
      line,
      {
        pid: cells[pidCol] ?? '',
        arrival: cells[arrivalCol] ?? '',
        burst: cells[burstCol] ?? '',
        priority: cells[priorityCol] ?? '',
        ioAfter: ioAfterCol >= 0 ? (cells[ioAfterCol] ?? '') : '',
        ioDuration: ioDurationCol >= 0 ? (cells[ioDurationCol] ?? '') : '',
      },
      seen,
      errors,
    );
    if (spec) processes.push(spec);
  }
  return { processes: errors.length > 0 ? [] : processes, errors };
}

function readField(record: Record<string, unknown>, names: string[]): string {
  for (const name of names) {
    if (record[name] !== undefined && record[name] !== null) return String(record[name]);
  }
  return '';
}

function importJson(text: string): ImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : '无法解析';
    return { processes: [], errors: [issue(1, `JSON 无法解析：${message}`)] };
  }
  const records = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { processes?: unknown }).processes)
      ? (parsed as { processes: unknown[] }).processes
      : null;
  if (!records) return { processes: [], errors: [issue(1, 'JSON 必须是进程数组，或包含 processes 数组的对象')] };
  const processes: ProcessSpec[] = [];
  const errors: ImportIssue[] = [];
  const seen = new Set<number>();
  records.forEach((record, index) => {
    const line = index + 1;
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      errors.push(issue(line, '进程必须是对象'));
      return;
    }
    const row = record as Record<string, unknown>;
    const spec = specFromFields(
      line,
      {
        pid: readField(row, ['pid']),
        arrival: readField(row, ['arrivalTime', 'arrival']),
        burst: readField(row, ['burstTime', 'burst']),
        priority: readField(row, ['priority']),
        ioAfter: readField(row, ['ioAfter', 'io_after']),
        ioDuration: readField(row, ['ioDuration', 'io_duration']),
      },
      seen,
      errors,
    );
    const bursts = row.ioBursts;
    if (spec && Array.isArray(bursts) && bursts.length > 0) {
      const first = bursts[0] as { afterCpu?: unknown; duration?: unknown };
      const afterCpu = Number(first?.afterCpu);
      const duration = Number(first?.duration);
      if (!Number.isInteger(afterCpu) || !Number.isInteger(duration)) {
        errors.push(issue(line, 'ioBursts 的 afterCpu 和 duration 必须是整数'));
      } else spec.ioBursts = [{ afterCpu, duration }];
    }
    if (spec && errors.every((item) => item.line !== line)) processes.push(spec);
  });
  return { processes: errors.length > 0 ? [] : processes, errors };
}

export function importProcesses(text: string, kind: 'json' | 'csv'): ImportResult {
  return kind === 'csv' ? importCsv(text) : importJson(text);
}
