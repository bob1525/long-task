import { envChain } from './env';
import { asLispError, LispError, serializeError } from './error';
import { MAX_CALL_STACK } from './limits';
import { parseParamList, toProperList } from './params';
import { buildTranscript, previewValue, printSExpr, printValue } from './print';
import type { Env, Snapshot, SourceSpan, SExpr, Value, World } from './types';
import { FALSE, isProperList, isTruthy, NIL, TRUE, typeName, VOID } from './value';
import { consPair, type Runtime } from './world';

const SPECIAL = new Set([
  'define',
  'lambda',
  'if',
  'cond',
  'let',
  'let*',
  'begin',
  'quote',
  'quasiquote',
  'unquote',
  'unquote-splicing',
  'set!',
  'and',
  'or',
  'do',
]);

const DO_LOOP = 'do-loop';

interface LetState {
  star: boolean;
  name: string;
  pending: Array<{ name: string; init: SExpr }>;
  ready: Array<{ name: string; value: Value }>;
  body: SExpr[];
  env: Env;
  base: Env;
  tail: boolean;
  span: SourceSpan;
  loopProc: Value | null;
}

type QQFrame =
  | { kind: 'wrap'; name: 'quasiquote' | 'unquote' | 'unquote-splicing' }
  | { kind: 'car'; cdr: SExpr; level: number }
  | { kind: 'cdr'; car: Value }
  | { kind: 'splice'; cdr: SExpr; level: number; span: SourceSpan }
  | { kind: 'splice-tail'; head: Value; span: SourceSpan };

function symNode(name: string, span: SourceSpan): SExpr {
  return { t: 'sym', v: name, span };
}

function boolNode(value: boolean, span: SourceSpan): SExpr {
  return { t: 'bool', v: value, span };
}

function numNode(value: number, span: SourceSpan): SExpr {
  return { t: 'num', v: value, span };
}

function listNode(items: SExpr[], span: SourceSpan): SExpr {
  let node: SExpr = { t: 'nil', span };
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const car = items[index];
    if (!car) continue;
    node = { t: 'pair', car, cdr: node, span };
  }
  return node;
}

type Kont =
  | { tag: 'halt' }
  | { tag: 'toplevel'; rest: SExpr[]; env: Env }
  | { tag: 'seq'; rest: SExpr[]; env: Env; tail: boolean; span: SourceSpan; next: Kont }
  | { tag: 'def'; name: string; env: Env; span: SourceSpan; next: Kont }
  | { tag: 'set'; name: string; env: Env; span: SourceSpan; next: Kont }
  | { tag: 'if'; thenExpr: SExpr; elseExpr: SExpr | null; env: Env; tail: boolean; span: SourceSpan; next: Kont }
  | { tag: 'op'; args: SExpr[]; env: Env; tail: boolean; span: SourceSpan; next: Kont }
  | { tag: 'args'; op: Value; done: Value[]; todo: SExpr[]; env: Env; tail: boolean; span: SourceSpan; next: Kont }
  | { tag: 'cond'; body: SExpr[]; rest: SExpr[]; env: Env; tail: boolean; span: SourceSpan; next: Kont }
  | { tag: 'let'; state: LetState; next: Kont }
  | { tag: 'and'; rest: SExpr[]; env: Env; tail: boolean; span: SourceSpan; next: Kont }
  | { tag: 'or'; rest: SExpr[]; env: Env; tail: boolean; span: SourceSpan; next: Kont }
  | { tag: 'qq'; env: Env; stack: QQFrame[]; next: Kont }
  | { tag: 'pop'; next: Kont };

type Control =
  | { tag: 'eval'; expr: SExpr; env: Env; tail: boolean }
  | { tag: 'value'; value: Value }
  | { tag: 'done'; value: Value }
  | { tag: 'error'; error: LispError };

interface CallFrame {
  name: string;
  args: string;
  env: Env;
  span: SourceSpan;
}

function formatArgs(params: string[], rest: string | null, args: Value[]): string {
  const parts = params.map((name, index) => `${name} = ${previewValue(args[index] ?? VOID)}`);
  if (rest !== null) {
    const restValues = args.slice(params.length).map((value) => previewValue(value));
    parts.push(`${rest} = (${restValues.join(' ')})`);
  }
  return parts.join(', ');
}

export class Machine {
  readonly world: World;
  readonly globalEnv: Env;
  readonly trace: boolean;
  steps = 0;
  maxCallStack = 0;
  action = '准备执行';
  currentSpan: SourceSpan | null = null;
  currentEnv: Env;
  private control: Control;
  private kont: Kont = { tag: 'halt' };
  private readonly callStack: CallFrame[] = [];

  constructor(forms: SExpr[], runtime: Runtime, trace: boolean) {
    this.world = runtime.world;
    this.globalEnv = runtime.globalEnv;
    this.currentEnv = runtime.globalEnv;
    this.trace = trace;
    if (forms.length === 0) {
      this.control = { tag: 'done', value: VOID };
      this.action = '空程序';
      return;
    }
    const first = forms[0];
    if (!first) {
      this.control = { tag: 'done', value: VOID };
      this.action = '空程序';
      return;
    }
    this.currentSpan = first.span;
    this.control = {
      tag: 'eval',
      expr: first,
      env: runtime.globalEnv,
      tail: forms.length === 1,
    };
    this.kont = { tag: 'toplevel', rest: forms.slice(1), env: runtime.globalEnv };
  }

  isFinished(): boolean {
    return this.control.tag === 'done' || this.control.tag === 'error';
  }

