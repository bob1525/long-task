import { LispError } from './error';
import { displayString, printValue } from './print';
import type { BuiltinCtx, Env, SourceSpan, Value } from './types';
import { FALSE, isProperList, NIL, TRUE, typeName, valuesEq, valuesEqual, VOID } from './value';

function arity(args: Value[], min: number, max: number | null, name: string, span: SourceSpan): void {
  const count = args.length;
  if (count < min || (max !== null && count > max)) {
    const expected = max === null ? `至少 ${min}` : min === max ? `${min}` : `${min} 到 ${max}`;
    throw new LispError('runtime', `过程 ${name} 参数个数错误：期望 ${expected} 个，实际 ${count} 个`, span);
  }
}

function expectNum(value: Value, name: string, span: SourceSpan): number {
  if (value.kind !== 'number') {
    throw new LispError('type', `${name} 的参数期望数字，实际得到的是${typeName(value)}`, span);
  }
  if (!Number.isFinite(value.value)) {
    throw new LispError('runtime', `${name} 的参数不是有限数字`, span);
  }
  return value.value;
}

function finite(value: number, name: string, span: SourceSpan): Value {
  if (!Number.isFinite(value)) {
    throw new LispError('runtime', `${name} 的结果不是有限数字`, span);
  }
  return { kind: 'number', value };
}

function compare(name: string, pred: (left: number, right: number) => boolean) {
  return (args: Value[], ctx: BuiltinCtx): Value => {
    if (args.length < 2) throw new LispError('runtime', `${name} 至少需要两个参数`, ctx.span);
    let previous = expectNum(args[0]!, name, ctx.span);
    for (let index = 1; index < args.length; index += 1) {
      const current = expectNum(args[index]!, name, ctx.span);
      if (!pred(previous, current)) return FALSE;
      previous = current;
    }
    return TRUE;
  };
}

function predicate(name: string, test: (value: Value) => boolean) {
  return (args: Value[], ctx: BuiltinCtx): Value => {
    arity(args, 1, 1, name, ctx.span);
    return test(args[0]!) ? TRUE : FALSE;
  };
}

function defineBuiltin(env: Env, name: string, fn: (args: Value[], ctx: BuiltinCtx) => Value): void {
  env.define(name, { kind: 'builtin', name, fn });
}

