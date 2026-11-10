import type { SExpr, Value } from './types';

export function printNumber(value: number): string {
  if (Object.is(value, -0)) return '0';
  if (Number.isInteger(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER) {
    return value.toFixed(0);
  }
  return String(value);
}

function escapeString(value: string): string {
  let out = '';
  for (const ch of value) {
    if (ch === '\\') out += '\\\\';
    else if (ch === '"') out += '\\"';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else out += ch;
  }
  return out;
}

function writeAtom(value: Value): string | null {
  switch (value.kind) {
    case 'number':
      return printNumber(value.value);
    case 'boolean':
      return value.value ? '#t' : '#f';
    case 'string':
      return `"${escapeString(value.value)}"`;
    case 'symbol':
      return value.name;
    case 'nil':
      return '()';
    case 'void':
      return '#<void>';
    case 'builtin':
      return `#<builtin ${value.name}>`;
    case 'procedure':
      return `#<procedure${value.name ? ` ${value.name}` : ''}>`;
    case 'pair':
      return null;
    default: {
      const neverValue: never = value;
      return String(neverValue);
    }
  }
}

function quoteInner(value: Value): Value | null {
  if (value.kind !== 'pair') return null;
  if (value.car.kind !== 'symbol' || value.car.name !== 'quote') return null;
  if (value.cdr.kind !== 'pair') return null;
  if (value.cdr.cdr.kind !== 'nil') return null;
  return value.cdr.car;
}

function writeValue(value: Value, seen: Set<number>): string {
  const atom = writeAtom(value);
  if (atom !== null) return atom;
  if (value.kind !== 'pair') return '#<unprintable>';
  if (seen.has(value.id)) return '#<cycle>';

  const inner = quoteInner(value);
  if (inner) {
    seen.add(value.id);
    if (value.cdr.kind === 'pair') seen.add(value.cdr.id);
    const text = `'${writeValue(inner, seen)}`;
    seen.delete(value.id);
    if (value.cdr.kind === 'pair') seen.delete(value.cdr.id);
    return text;
  }

  const ids: number[] = [];
  const parts: string[] = [];
  let current: Value = value;
  while (current.kind === 'pair') {
    if (seen.has(current.id)) {
      for (const id of ids) seen.delete(id);
      return parts.length > 0 ? `(${parts.join(' ')} . #<cycle>)` : '#<cycle>';
    }
    seen.add(current.id);
    ids.push(current.id);
    parts.push(writeValue(current.car, seen));
    current = current.cdr;
  }
  for (const id of ids) seen.delete(id);
  if (current.kind === 'nil') return `(${parts.join(' ')})`;
  return `(${parts.join(' ')} . ${writeValue(current, seen)})`;
}

export function printValue(value: Value): string {
  try {
    return writeValue(value, new Set());
  } catch (error) {
    if (error instanceof RangeError) return '#<deep-value>';
    throw error;
  }
}

export function previewValue(value: Value, limit = 80): string {
  const text = printValue(value);
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

export function displayString(value: Value): string {
  if (value.kind === 'string') return value.value;
  return printValue(value);
}

function quoteInnerSExpr(expr: SExpr): SExpr | null {
  if (expr.t !== 'pair' || expr.car.t !== 'sym' || expr.car.v !== 'quote') return null;
  if (expr.cdr.t !== 'pair' || expr.cdr.cdr.t !== 'nil') return null;
  return expr.cdr.car;
}

function writeSExpr(expr: SExpr): string {
  switch (expr.t) {
    case 'num':
      return printNumber(expr.v);
    case 'bool':
      return expr.v ? '#t' : '#f';
    case 'str':
      return `"${escapeString(expr.v)}"`;
    case 'sym':
      return expr.v;
    case 'nil':
      return '()';
    case 'pair': {
      const quoted = quoteInnerSExpr(expr);
      if (quoted) return `'${writeSExpr(quoted)}`;
      const parts: string[] = [];
      const seen = new Set<SExpr>();
      let current: SExpr = expr;
      while (current.t === 'pair') {
        if (seen.has(current)) return `(${parts.join(' ')} . #<cycle>)`;
        seen.add(current);
        parts.push(writeSExpr(current.car));
        current = current.cdr;
      }
      if (current.t === 'nil') return `(${parts.join(' ')})`;
      return `(${parts.join(' ')} . ${writeSExpr(current)})`;
    }
    default: {
      const neverExpr: never = expr;
      return String(neverExpr);
    }
  }
}

export function printSExpr(expr: SExpr): string {
  try {
    const text = writeSExpr(expr);
    return text.length > 300 ? `${text.slice(0, 300)}…` : text;
  } catch (error) {
    if (error instanceof RangeError) return '#<deep-expr>';
    throw error;
  }
}

export function buildTranscript(output: string, results: readonly string[]): string {
  let text = output;
  for (const result of results) {
    if (text.length > 0 && !text.endsWith('\n')) text += '\n';
    text += `=> ${result}\n`;
  }
  return text;
}