  get error(): LispError | null {
    return this.control.tag === 'error' ? this.control.error : null;
  }

  forceError(error: LispError): void {
    this.control = { tag: 'error', error };
    this.action = '已停止';
    if (error.span) this.currentSpan = error.span;
  }

  step(): void {
    if (this.isFinished()) return;
    this.steps += 1;
    try {
      if (this.control.tag === 'eval') {
        this.evalExpr(this.control.expr, this.control.env, this.control.tail);
      } else if (this.control.tag === 'value') {
        this.continueWith(this.control.value);
      }
    } catch (error) {
      this.fail(error);
    }
  }

  run(maxSteps: number): void {
    while (!this.isFinished()) {
      if (this.steps >= maxSteps) {
        this.control = {
          tag: 'error',
          error: new LispError(
            'runtime',
            `超过最大求值步数 ${maxSteps}，已停止（可能存在无限循环）`,
            this.currentSpan,
          ),
        };
        this.action = '超过最大步数';
        return;
      }
      this.step();
    }
  }

  private liveEnvironments(): Env[] {
    const envs = new Map<number, Env>();
    const envQueue: Env[] = [];
    const values: Value[] = [];
    const seenPairs = new Set<number>();
    const seenProcs = new Set<number>();

    const pushEnv = (env: Env | null): void => {
      let current = env;
      while (current && !envs.has(current.id)) {
        envs.set(current.id, current);
        envQueue.push(current);
        current = current.parent;
      }
    };

    pushEnv(this.currentEnv);
    for (const frame of this.callStack) pushEnv(frame.env);

    while (envQueue.length > 0 || values.length > 0) {
      while (values.length > 0) {
        const value = values.pop();
        if (!value) break;
        if (value.kind === 'pair') {
          if (seenPairs.has(value.id)) continue;
          seenPairs.add(value.id);
          values.push(value.car, value.cdr);
          continue;
        }
        if (value.kind === 'procedure') {
          if (seenProcs.has(value.id)) continue;
          seenProcs.add(value.id);
          pushEnv(value.env);
        }
      }
      const env = envQueue.pop();
      if (!env) continue;
      for (const [, value] of env.entries()) values.push(value);
    }
    return [...envs.values()];
  }

  toSnapshot(): Snapshot {
    const error = this.error;
    const status = error ? 'error' : this.control.tag === 'done' ? 'done' : this.steps === 0 ? 'ready' : 'running';
    let currentExpr: string | null = null;
    let valuePreview: string | null = null;
    if (this.control.tag === 'eval') currentExpr = printSExpr(this.control.expr);
    else if (this.control.tag === 'value' && this.control.value.kind !== 'void') {
      valuePreview = previewValue(this.control.value, 160);
    } else if (this.control.tag === 'done' && this.control.value.kind !== 'void') {
      valuePreview = previewValue(this.control.value, 160);
    }

    const liveEnvs = this.liveEnvironments();

    const output = this.world.output.join('');
    const results = this.world.results.slice();
    const chain = envChain(this.currentEnv);
    return {
      step: this.steps,
      status,
      action: this.action,
      currentExpr,
      currentSpan: error?.span ?? this.currentSpan,
      valuePreview,
      callStack: this.callStack.map((frame) => ({
        name: frame.name,
        args: frame.args,
        envId: frame.env.id,
        span: frame.span,
      })),
      frames: liveEnvs.map((env) => ({
        id: env.id,
        label: env.label,
        parentId: env.parent?.id ?? null,
        bindings: env.entries().map(([name, value]) => ({
          name,
          value: previewValue(value),
          capturedEnvId: value.kind === 'procedure' ? value.env.id : null,
        })),
      })),
      activeEnvId: this.currentEnv.id,
      output,
      results,
      transcript: buildTranscript(output, results),
      memory: {
        pairs: this.world.pairs,
        environments: this.world.envCount,
        stackDepth: this.callStack.length,
        maxStackDepth: Math.max(this.maxCallStack, this.world.maxCallStack),
        chainDepth: chain.length,
        steps: this.steps,
      },
      error: error ? serializeError(error) : null,
    };
  }

  private fail(error: unknown): void {
    const lisp = asLispError(error, this.currentSpan);
    this.control = { tag: 'error', error: lisp };
    this.action = '错误';
    if (lisp.span) this.currentSpan = lisp.span;
  }

  private noteStack(): void {
    if (this.callStack.length > this.maxCallStack) this.maxCallStack = this.callStack.length;
    if (this.callStack.length > this.world.maxCallStack) this.world.maxCallStack = this.callStack.length;
  }

  private cons(car: Value, cdr: Value): Value {
    return consPair(this.world, car, cdr);
  }

  private listFrom(values: Value[]): Value {
    let node: Value = NIL;
    for (let index = values.length - 1; index >= 0; index -= 1) {
      const value = values[index];
      if (value) node = this.cons(value, node);
    }
    return node;
  }

  private makeProcedure(
    name: string | null,
    params: string[],
    rest: string | null,
    body: SExpr[],
    env: Env,
    span: SourceSpan,
  ): Value {
    const id = this.world.nextProcId;
    this.world.nextProcId += 1;
    return { kind: 'procedure', id, name, params, rest, body, env, span };
  }

