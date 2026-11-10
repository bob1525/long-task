import { asLispError, serializeError } from './error';
import { Machine } from './machine';
import { parseProgram } from './parser';
import type { ErrorView, Snapshot } from './types';
import { createRuntime } from './world';

export const MAX_HISTORY = 80_000;

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

export class Session {
  readonly source: string;
  readonly history: Snapshot[] = [];
  cursor = 0;
  private readonly machine: Machine | null;

  constructor(source: string) {
    this.source = source;
    try {
      this.machine = new Machine(parseProgram(source), createRuntime(), true);
      this.history.push(this.machine.toSnapshot());
    } catch (error) {
      this.machine = null;
      const lisp = asLispError(error, null);
      this.history.push(syntaxSnapshot(lisp));
    }
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
    if (this.history.length >= MAX_HISTORY) {
      this.machine.forceError(
        asLispError(new Error(`可视化历史超过 ${MAX_HISTORY} 步，已停止`), this.machine.currentSpan),
      );
    } else {
      this.machine.step();
    }
    this.history.push(this.machine.toSnapshot());
    this.cursor = this.history.length - 1;
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

  run(limit = 100_000): Snapshot {
    let guard = 0;
    while (guard < limit) {
      const atEnd = this.cursor >= this.history.length - 1;
      const status = this.snapshot.status;
      if (atEnd && (status === 'done' || status === 'error')) break;
      const before = this.cursor;
      this.stepForward();
      if (this.cursor === before) break;
      guard += 1;
    }
    return this.snapshot;
  }
}
