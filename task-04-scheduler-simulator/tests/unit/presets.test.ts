import { describe, expect, it } from 'vitest';
import { PRESETS } from '../../src/fixtures/presets';
import { allCases } from '../helpers/oracle';

describe('界面预设与标准用例一致', () => {
  it('预设 A/B/C/Q1 的进程表等于夹具', () => {
    for (const id of ['A', 'B', 'C', 'Q1']) {
      const preset = PRESETS.find((item) => item.id === id);
      const fixture = allCases().find((item) => item.id === id);
      expect(preset?.processes).toEqual(fixture?.processes);
    }
  });
});