  private datum(expr: SExpr, memo: Map<SExpr, Value>): Value {
    switch (expr.t) {
      case 'num':
        return { kind: 'number', value: expr.v };
      case 'bool':
        return { kind: 'boolean', value: expr.v };
      case 'str':
        return { kind: 'string', value: expr.v };
      case 'sym':
        return { kind: 'symbol', name: expr.v };
      case 'nil':
        return NIL;
      case 'pair': {
        const value = memo.get(expr);
        if (!value) throw new LispError('runtime', '内部错误：引用转换失败', expr.span);
        return value;
      }
      default: {
        const neverExpr: never = expr;
        throw new LispError('runtime', `内部错误 ${String(neverExpr)}`, null);
      }
    }
  }

  private sexprToValue(root: SExpr): Value {
    const memo = new Map<SExpr, Value>();
    const stack: SExpr[] = [root];
    const visiting = new Set<SExpr>();
    while (stack.length > 0) {
      const expr = stack[stack.length - 1];
      if (!expr) break;
      if (expr.t !== 'pair' || memo.has(expr)) {
        stack.pop();
        continue;
      }
      if (!visiting.has(expr)) {
        visiting.add(expr);
        stack.push(expr.cdr, expr.car);
        continue;
      }
      visiting.delete(expr);
      stack.pop();
      memo.set(expr, this.cons(this.datum(expr.car, memo), this.datum(expr.cdr, memo)));
    }
    return this.datum(root, memo);
  }

  private beginSequence(exprs: SExpr[], env: Env, tail: boolean, span: SourceSpan): void {
    if (exprs.length === 0) throw new LispError('syntax', '函数体不能为空', span);
    const first = exprs[0];
    if (!first) throw new LispError('syntax', '函数体不能为空', span);
    this.currentEnv = env;
    this.currentSpan = first.span;
    if (exprs.length === 1) {
      this.control = { tag: 'eval', expr: first, env, tail };
      return;
    }
    this.control = { tag: 'eval', expr: first, env, tail: false };
    this.kont = { tag: 'seq', rest: exprs.slice(1), env, tail, span, next: this.kont };
  }

  private evalExpr(expr: SExpr, env: Env, tail: boolean): void {
    this.currentEnv = env;
    this.currentSpan = expr.span;
    switch (expr.t) {
      case 'num':
        this.action = `字面量 ${expr.v}`;
        this.control = { tag: 'value', value: { kind: 'number', value: expr.v } };
        return;
      case 'bool':
        this.action = `字面量 ${expr.v ? '#t' : '#f'}`;
        this.control = { tag: 'value', value: expr.v ? { kind: 'boolean', value: true } : { kind: 'boolean', value: false } };
        return;
      case 'str':
        this.action = '字面量字符串';
        this.control = { tag: 'value', value: { kind: 'string', value: expr.v } };
        return;
      case 'nil':
        throw new LispError('syntax', '空列表不能作为表达式求值', expr.span);
      case 'sym': {
        this.action = `查找变量 ${expr.v}`;
        const found = env.lookup(expr.v);
        if (!found) throw new LispError('undefined', `变量 ${expr.v} 未定义`, expr.span);
        this.control = { tag: 'value', value: found };
        return;
      }
      case 'pair':
        this.evalCombination(expr, env, tail);
        return;
      default: {
        const neverExpr: never = expr;
        throw new LispError('runtime', `无法求值 ${String(neverExpr)}`, null);
      }
    }
  }

  private evalCombination(expr: SExpr, env: Env, tail: boolean): void {
    const items = toProperList(expr);
    if (!items || items.length === 0) {
      throw new LispError('syntax', items ? '空列表不能作为表达式求值' : '组合表达式必须是真列表', expr.span);
    }
    const head = items[0];
    if (!head) throw new LispError('syntax', '组合表达式必须是真列表', expr.span);
    if (head.t === 'sym' && SPECIAL.has(head.v)) {
      this.evalSpecial(head.v, items, expr.span, env, tail);
      return;
    }
    this.action = '求值运算符';
    this.currentSpan = head.span;
    this.control = { tag: 'eval', expr: head, env, tail: false };
    this.kont = { tag: 'op', args: items.slice(1), env, tail, span: expr.span, next: this.kont };
  }

  private evalSpecial(name: string, items: SExpr[], span: SourceSpan, env: Env, tail: boolean): void {
    switch (name) {
      case 'define':
        this.evalDefine(items, span, env);
        return;
      case 'lambda':
        this.evalLambda(items, span, env);
        return;
      case 'if':
        this.evalIf(items, span, env, tail);
        return;
      case 'cond':
        this.action = '进入 cond';
        this.startCond(items.slice(1), env, tail, span);
        return;
      case 'let':
        this.evalLet(items, span, env, tail, false);
        return;
      case 'let*':
        this.evalLet(items, span, env, tail, true);
        return;
      case 'begin':
        if (items.length < 2) throw new LispError('syntax', 'begin 至少需要一个表达式', span);
        this.action = '进入 begin';
        this.beginSequence(items.slice(1), env, tail, span);
        return;
      case 'quote':
        if (items.length !== 2) throw new LispError('syntax', 'quote 需要且只需要一个参数', span);
        this.action = '引用，不求值';
        this.control = { tag: 'value', value: this.sexprToValue(items[1]!) };
        return;
      case 'quasiquote': {
        if (items.length !== 2) throw new LispError('syntax', 'quasiquote 需要且只需要一个参数', span);
        const template = items[1];
        if (!template) throw new LispError('syntax', 'quasiquote 需要且只需要一个参数', span);
        this.action = '展开准引用';
        this.kont = { tag: 'qq', env, stack: [], next: this.kont };
        this.driveQQ(template, 1);
        return;
      }
      case 'unquote':
      case 'unquote-splicing':
        throw new LispError('syntax', `${name} 出现在准引用之外`, span);
      case 'and':
        this.evalAndOr('and', items.slice(1), span, env, tail);
        return;
      case 'or':
        this.evalAndOr('or', items.slice(1), span, env, tail);
        return;
      case 'do':
        this.evalDo(items, span, env, tail);
        return;
      case 'set!':
        this.evalSet(items, span, env);
        return;
      default:
        throw new LispError('syntax', `未实现的特殊形式 ${name}`, span);
    }
  }

