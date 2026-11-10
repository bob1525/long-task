// 手写递归下降读取器。嵌套列表和引号用显式栈展开，避免深层括号撑爆宿主调用栈。
import { asLispError, LispError } from './error';
import { lex, type Token } from './lexer';
import type { ParseItem, SExpr, SourcePos, SourceSpan } from './types';

interface ListFrame {
  kind: 'list';
  start: SourcePos;
  items: SExpr[];
  dotted: boolean;
  dotExpr: SExpr | null;
}

interface QuoteFrame {
  kind: 'quote';
  start: SourcePos;
}

type Frame = ListFrame | QuoteFrame;

function point(pos: SourcePos): SourceSpan {
  return { start: pos, end: pos };
}

function atomFrom(token: Token): SExpr {
  switch (token.kind) {
    case 'number':
      return { t: 'num', v: token.value, span: token.span };
    case 'boolean':
      return { t: 'bool', v: token.value, span: token.span };
    case 'string':
      return { t: 'str', v: token.value, span: token.span };
    case 'symbol':
      return { t: 'sym', v: token.value, span: token.span };
    default:
      throw new LispError('syntax', '内部错误：期望原子', token.span);
  }
}

function makeQuote(start: SourcePos, expr: SExpr): SExpr {
  const span: SourceSpan = { start, end: expr.span.end };
  const quoteSymbol: SExpr = {
    t: 'sym',
    v: 'quote',
    span: {
      start,
      end: { offset: start.offset + 1, line: start.line, column: start.column + 1 },
    },
  };
  const nil: SExpr = { t: 'nil', span: expr.span };
  const tail: SExpr = { t: 'pair', car: expr, cdr: nil, span };
  return { t: 'pair', car: quoteSymbol, cdr: tail, span };
}

function buildList(frame: ListFrame, end: SourcePos): SExpr {
  const span: SourceSpan = { start: frame.start, end };
  if (frame.items.length === 0 && frame.dotExpr === null) {
    return { t: 'nil', span };
  }
  let node: SExpr = frame.dotExpr ?? { t: 'nil', span: point(end) };
  for (let index = frame.items.length - 1; index >= 0; index -= 1) {
    const car = frame.items[index];
    if (!car) continue;
    node = { t: 'pair', car, cdr: node, span };
  }
  return node;
}

function skipForm(tokens: Token[], start: number): number {
  const token = tokens[start];
  if (!token) return start;
  if (token.kind !== 'lparen') return start + 1;
  let depth = 0;
  let index = start;
  while (index < tokens.length) {
    const current = tokens[index];
    if (!current) break;
    if (current.kind === 'lparen') depth += 1;
    else if (current.kind === 'rparen') {
      depth -= 1;
      index += 1;
      if (depth === 0) return index;
      continue;
    }
    index += 1;
  }
  return index;
}

function parseTokens(tokens: Token[], end: SourcePos, recover: boolean): ParseItem[] {
  const items: ParseItem[] = [];
  let index = 0;

  function readOne(): SExpr {
    const stack: Frame[] = [];

    const place = (expr: SExpr): SExpr | null => {
      let current = expr;
      while (true) {
        const top = stack[stack.length - 1];
        if (!top) return current;
        if (top.kind === 'quote') {
          stack.pop();
          current = makeQuote(top.start, current);
          continue;
        }
        if (top.dotExpr) {
          throw new LispError('syntax', '点号后只能有一个表达式', current.span);
        }
        if (top.dotted) {
          top.dotExpr = current;
          return null;
        }
        top.items.push(current);
        return null;
      }
    };

    while (true) {
      const token = tokens[index];
      if (!token) {
        const top = stack[stack.length - 1];
        if (!top) throw new LispError('syntax', '意外的文件结束', point(end));
        if (top.kind === 'list' && top.dotted && !top.dotExpr) {
          throw new LispError('syntax', '点号后缺少表达式', { start: top.start, end });
        }
        throw new LispError(
          'syntax',
          top.kind === 'quote' ? '引号后缺少表达式' : '列表未闭合，缺少右括号',
          { start: top.start, end },
        );
      }

      if (token.kind === 'rparen') {
        const top = stack[stack.length - 1];
        if (!top) throw new LispError('syntax', '多余的右括号', token.span);
        if (top.kind === 'quote') throw new LispError('syntax', '引号后缺少表达式', token.span);
        stack.pop();
        if (top.dotted && !top.dotExpr) {
          throw new LispError('syntax', '点号后缺少表达式', token.span);
        }
        index += 1;
        const done = place(buildList(top, token.span.end));
        if (done) return done;
        continue;
      }

      if (token.kind === 'dot') {
        const top = stack[stack.length - 1];
        if (!top || top.kind !== 'list') throw new LispError('syntax', '意外的点号', token.span);
        if (top.dotted) throw new LispError('syntax', '多余的点号', token.span);
        if (top.items.length === 0) throw new LispError('syntax', '点号前缺少表达式', token.span);
        top.dotted = true;
        index += 1;
        continue;
      }

      if (token.kind === 'lparen') {
        stack.push({
          kind: 'list',
          start: token.span.start,
          items: [],
          dotted: false,
          dotExpr: null,
        });
        index += 1;
        continue;
      }

      if (token.kind === 'quote') {
        stack.push({ kind: 'quote', start: token.span.start });
        index += 1;
        continue;
      }

      index += 1;
      const done = place(atomFrom(token));
      if (done) return done;
    }
  }

  while (index < tokens.length) {
    const start = index;
    try {
      items.push({ ok: true, expr: readOne() });
    } catch (error) {
      const lisp = asLispError(error, point(end));
      if (!recover) throw lisp;
      items.push({ ok: false, error: lisp });
      index = skipForm(tokens, start);
      if (index === start) index += 1;
    }
  }
  return items;
}

export function parseProgram(source: string): SExpr[] {
  const { tokens, end } = lex(source);
  const items = parseTokens(tokens, end, false);
  return items.flatMap((item) => (item.ok ? [item.expr] : []));
}

export function parseProgramRecovering(source: string): ParseItem[] {
  try {
    const { tokens, end } = lex(source);
    return parseTokens(tokens, end, true);
  } catch (error) {
    return [{ ok: false, error: asLispError(error, null) }];
  }
}
