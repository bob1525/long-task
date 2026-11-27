import type { ErrorKind, ErrorView, LispErrorLike, SourceSpan } from './types';

const LABELS: Record<ErrorKind, string> = {
  syntax: '语法错误',
  runtime: '运行时错误',
  undefined: '未定义变量',
  type: '类型错误',
};

export function formatLispError(kind: ErrorKind, detail: string, span: SourceSpan | null): string {
  const where = span ? `第 ${span.start.line} 行, 第 ${span.start.column} 列` : '未知位置';
  return `${LABELS[kind]} (${where}): ${detail}`;
}

export class LispError extends Error implements LispErrorLike {
  readonly kind: ErrorKind;
  readonly detail: string;
  readonly span: SourceSpan | null;

  constructor(kind: ErrorKind, detail: string, span: SourceSpan | null) {
    super(formatLispError(kind, detail, span));
    this.name = 'LispError';
    this.kind = kind;
    this.detail = detail;
    this.span = span;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function asLispError(error: unknown, span: SourceSpan | null): LispError {
  if (error instanceof LispError) return error;
  if (error instanceof RangeError) {
    return new LispError('runtime', '表达式嵌套过深，超出宿主限制', span);
  }
  const detail = error instanceof Error ? error.message : String(error);
  return new LispError('runtime', detail, span);
}

export function serializeError(error: LispErrorLike): ErrorView {
  return {
    kind: error.kind,
    detail: error.detail,
    text: error.message,
    line: error.span?.start.line ?? null,
    column: error.span?.start.column ?? null,
  };
}