  private evalDefine(items: SExpr[], span: SourceSpan, env: Env): void {
    if (items.length < 3) throw new LispError('syntax', 'define 形式不完整', span);
    const head = items[1];
    if (!head) throw new LispError('syntax', 'define 形式不完整', span);
    if (head.t === 'sym') {
      if (items.length !== 3) throw new LispError('syntax', 'define 变量只能绑定一个表达式', span);
      this.action = `求值 ${head.v} 的初始值`;
      this.currentSpan = items[2]?.span ?? span;
      this.control = { tag: 'eval', expr: items[2]!, env, tail: false };
      this.kont = { tag: 'def', name: head.v, env, span, next: this.kont };
      return;
    }
    if (head.t !== 'pair') throw new LispError('syntax', 'define 的绑定目标无效', head.span);
    if (head.car.t !== 'sym') throw new LispError('syntax', 'define 的过程名必须是符号', head.car.span);
    const name = head.car.v;
    const { params, rest } = parseParamList(head.cdr);
    const body = items.slice(2);
    if (body.length === 0) throw new LispError('syntax', `过程 ${name} 缺少函数体`, span);
    const proc = this.makeProcedure(name, params, rest, body, env, span);
    env.define(name, proc);
    this.action = `定义过程 ${name}`;
    this.control = { tag: 'value', value: VOID };
  }

  private evalLambda(items: SExpr[], span: SourceSpan, env: Env): void {
    if (items.length < 3) throw new LispError('syntax', 'lambda 缺少参数列表或函数体', span);
    const paramsExpr = items[1];
    if (!paramsExpr) throw new LispError('syntax', 'lambda 缺少参数列表', span);
    const { params, rest } = parseParamList(paramsExpr);
    const body = items.slice(2);
    if (body.length === 0) throw new LispError('syntax', 'lambda 缺少函数体', span);
    this.action = '创建过程';
    this.control = { tag: 'value', value: this.makeProcedure(null, params, rest, body, env, span) };
  }

  private evalIf(items: SExpr[], span: SourceSpan, env: Env, tail: boolean): void {
    if (items.length !== 3 && items.length !== 4) {
      throw new LispError('syntax', 'if 的形式必须是 (if 测试 然后) 或 (if 测试 然后 否则)', span);
    }
    const test = items[1];
    const thenExpr = items[2];
    if (!test || !thenExpr) throw new LispError('syntax', 'if 形式不完整', span);
    this.action = '求值 if 的测试表达式';
    this.currentSpan = test.span;
    this.control = { tag: 'eval', expr: test, env, tail: false };
    this.kont = {
      tag: 'if',
      thenExpr,
      elseExpr: items[3] ?? null,
      env,
      tail,
      span,
      next: this.kont,
    };
  }

  private evalSet(items: SExpr[], span: SourceSpan, env: Env): void {
    if (items.length !== 3) throw new LispError('syntax', 'set! 的形式必须是 (set! 变量 表达式)', span);
    const nameExpr = items[1];
    const valueExpr = items[2];
    if (!nameExpr || !valueExpr) throw new LispError('syntax', 'set! 形式不完整', span);
    if (nameExpr.t !== 'sym') throw new LispError('syntax', 'set! 的变量必须是符号', nameExpr.span);
    if (!env.lookup(nameExpr.v)) {
      throw new LispError('undefined', `变量 ${nameExpr.v} 未定义，不能赋值`, nameExpr.span);
    }
    this.action = `求值 set! ${nameExpr.v} 的新值`;
    this.currentSpan = valueExpr.span;
    this.control = { tag: 'eval', expr: valueExpr, env, tail: false };
    this.kont = { tag: 'set', name: nameExpr.v, env, span, next: this.kont };
  }

