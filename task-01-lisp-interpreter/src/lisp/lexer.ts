import { LispError } from './error';
import type { SourcePos, SourceSpan } from './types';

export type Token =
  | { kind: 'lparen'; span: SourceSpan }
  | { kind: 'rparen'; span: SourceSpan }
  | { kind: 'quote'; span: SourceSpan }
  | { kind: 'dot'; span: SourceSpan }
  | { kind: 'number'; value: number; span: SourceSpan }
  | { kind: 'boolean'; value: boolean; span: SourceSpan }
  | { kind: 'string'; value: string; span: SourceSpan }
  | { kind: 'symbol'; value: string; span: SourceSpan };

export interface LexResult {
  tokens: Token[];
  end: SourcePos;
}

const NUMBER_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

function isDelimiter(ch: string | undefined): boolean {
  return ch === undefined || ' \t\n\r\f\v()\'";`,'.includes(ch);
}

function looksLikeNumber(text: string): boolean {
  return /^[+-]?\d/.test(text) || /^[+-]?\.\d/.test(text);
}

export function lex(source: string): LexResult {
  const tokens: Token[] = [];
  let index = 0;
  let line = 1;
  let column = 1;

  function pos(): SourcePos {
    return { offset: index, line, column };
  }

  function bump(): void {
    const ch = source[index];
    if (ch === undefined) return;
    if (ch === '\r') {
      index += 1;
      if (source[index] === '\n') index += 1;
      line += 1;
      column = 1;
      return;
    }
    index += 1;
    if (ch === '\n') {
      line += 1;
      column = 1;
      return;
    }
    column += 1;
  }

  while (index < source.length) {
    const start = pos();
    const ch = source[index];
    if (ch === undefined) break;

    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v') {
      bump();
      continue;
    }

    if (ch === ';') {
      while (index < source.length && source[index] !== '\n' && source[index] !== '\r') bump();
      continue;
    }

    if (ch === '(' || ch === ')' || ch === "'") {
      bump();
      const span = { start, end: pos() };
      if (ch === '(') tokens.push({ kind: 'lparen', span });
      else if (ch === ')') tokens.push({ kind: 'rparen', span });
      else tokens.push({ kind: 'quote', span });
      continue;
    }

    if (ch === '`' || ch === ',') {
      bump();
      const label = ch === '`' ? '不支持准引用语法' : '不支持逗号语法';
      throw new LispError('syntax', label, { start, end: pos() });
    }

    if (ch === '"') {
      bump();
      let value = '';
      let closed = false;
      while (index < source.length) {
        const current = source[index];
        if (current === undefined) break;
        if (current === '"') {
          bump();
          closed = true;
          break;
        }
        if (current === '\\') {
          bump();
          const escaped = source[index];
          if (escaped === undefined) break;
          bump();
          if (escaped === 'n') value += '\n';
          else if (escaped === 't') value += '\t';
          else if (escaped === 'r') value += '\r';
          else if (escaped === '\\') value += '\\';
          else if (escaped === '"') value += '"';
          else {
            throw new LispError('syntax', `未知的字符串转义 \\${escaped}`, { start, end: pos() });
          }
          continue;
        }
        value += current;
        bump();
      }
      if (!closed) {
        throw new LispError('syntax', '字符串缺少结束引号', { start, end: pos() });
      }
      tokens.push({ kind: 'string', value, span: { start, end: pos() } });
      continue;
    }

    if (ch === '#') {
      let text = '';
      while (!isDelimiter(source[index])) {
        text += source[index] ?? '';
        bump();
      }
      const span = { start, end: pos() };
      const word = text.toLowerCase();
      if (word === '#t' || word === '#true') tokens.push({ kind: 'boolean', value: true, span });
      else if (word === '#f' || word === '#false') tokens.push({ kind: 'boolean', value: false, span });
      else throw new LispError('syntax', `无法识别的字面量 ${text}`, span);
      continue;
    }

    if (!isDelimiter(ch)) {
      let text = '';
      while (!isDelimiter(source[index])) {
        text += source[index] ?? '';
        bump();
      }
      const span = { start, end: pos() };
      if (text === '.') {
        tokens.push({ kind: 'dot', span });
        continue;
      }
      if (NUMBER_RE.test(text)) {
        const numeric = Number(text);
        if (!Number.isFinite(numeric)) {
          throw new LispError('syntax', `数字超出范围 ${text}`, span);
        }
        tokens.push({ kind: 'number', value: numeric, span });
        continue;
      }
      if (looksLikeNumber(text)) {
        throw new LispError('syntax', `非法数字 ${text}`, span);
      }
      tokens.push({ kind: 'symbol', value: text, span });
      continue;
    }

    bump();
    throw new LispError('syntax', `无法识别的字符 ${JSON.stringify(ch)}`, { start, end: pos() });
  }

  return { tokens, end: pos() };
}
