import { LispError } from './error';
import type { SExpr } from './types';

export interface ParamList {
  params: string[];
  rest: string | null;
}

export function parseParamList(expr: SExpr): ParamList {
  if (expr.t === 'nil') return { params: [], rest: null };
  if (expr.t === 'sym') return { params: [], rest: expr.v };
  if (expr.t !== 'pair') {
    throw new LispError('syntax', '参数列表必须是符号或列表', expr.span);
  }

  const params: string[] = [];
  let current: SExpr = expr;
  while (current.t === 'pair') {
    if (current.car.t !== 'sym') {
      throw new LispError('syntax', '参数名必须是符号', current.car.span);
    }
    params.push(current.car.v);
    current = current.cdr;
  }

  let rest: string | null = null;
  if (current.t === 'sym') rest = current.v;
  else if (current.t !== 'nil') {
    throw new LispError('syntax', '参数列表格式无效', current.span);
  }

  const names = new Set<string>();
  const all = rest === null ? params : [...params, rest];
  for (const name of all) {
    if (names.has(name)) {
      throw new LispError('syntax', `参数名 ${name} 重复`, expr.span);
    }
    names.add(name);
  }
  return { params, rest };
}

export function toProperList(expr: SExpr): SExpr[] | null {
  const items: SExpr[] = [];
  const seen = new Set<SExpr>();
  let current = expr;
  while (current.t === 'pair') {
    if (seen.has(current)) return null;
    seen.add(current);
    items.push(current.car);
    current = current.cdr;
  }
  if (current.t !== 'nil') return null;
  return items;
}