  private evalLet(items: SExpr[], span: SourceSpan, env: Env, tail: boolean, star: boolean): void {
    const label = star ? 'let*' : 'let';
    if (items.length < 3) throw new LispError('syntax', `${label} 形式不完整`, span);
    let bindingExpr = items[1];
    let body = items.slice(2);
    let loopName: string | null = null;
    if (!bindingExpr) throw new LispError('syntax', `${label} 缺少绑定列表`, span);
    if (bindingExpr.t === 'sym') {
      if (star) throw new LispError('syntax', '不支持命名 let*', bindingExpr.span);
      if (items.length < 4) throw new LispError('syntax', '命名 let 形式不完整', span);
      loopName = bindingExpr.v;
      bindingExpr = items[2] ?? null;
      body = items.slice(3);
      if (!bindingExpr) throw new LispError('syntax', '命名 let 缺少绑定列表', span);
    }
    const bindings = toProperList(bindingExpr);
    if (!bindings) throw new LispError('syntax', '绑定列表必须是真列表', bindingExpr.span);
    const parsed: Array<{ name: string; init: SExpr }> = [];
    const names = new Set<string>();
    for (const binding of bindings) {
      const pair = toProperList(binding);
      if (!pair || pair.length !== 2) throw new LispError('syntax', '绑定必须是 (变量 表达式)', binding.span);
      const nameExpr = pair[0];
      const init = pair[1];
      if (!nameExpr || !init) throw new LispError('syntax', '绑定必须是 (变量 表达式)', binding.span);
      if (nameExpr.t !== 'sym') throw new LispError('syntax', '绑定的变量必须是符号', nameExpr.span);
      if (!star) {
        if (names.has(nameExpr.v)) throw new LispError('syntax', `let 中变量 ${nameExpr.v} 重复绑定`, nameExpr.span);
        names.add(nameExpr.v);
      }
      parsed.push({ name: nameExpr.v, init });
    }
    if (body.length === 0) throw new LispError('syntax', `${label} 缺少函数体`, span);
    let loopProc: Value | null = null;
    if (loopName) {
      const loopEnv = env.extend(loopName);
      loopProc = this.makeProcedure(
        loopName,
        parsed.map((binding) => binding.name),
        null,
        body,
        loopEnv,
        span,
      );
      loopEnv.define(loopName, loopProc);
    }
    const extended = star ? env.extend(label) : null;
    if (parsed.length === 0) {
      if (loopProc) {
        this.action = `调用命名 let ${loopName ?? ''}`;
        this.apply(loopProc, [], tail, span, this.kont);
        return;
      }
      const bodyEnv = extended ?? env.extend(label);
      this.action = `${label} 没有绑定，求值函数体`;
      this.beginSequence(body, bodyEnv, tail, span);
      return;
    }
    const first = parsed[0];
    if (!first) throw new LispError('syntax', `${label} 缺少绑定`, span);
    const initEnv = extended ?? env;
    this.action = `求值绑定 ${first.name}`;
    this.currentEnv = initEnv;
    this.currentSpan = first.init.span;
    this.control = { tag: 'eval', expr: first.init, env: initEnv, tail: false };
    this.kont = {
      tag: 'let',
      state: {
        star,
        name: first.name,
        pending: parsed.slice(1),
        ready: [],
        body,
        env: initEnv,
        base: env,
        tail,
        span,
        loopProc,
      },
      next: this.kont,
    };
  }

  private startCond(clauses: SExpr[], env: Env, tail: boolean, span: SourceSpan): void {
    if (clauses.length === 0) {
      this.action = 'cond 没有任何子句成立';
      this.control = { tag: 'value', value: VOID };
      return;
    }
    const clauseExpr = clauses[0];
    if (!clauseExpr) {
      this.control = { tag: 'value', value: VOID };
      return;
    }
    const clause = toProperList(clauseExpr);
    if (!clause || clause.length === 0) {
      throw new LispError('syntax', 'cond 子句必须是非空列表', clauseExpr.span);
    }
    const test = clause[0];
    if (!test) throw new LispError('syntax', 'cond 子句必须是非空列表', clauseExpr.span);
    if (test.t === 'sym' && test.v === 'else') {
      if (clauses.length !== 1) throw new LispError('syntax', 'else 必须是最后一个 cond 子句', test.span);
      if (clause.length < 2) throw new LispError('syntax', 'else 子句缺少表达式', clauseExpr.span);
      this.action = '进入 cond 的 else 子句';
      this.beginSequence(clause.slice(1), env, tail, clauseExpr.span);
      return;
    }
    this.action = '求值 cond 测试表达式';
    this.currentEnv = env;
    this.currentSpan = test.span;
    this.control = { tag: 'eval', expr: test, env, tail: false };
    this.kont = {
      tag: 'cond',
      body: clause.slice(1),
      rest: clauses.slice(1),
      env,
      tail,
      span,
      next: this.kont,
    };
  }

