export interface SourcePos {
  offset: number;
  line: number;
  column: number;
}

export interface SourceSpan {
  start: SourcePos;
  end: SourcePos;
}

export type ErrorKind = 'syntax' | 'runtime' | 'undefined' | 'type';

export interface ErrorView {
  kind: ErrorKind;
  detail: string;
  text: string;
  line: number | null;
  column: number | null;
}

export type SExpr =
  | { t: 'num'; v: number; span: SourceSpan }
  | { t: 'bool'; v: boolean; span: SourceSpan }
  | { t: 'str'; v: string; span: SourceSpan }
  | { t: 'sym'; v: string; span: SourceSpan }
  | { t: 'nil'; span: SourceSpan }
  | { t: 'pair'; car: SExpr; cdr: SExpr; span: SourceSpan };

export interface World {
  output: string[];
  results: string[];
  pairs: number;
  envCount: number;
  nextPairId: number;
  nextEnvId: number;
  nextProcId: number;
  maxCallStack: number;
}

export type Value =
  | { kind: 'number'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'string'; value: string }
  | { kind: 'symbol'; name: string }
  | { kind: 'nil' }
  | { kind: 'pair'; id: number; car: Value; cdr: Value }
  | {
      kind: 'procedure';
      id: number;
      name: string | null;
      params: string[];
      rest: string | null;
      body: SExpr[];
      env: Env;
      span: SourceSpan;
    }
  | { kind: 'builtin'; name: string; fn: BuiltinFn }
  | { kind: 'void' };

export interface BuiltinCtx {
  span: SourceSpan;
  cons: (car: Value, cdr: Value) => Value;
  output: string[];
}

export type BuiltinFn = (args: Value[], ctx: BuiltinCtx) => Value;

export interface Env {
  readonly id: number;
  readonly label: string;
  readonly parent: Env | null;
  lookup(name: string): Value | null;
  define(name: string, value: Value): void;
  assign(name: string, value: Value): boolean;
  entries(): Array<[string, Value]>;
  extend(label: string): Env;
}

export interface BindingSnapshot {
  name: string;
  value: string;
  capturedEnvId: number | null;
}

export interface EnvFrameSnapshot {
  id: number;
  label: string;
  parentId: number | null;
  bindings: BindingSnapshot[];
}

export interface CallFrameSnapshot {
  name: string;
  args: string;
  envId: number;
  span: SourceSpan;
}

export interface MemorySnapshot {
  pairs: number;
  environments: number;
  stackDepth: number;
  maxStackDepth: number;
  chainDepth: number;
  steps: number;
}

export type StepStatus = 'ready' | 'running' | 'done' | 'error';

export interface Snapshot {
  step: number;
  status: StepStatus;
  action: string;
  currentExpr: string | null;
  currentSpan: SourceSpan | null;
  valuePreview: string | null;
  callStack: CallFrameSnapshot[];
  frames: EnvFrameSnapshot[];
  activeEnvId: number | null;
  output: string;
  results: string[];
  transcript: string;
  memory: MemorySnapshot;
  error: ErrorView | null;
}

export interface ParseSuccess {
  ok: true;
  expr: SExpr;
}

export interface ParseFailure {
  ok: false;
  error: LispErrorLike;
}

export interface LispErrorLike {
  kind: ErrorKind;
  detail: string;
  message: string;
  span: SourceSpan | null;
}

export type ParseItem = ParseSuccess | ParseFailure;
