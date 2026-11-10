import { asLispError, LispError, serializeError } from './error';
import { DEFAULT_MAX_STEPS } from './limits';
import { Machine } from './machine';
import { parseProgram, parseProgramRecovering } from './parser';
import { buildTranscript } from './print';
import type { ErrorView, LispErrorLike } from './types';
import { createRuntime } from './world';

export interface ExecuteOptions {
  maxSteps?: number;
  recover?: boolean;
}

export interface FormOutcome {
  ok: boolean;
  value: string | null;
  error: ErrorView | null;
}

export interface ExecuteResult {
  ok: boolean;
  values: string[];
  last: string | null;
  output: string;
  transcript: string;
  steps: number;
  maxCallStack: number;
  error: ErrorView | null;
  forms?: FormOutcome[];
}

function emptyFailure(error: LispErrorLike): ExecuteResult {
  return {
    ok: false,
    values: [],
    last: null,
    output: '',
    transcript: '',
    steps: 0,
    maxCallStack: 0,
    error: serializeError(error),
  };
}

function finish(worldResults: string[], outputChunks: string[], steps: number, maxCallStack: number, error: LispErrorLike | null, forms?: FormOutcome[]): ExecuteResult {
  const output = outputChunks.join('');
  const values = worldResults.slice();
  const last = values.length > 0 ? values[values.length - 1]! : null;
  return {
    ok: error === null,
    values,
    last,
    output,
    transcript: buildTranscript(output, values),
    steps,
    maxCallStack,
    error: error ? serializeError(error) : null,
    ...(forms ? { forms } : {}),
  };
}

export function execute(source: string, options: ExecuteOptions = {}): ExecuteResult {
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  try {
    if (options.recover) return executeRecover(source, maxSteps);
    const runtime = createRuntime();
    const machine = new Machine(parseProgram(source), runtime, false);
    machine.run(maxSteps);
    return finish(
      runtime.world.results,
      runtime.world.output,
      machine.steps,
      Math.max(machine.maxCallStack, runtime.world.maxCallStack),
      machine.error,
    );
  } catch (error) {
    return emptyFailure(asLispError(error, null));
  }
}

function executeRecover(source: string, maxSteps: number): ExecuteResult {
  const runtime = createRuntime();
  const forms: FormOutcome[] = [];
  let steps = 0;
  let firstError: LispErrorLike | null = null;
  const items = parseProgramRecovering(source);
  for (const item of items) {
    if (!item.ok) {
      forms.push({ ok: false, value: null, error: serializeError(item.error) });
      firstError = firstError ?? item.error;
      continue;
    }
    if (steps >= maxSteps) {
      const error = new LispError(
        'runtime',
        `超过最大求值步数 ${maxSteps}，已停止（可能存在无限循环）`,
        item.expr.span,
      );
      forms.push({ ok: false, value: null, error: serializeError(error) });
      firstError = firstError ?? error;
      break;
    }
    const before = runtime.world.results.length;
    const machine = new Machine([item.expr], runtime, false);
    machine.run(maxSteps - steps);
    steps += machine.steps;
    if (machine.error) {
      forms.push({ ok: false, value: null, error: serializeError(machine.error) });
      firstError = firstError ?? machine.error;
      continue;
    }
    const produced = runtime.world.results.slice(before);
    forms.push({ ok: true, value: produced[0] ?? null, error: null });
  }
  return finish(
    runtime.world.results,
    runtime.world.output,
    steps,
    runtime.world.maxCallStack,
    firstError,
    forms,
  );
}