  private continueWith(value: Value): void {
    const kont = this.kont;
    switch (kont.tag) {
      case 'halt':
        this.action = '程序结束';
        this.control = { tag: 'done', value };
        return;
      case 'toplevel': {
        if (value.kind !== 'void') this.world.results.push(printValue(value));
        if (kont.rest.length === 0) {
          this.action = value.kind === 'void' ? '程序结束' : `得到结果 ${previewValue(value, 120)}`;
          this.control = { tag: 'done', value };
          return;
        }
        const next = kont.rest[0];
        if (!next) {
          this.control = { tag: 'done', value };
          return;
        }
        const rest = kont.rest.slice(1);
        this.action = '求值下一条顶层表达式';
        this.currentEnv = kont.env;
        this.currentSpan = next.span;
        this.control = { tag: 'eval', expr: next, env: kont.env, tail: rest.length === 0 };
        this.kont = { tag: 'toplevel', rest, env: kont.env };
        return;
      }
      case 'seq': {
        const next = kont.rest[0];
        if (!next) {
          this.kont = kont.next;
          this.control = { tag: 'value', value };
          return;
        }
        const rest = kont.rest.slice(1);
        this.action = '继续求值序列中的下一个表达式';
        this.currentEnv = kont.env;
        this.currentSpan = next.span;
        if (rest.length === 0) {
          this.control = { tag: 'eval', expr: next, env: kont.env, tail: kont.tail };
          this.kont = kont.next;
          return;
        }
        this.control = { tag: 'eval', expr: next, env: kont.env, tail: false };
        this.kont = { ...kont, rest };
        return;
      }
      case 'def':
        if (value.kind === 'procedure' && value.name === null) value.name = kont.name;
        kont.env.define(kont.name, value);
        this.action = `定义 ${kont.name}`;
        this.kont = kont.next;
        this.control = { tag: 'value', value: VOID };
        return;
      case 'set':
        if (!kont.env.assign(kont.name, value)) {
          throw new LispError('undefined', `变量 ${kont.name} 未定义，不能赋值`, kont.span);
        }
        this.action = `赋值 ${kont.name}`;
        this.kont = kont.next;
        this.control = { tag: 'value', value: VOID };
        return;
      case 'if': {
        const branch = isTruthy(value) ? kont.thenExpr : kont.elseExpr;
        this.action = isTruthy(value) ? 'if 测试为真，进入 then' : 'if 测试为假，进入 else';
        if (!branch) {
          this.kont = kont.next;
          this.control = { tag: 'value', value: VOID };
          return;
        }
        this.currentEnv = kont.env;
        this.currentSpan = branch.span;
        this.control = { tag: 'eval', expr: branch, env: kont.env, tail: kont.tail };
        this.kont = kont.next;
        return;
      }
      case 'op': {
        if (kont.args.length === 0) {
          this.apply(value, [], kont.tail, kont.span, kont.next);
          return;
        }
        const first = kont.args[0];
        if (!first) {
          this.apply(value, [], kont.tail, kont.span, kont.next);
          return;
        }
        this.action = '求值参数';
        this.currentEnv = kont.env;
        this.currentSpan = first.span;
        this.control = { tag: 'eval', expr: first, env: kont.env, tail: false };
        this.kont = {
          tag: 'args',
          op: value,
          done: [],
          todo: kont.args.slice(1),
          env: kont.env,
          tail: kont.tail,
          span: kont.span,
          next: kont.next,
        };
        return;
      }
      case 'args': {
        const done = [...kont.done, value];
        if (kont.todo.length === 0) {
          this.apply(kont.op, done, kont.tail, kont.span, kont.next);
          return;
        }
        const first = kont.todo[0];
        if (!first) {
          this.apply(kont.op, done, kont.tail, kont.span, kont.next);
          return;
        }
        this.action = '求值参数';
        this.currentEnv = kont.env;
        this.currentSpan = first.span;
        this.control = { tag: 'eval', expr: first, env: kont.env, tail: false };
        this.kont = { ...kont, done, todo: kont.todo.slice(1) };
        return;
      }
      case 'cond':
        if (isTruthy(value)) {
          this.kont = kont.next;
          if (kont.body.length === 0) {
            this.action = 'cond 测试为真，返回测试值';
            this.control = { tag: 'value', value };
            return;
          }
          this.action = 'cond 子句成立，求值子句体';
          this.beginSequence(kont.body, kont.env, kont.tail, kont.span);
          return;
        }
        this.action = 'cond 子句不成立';
        this.kont = kont.next;
        this.startCond(kont.rest, kont.env, kont.tail, kont.span);
        return;
      case 'let': {
        const state = kont.state;
        if (state.star) state.env.define(state.name, value);
        const ready = state.star ? state.ready : [...state.ready, { name: state.name, value }];
        const pending = state.pending[0];
        if (pending) {
          const initEnv = state.star ? state.env : state.base;
          this.action = `求值绑定 ${pending.name}`;
          this.currentEnv = initEnv;
          this.currentSpan = pending.init.span;
          this.control = { tag: 'eval', expr: pending.init, env: initEnv, tail: false };
          this.kont = {
            tag: 'let',
            state: { ...state, name: pending.name, pending: state.pending.slice(1), ready },
            next: kont.next,
          };
          return;
        }
        if (!state.star && state.loopProc) {
          const args = ready.map((binding) => binding.value);
          this.action = `调用命名 let ${state.loopProc.kind === 'procedure' ? state.loopProc.name ?? '' : ''}`;
          this.apply(state.loopProc, args, state.tail, state.span, kont.next);
          return;
        }
        const bodyEnv = state.star ? state.env : state.base.extend('let');
        if (!state.star) {
          for (const binding of ready) bodyEnv.define(binding.name, binding.value);
        }
        this.action = state.star ? 'let* 绑定完成，求值函数体' : 'let 绑定完成，求值函数体';
        this.kont = kont.next;
        this.beginSequence(state.body, bodyEnv, state.tail, state.span);
        return;
      }
      case 'and':
        if (!isTruthy(value)) {
          this.kont = kont.next;
          this.action = 'and 遇到假值，短路';
          this.control = { tag: 'value', value };
          return;
        }
        this.kont = kont.next;
        this.evalAndOr('and', kont.rest, kont.span, kont.env, kont.tail);
        return;
      case 'or':
        if (isTruthy(value)) {
          this.kont = kont.next;
          this.action = 'or 遇到真值，短路';
          this.control = { tag: 'value', value };
          return;
        }
        this.kont = kont.next;
        this.evalAndOr('or', kont.rest, kont.span, kont.env, kont.tail);
        return;
      case 'qq':
        this.continueQQ(kont, value);
        return;
      case 'pop':
        this.callStack.pop();
        this.action = '过程返回';
        this.kont = kont.next;
        this.control = { tag: 'value', value };
        this.currentEnv = this.callStack[this.callStack.length - 1]?.env ?? this.globalEnv;
        return;
      default: {
        const neverKont: never = kont;
        throw new LispError('runtime', `内部错误：未知续延 ${String(neverKont)}`, this.currentSpan);
      }
    }
  }

