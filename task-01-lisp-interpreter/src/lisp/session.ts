import { LispError, asLispError, serializeError } from './error';
import { MAX_HISTORY, MAX_TRACE_STEPS } from './limits';
import { Machine } from './machine';
import { parseProgram } from './parser';
import type { ErrorView, Snapshot } from './types';
import { createRuntime } from './world';

export { MAX_HISTORY, MAX_TRACE_STEPS };

function syntaxSnapshot(error: { kind: ErrorView['kind']; detail: string; message: string; span: Snapshot['currentSpan'] }): Snapshot {
  const view = serializeError(error);
  return {
    step: 0,
    status: 'error',
    action: '语法错误',
    currentExpr: null,
    currentSpan: error.span,
    valuePreview: null,
    callStack: [],
    frames: [],
    activeEnvId: null,
    output: '',
    results: [],
    transcript: '',
    memory: {
      pairs: 0,
      environments: 0,
      stackDepth: 0,
      maxStackDepth: 0,
      chainDepth: 0,
      steps: 0,
    },
    error: view,
  };
}

export interface SessionOptions {
  maxHistory?: number;
  maxTraceSteps?: number;
}

export class Session {
  readonly source: string;
  readonly history: Snapshot[] = [];
  readonly maxHistory: number;
  readonly maxTraceSteps: number;
  /** Steps discarded from the front of the rewind buffer. */
  droppedSteps = 0;
  cursor = 0;
  private readonly machine: Machine | null;

  constructor(source: string, options: SessionOptions = {}) {
    this.source = source;
    this.maxHistory = options.maxHistory ?? MAX_HISTORY;
    this.maxTraceSteps = options.maxTraceSteps ?? MAX_TRACE_STEPS;
    try {
      this.machine = new Machine(parseProgram(source), createRuntime(), true);
      this.history.push(this.machine.toSnapshot());
    } catch (error) {
      this.machine = null;
      const lisp = asLispError(error, null);
      this.history.push(syntaxSnapshot(lisp));
    }
    this.trimHistory();
  }

  get snapshot(): Snapshot {
    return this.history[this.cursor] ?? this.history[0]!;
  }

  stepForward(): Snapshot {
    if (this.cursor < this.history.length - 1) {
      this.cursor += 1;
      return this.snapshot;
    }
    if (!this.machine || this.machine.isFinished()) return this.snapshot;
    if (this.machine.steps >= this.maxTraceSteps) {
      this.machine.forceError(
        new LispError(
          'runtime',
          `超过最大求值步数 ${this.maxTraceSteps}，已停止（可能存在无限循环）`,
          this.machine.currentSpan,
        ),
      );
    } else {
      this.machine.step();
    }
    this.history.push(this.machine.toSnapshot());
    this.cursor = this.history.length - 1;
    this.trimHistory();
    return this.snapshot;
  }

  stepBack(): Snapshot {
    if (this.cursor > 0) this.cursor -= 1;
    return this.snapshot;
  }

  goTo(index: number): Snapshot {
    if (this.history.length === 0) return this.snapshot;
    const next = Math.max(0, Math.min(Math.trunc(index), this.history.length - 1));
    this.cursor = next;
    return this.snapshot;
  }

  run(limit?: number): Snapshot {
    const guardLimit = limit ?? this.maxTraceSteps + 2;
    for (let guard = 0; guard < guardLimit; guard += 1) {
      const atEnd = this.cursor >= this.history.length - 1;
      const status = this.snapshot.status;
      if (atEnd && (status === 'done' || status === 'error')) break;
      const before = this.snapshot;
      this.stepForward();
      if (this.snapshot === before) break;
    }
    return this.snapshot;
  }

  private trimHistory(): void {
    const extra = this.history.length - this.maxHistory;
    if (extra <= 0) return;
    this.history.splice(0, extra);
    this.droppedSteps += extra;
    if (this.cursor >= this.history.length) this.cursor = this.history.length - 1;
  }
}