export function installBuiltins(env: Env): void {
  defineBuiltin(env, '+', (args, ctx) => {
    let sum = 0;
    for (const arg of args) sum += expectNum(arg, '+', ctx.span);
    return finite(sum, '+', ctx.span);
  });
  defineBuiltin(env, '*', (args, ctx) => {
    let product = 1;
    for (const arg of args) product *= expectNum(arg, '*', ctx.span);
    return finite(product, '*', ctx.span);
  });
  defineBuiltin(env, '-', (args, ctx) => {
    if (args.length === 0) throw new LispError('runtime', '- 至少需要一个参数', ctx.span);
    const first = expectNum(args[0]!, '-', ctx.span);
    if (args.length === 1) return finite(-first, '-', ctx.span);
    let acc = first;
    for (let index = 1; index < args.length; index += 1) acc -= expectNum(args[index]!, '-', ctx.span);
    return finite(acc, '-', ctx.span);
  });
  defineBuiltin(env, '/', (args, ctx) => {
    if (args.length === 0) throw new LispError('runtime', '/ 至少需要一个参数', ctx.span);
    const first = expectNum(args[0]!, '/', ctx.span);
    if (args.length === 1) {
      if (first === 0) throw new LispError('runtime', '除以零', ctx.span);
      return finite(1 / first, '/', ctx.span);
    }
    let acc = first;
    for (let index = 1; index < args.length; index += 1) {
      const divisor = expectNum(args[index]!, '/', ctx.span);
      if (divisor === 0) throw new LispError('runtime', '除以零', ctx.span);
      acc /= divisor;
    }
    return finite(acc, '/', ctx.span);
  });
  defineBuiltin(env, 'abs', (args, ctx) => {
    arity(args, 1, 1, 'abs', ctx.span);
    return finite(Math.abs(expectNum(args[0]!, 'abs', ctx.span)), 'abs', ctx.span);
  });
  defineBuiltin(env, 'modulo', (args, ctx) => {
    arity(args, 2, 2, 'modulo', ctx.span);
    const left = expectNum(args[0]!, 'modulo', ctx.span);
    const right = expectNum(args[1]!, 'modulo', ctx.span);
    if (right === 0) throw new LispError('runtime', '除以零', ctx.span);
    return finite(left - right * Math.floor(left / right), 'modulo', ctx.span);
  });
  defineBuiltin(env, 'remainder', (args, ctx) => {
    arity(args, 2, 2, 'remainder', ctx.span);
    const left = expectNum(args[0]!, 'remainder', ctx.span);
    const right = expectNum(args[1]!, 'remainder', ctx.span);
    if (right === 0) throw new LispError('runtime', '除以零', ctx.span);
    return finite(left - right * Math.trunc(left / right), 'remainder', ctx.span);
  });

  defineBuiltin(env, '=', compare('=', (left, right) => left === right));
  defineBuiltin(env, '<', compare('<', (left, right) => left < right));
  defineBuiltin(env, '>', compare('>', (left, right) => left > right));
  defineBuiltin(env, '<=', compare('<=', (left, right) => left <= right));
  defineBuiltin(env, '>=', compare('>=', (left, right) => left >= right));
  defineBuiltin(env, 'not', (args, ctx) => {
    arity(args, 1, 1, 'not', ctx.span);
    return args[0] && args[0].kind === 'boolean' && args[0].value === false ? TRUE : FALSE;
  });
  defineBuiltin(env, 'eq?', (args, ctx) => {
    arity(args, 2, 2, 'eq?', ctx.span);
    return valuesEq(args[0]!, args[1]!) ? TRUE : FALSE;
  });
  defineBuiltin(env, 'equal?', (args, ctx) => {
    arity(args, 2, 2, 'equal?', ctx.span);
    return valuesEqual(args[0]!, args[1]!) ? TRUE : FALSE;
  });

  defineBuiltin(env, 'cons', (args, ctx) => {
    arity(args, 2, 2, 'cons', ctx.span);
    return ctx.cons(args[0]!, args[1]!);
  });
  defineBuiltin(env, 'car', (args, ctx) => {
    arity(args, 1, 1, 'car', ctx.span);
    const value = args[0]!;
    if (value.kind !== 'pair') {
      throw new LispError('type', `car 期望点对，实际得到的是${typeName(value)}`, ctx.span);
    }
    return value.car;
  });
  defineBuiltin(env, 'cdr', (args, ctx) => {
    arity(args, 1, 1, 'cdr', ctx.span);
    const value = args[0]!;
    if (value.kind !== 'pair') {
      throw new LispError('type', `cdr 期望点对，实际得到的是${typeName(value)}`, ctx.span);
    }
    return value.cdr;
  });
  defineBuiltin(env, 'set-car!', (args, ctx) => {
    arity(args, 2, 2, 'set-car!', ctx.span);
    const pair = args[0]!;
    if (pair.kind !== 'pair') {
      throw new LispError('type', `set-car! 期望点对，实际得到的是${typeName(pair)}`, ctx.span);
    }
    pair.car = args[1]!;
    return VOID;
  });
  defineBuiltin(env, 'set-cdr!', (args, ctx) => {
    arity(args, 2, 2, 'set-cdr!', ctx.span);
    const pair = args[0]!;
    if (pair.kind !== 'pair') {
      throw new LispError('type', `set-cdr! 期望点对，实际得到的是${typeName(pair)}`, ctx.span);
    }
    pair.cdr = args[1]!;
    return VOID;
  });
  defineBuiltin(env, 'list', (args, ctx) => {
    let node: Value = NIL;
    for (let index = args.length - 1; index >= 0; index -= 1) node = ctx.cons(args[index]!, node);
    return node;
  });
  defineBuiltin(env, 'length', (args, ctx) => {
    arity(args, 1, 1, 'length', ctx.span);
    let count = 0;
    const seen = new Set<number>();
    let current = args[0]!;
    while (current.kind === 'pair') {
      if (seen.has(current.id)) throw new LispError('runtime', 'length 遇到循环列表', ctx.span);
      seen.add(current.id);
      count += 1;
      current = current.cdr;
    }
    if (current.kind !== 'nil') {
      throw new LispError('type', `length 期望真列表，实际得到的是${typeName(current)}`, ctx.span);
    }
    return { kind: 'number', value: count };
  });
  defineBuiltin(env, 'append', (args, ctx) => {
    if (args.length === 0) return NIL;
    let result = args[args.length - 1]!;
    for (let index = args.length - 2; index >= 0; index -= 1) {
      const cells: Value[] = [];
      const seen = new Set<number>();
      let current = args[index]!;
      while (current.kind === 'pair') {
        if (seen.has(current.id)) throw new LispError('runtime', 'append 遇到循环列表', ctx.span);
        seen.add(current.id);
        cells.push(current.car);
        current = current.cdr;
      }
      if (current.kind !== 'nil') {
        throw new LispError('type', `append 的非末尾参数必须是真列表，实际得到的是${typeName(current)}`, ctx.span);
      }
      for (let cell = cells.length - 1; cell >= 0; cell -= 1) result = ctx.cons(cells[cell]!, result);
    }
    return result;
  });

  defineBuiltin(env, 'null?', predicate('null?', (value) => value.kind === 'nil'));
  defineBuiltin(env, 'pair?', predicate('pair?', (value) => value.kind === 'pair'));
  defineBuiltin(env, 'list?', predicate('list?', (value) => isProperList(value)));
  defineBuiltin(env, 'number?', predicate('number?', (value) => value.kind === 'number'));
  defineBuiltin(env, 'boolean?', predicate('boolean?', (value) => value.kind === 'boolean'));
  defineBuiltin(env, 'string?', predicate('string?', (value) => value.kind === 'string'));
  defineBuiltin(env, 'symbol?', predicate('symbol?', (value) => value.kind === 'symbol'));
  defineBuiltin(
    env,
    'procedure?',
    predicate('procedure?', (value) => value.kind === 'procedure' || value.kind === 'builtin'),
  );

  defineBuiltin(env, 'display', (args, ctx) => {
    arity(args, 1, 1, 'display', ctx.span);
    ctx.output.push(displayString(args[0]!));
    return VOID;
  });
  defineBuiltin(env, 'write', (args, ctx) => {
    arity(args, 1, 1, 'write', ctx.span);
    ctx.output.push(printValue(args[0]!));
    return VOID;
  });
  defineBuiltin(env, 'newline', (args, ctx) => {
    arity(args, 0, 0, 'newline', ctx.span);
    ctx.output.push('\n');
    return VOID;
  });
}