  private apply(op: Value, args: Value[], tail: boolean, span: SourceSpan, next: Kont): void {
    this.currentSpan = span;
    if (op.kind === 'builtin' && op.name === 'apply') {
      this.applyApply(args, tail, span, next);
      return;
    }
    if (op.kind === 'builtin') {
      this.action = `调用内置过程 ${op.name}`;
      const result = op.fn(args, {
        span,
        cons: (car, cdr) => this.cons(car, cdr),
        output: this.world.output,
      });
      this.kont = next;
      this.control = { tag: 'value', value: result };
      return;
    }
    if (op.kind !== 'procedure') {
      throw new LispError('type', `尝试调用非过程值，实际得到的是${typeName(op)}`, span);
    }
    const expected = op.params.length;
    if (op.rest === null) {
      if (args.length !== expected) {
        throw new LispError(
          'runtime',
          `过程 ${op.name ?? 'λ'} 期望 ${expected} 个参数，实际得到 ${args.length} 个`,
          span,
        );
      }
    } else if (args.length < expected) {
      throw new LispError(
        'runtime',
        `过程 ${op.name ?? 'λ'} 期望至少 ${expected} 个参数，实际得到 ${args.length} 个`,
        span,
      );
    }
    const env = op.env.extend(op.name ?? 'λ');
    op.params.forEach((name, index) => {
      const arg = args[index];
      if (arg) env.define(name, arg);
    });
    if (op.rest !== null) env.define(op.rest, this.listFrom(args.slice(expected)));
    const frame: CallFrame = {
      name: op.name ?? 'λ',
      args: this.trace ? formatArgs(op.params, op.rest, args) : '',
      env,
      span,
    };
    if (tail && this.callStack.length > 0) {
      this.callStack[this.callStack.length - 1] = frame;
      this.action = `尾调用 ${frame.name}`;
      this.kont = next;
    } else {
      if (this.callStack.length >= MAX_CALL_STACK) {
        throw new LispError(
          'runtime',
          `非尾调用栈深度超过上限 ${MAX_CALL_STACK}，已停止`,
          span,
        );
      }
      this.callStack.push(frame);
      this.action = `调用 ${frame.name}`;
      this.kont = { tag: 'pop', next };
    }
    this.noteStack();
    this.currentEnv = env;
    this.beginSequence(op.body, env, true, op.span);
  }

  private applyApply(args: Value[], tail: boolean, span: SourceSpan, next: Kont): void {
    if (args.length < 2) {
      throw new LispError('runtime', `过程 apply 参数个数错误：期望至少 2 个，实际 ${args.length} 个`, span);
    }
    const proc = args[0];
    if (!proc || (proc.kind !== 'procedure' && proc.kind !== 'builtin')) {
      throw new LispError('type', `apply 的第一个参数必须是过程，实际得到的是${typeName(proc ?? NIL)}`, span);
    }
    const last = args[args.length - 1];
    if (!last || !isProperList(last)) {
      throw new LispError('runtime', 'apply 的最后一个参数必须是真列表', span);
    }
    const spread: Value[] = [];
    const seen = new Set<number>();
    let current = last;
    while (current.kind === 'pair') {
      if (seen.has(current.id)) throw new LispError('runtime', 'apply 遇到循环列表', span);
      seen.add(current.id);
      spread.push(current.car);
      current = current.cdr;
    }
    this.action = '展开 apply';
    this.apply(proc, [...args.slice(1, -1), ...spread], tail, span, next);
  }

  private evalAndOr(name: 'and' | 'or', exprs: SExpr[], span: SourceSpan, env: Env, tail: boolean): void {
    if (exprs.length === 0) {
      this.action = name === 'and' ? 'and 没有参数，结果为真' : 'or 没有参数，结果为假';
      this.control = { tag: 'value', value: name === 'and' ? TRUE : FALSE };
      return;
    }
    const first = exprs[0];
    if (!first) {
      this.control = { tag: 'value', value: name === 'and' ? TRUE : FALSE };
      return;
    }
    const last = exprs.length === 1;
    this.action = `求值 ${name} 的参数`;
    this.currentEnv = env;
    this.currentSpan = first.span;
    this.control = { tag: 'eval', expr: first, env, tail: last && tail };
    if (!last) this.kont = { tag: name, rest: exprs.slice(1), env, tail, span, next: this.kont };
  }

  private evalDo(items: SExpr[], span: SourceSpan, env: Env, tail: boolean): void {
    if (items.length < 3) throw new LispError('syntax', 'do 形式不完整', span);
    const spec = items[1];
    const clause = items[2];
    if (!spec || !clause) throw new LispError('syntax', 'do 形式不完整', span);
    const specs = toProperList(spec);
    if (!specs) throw new LispError('syntax', 'do 的绑定必须是真列表', spec.span);
    const commands = items.slice(3);
    const bindings: Array<{ name: string; init: SExpr; step: SExpr }> = [];
    const names = new Set<string>();
    for (const binding of specs) {
      const parts = toProperList(binding);
      if (!parts || (parts.length !== 2 && parts.length !== 3)) {
        throw new LispError('syntax', 'do 绑定必须是 (变量 初始值) 或 (变量 初始值 步进)', binding.span);
      }
      const nameExpr = parts[0];
      const init = parts[1];
      if (!nameExpr || !init || nameExpr.t !== 'sym') {
        throw new LispError('syntax', 'do 的变量必须是符号', nameExpr?.span ?? binding.span);
      }
      if (names.has(nameExpr.v)) throw new LispError('syntax', `do 中变量 ${nameExpr.v} 重复绑定`, nameExpr.span);
      names.add(nameExpr.v);
      bindings.push({ name: nameExpr.v, init, step: parts[2] ?? nameExpr });
    }
    const clauseItems = toProperList(clause);
    if (!clauseItems || clauseItems.length === 0) {
      throw new LispError('syntax', 'do 的测试子句不完整', clause.span);
    }
    const test = clauseItems[0];
    if (!test) throw new LispError('syntax', 'do 的测试子句不完整', clause.span);
    const results = clauseItems.slice(1);
    let loopName = DO_LOOP;
    while (names.has(loopName)) loopName += '*';
    const stepCall = listNode(
      [symNode(loopName, span), ...bindings.map((binding) => binding.step)],
      span,
    );
    const elseExpr = commands.length === 0 ? stepCall : listNode([symNode('begin', span), ...commands, stepCall], span);
    const thenExpr =
      results.length === 0
        ? listNode([symNode('if', span), boolNode(false, span), numNode(0, span)], span)
        : results.length === 1
          ? results[0]!
          : listNode([symNode('begin', span), ...results], span);
    const ifExpr = listNode([symNode('if', span), test, thenExpr, elseExpr], span);
    const bindingList = listNode(
      bindings.map((binding) => listNode([symNode(binding.name, binding.init.span), binding.init], binding.init.span)),
      span,
    );
    const namedLet = listNode([symNode('let', span), symNode(loopName, span), bindingList, ifExpr], span);
    this.action = '进入 do';
    this.evalCombination(namedLet, env, tail);
  }

