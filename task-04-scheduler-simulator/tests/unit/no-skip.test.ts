import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const banned = [
  'it' + '.skip',
  'it' + '.only',
  'test' + '.skip',
  'test' + '.only',
  'describe' + '.skip',
  'describe' + '.only',
  'it' + '.fixme',
  'test' + '.fixme',
  'it' + '.todo',
  'test' + '.todo',
  'xit' + '(',
  'xtest' + '(',
  'xdescribe' + '(',
  'xf' + 'ail',
];

function filesUnder(dir: string): string[] {
  const absolute = path.join(process.cwd(), dir);
  const found: string[] = [];
  for (const entry of readdirSync(absolute)) {
    const full = path.join(absolute, entry);
    if (statSync(full).isDirectory()) found.push(...filesUnder(path.join(dir, entry)));
    else if (full.endsWith('.ts') || full.endsWith('.tsx')) found.push(full);
  }
  return found;
}

describe('测试没有被跳过', () => {
  it('单元测试和端到端测试都不含 skip、only、fixme 或 xfail', () => {
    const files = [...filesUnder('tests'), ...filesUnder('e2e')].filter(
      (file) => !file.endsWith(`${path.sep}no-skip.test.ts`),
    );
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const token of banned) {
        expect(text.includes(token), `${file} 含有 ${token}`).toBe(false);
      }
    }
  });
});