  private formNamed(expr: SExpr, name: string): SExpr | null {
    if (expr.t !== 'pair' || expr.car.t !== 'sym' || expr.car.v !== name) return null;
    if (expr.cdr.t !== 'pair' || expr.cdr.cdr.t !== 'nil') {
      throw new LispError('syntax', `${name} 需要且只需要一个参数`, expr.span);
    }
    return expr.cdr.car;
  }

  private driveQQ(template: SExpr, level: number): void {
    const kont = this.kont;
    if (kont.tag !== 'qq') throw new LispError('runtime', '内部错误：准引用续延丢失', this.currentSpan);
    let current = template;
    let currentLevel = level;
    while (true) {
      if (this.formNamed(current, 'unquote-splicing')) {
        throw new LispError('syntax', '准引用中 unquote-splicing 不能独立出现', current.span);
      }
      const unquote = this.formNamed(current, 'unquote');
      if (unquote) {
        if (currentLevel === 1) {
          this.action = '求值 unquote';
          this.currentSpan = unquote.span;
          this.currentEnv = kont.env;
          this.control = { tag: 'eval', expr: unquote, env: kont.env, tail: false };
          return;
        }
        kont.stack.push({ kind: 'wrap', name: 'unquote' });
        current = unquote;
        currentLevel -= 1;
        continue;
      }
      const nested = this.formNamed(current, 'quasiquote');
      if (nested) {
        kont.stack.push({ kind: 'wrap', name: 'quasiquote' });
        current = nested;
        currentLevel += 1;
        continue;
      }
      if (current.t === 'pair') {
        const carSplice = this.formNamed(current.car, 'unquote-splicing');
        if (carSplice && currentLevel === 1) {
          kont.stack.push({ kind: 'splice', cdr: current.cdr, level: currentLevel, span: current.car.span });
          this.action = '求值 unquote-splicing';
          this.currentSpan = carSplice.span;
          this.currentEnv = kont.env;
          this.control = { tag: 'eval', expr: carSplice, env: kont.env, tail: false };
          return;
        }
        if (carSplice && currentLevel > 1) {
          kont.stack.push({ kind: 'car', cdr: current.cdr, level: currentLevel });
          kont.stack.push({ kind: 'wrap', name: 'unquote-splicing' });
          current = carSplice;
          currentLevel -= 1;
          continue;
        }
        kont.stack.push({ kind: 'car', cdr: current.cdr, level: currentLevel });
        current = current.car;
        continue;
      }
      this.control = { tag: 'value', value: this.sexprToValue(current) };
      return;
    }
  }

  private continueQQ(kont: Extract<Kont, { tag: 'qq' }>, value: Value): void {
    const frame = kont.stack.pop();
    if (!frame) {
      this.kont = kont.next;
      this.action = '准引用完成';
      this.control = { tag: 'value', value };
      return;
    }
    if (frame.kind === 'wrap') {
      this.control = {
        tag: 'value',
        value: this.cons({ kind: 'symbol', name: frame.name }, this.cons(value, NIL)),
      };
      return;
    }
    if (frame.kind === 'car') {
      kont.stack.push({ kind: 'cdr', car: value });
      this.driveQQ(frame.cdr, frame.level);
      return;
    }
    if (frame.kind === 'cdr') {
      this.control = { tag: 'value', value: this.cons(frame.car, value) };
      return;
    }
    if (frame.kind === 'splice') {
      if (!isProperList(value)) {
        throw new LispError('runtime', 'unquote-splicing 的结果必须是真列表', frame.span);
      }
      kont.stack.push({ kind: 'splice-tail', head: value, span: frame.span });
      this.driveQQ(frame.cdr, frame.level);
      return;
    }
    this.control = { tag: 'value', value: this.appendList(frame.head, value, frame.span) };
  }

  private appendList(head: Value, tail: Value, span: SourceSpan): Value {
    if (!isProperList(head)) throw new LispError('runtime', 'unquote-splicing 的结果必须是真列表', span);
    const cells: Value[] = [];
    let current = head;
    while (current.kind === 'pair') {
      cells.push(current.car);
      current = current.cdr;
    }
    let node = tail;
    for (let index = cells.length - 1; index >= 0; index -= 1) {
      const car = cells[index];
      if (car) node = this.cons(car, node);
    }
    return node;
  }
}
