import { describe, it } from 'vitest';
import { expectSchedule, runsFor } from '../helpers/oracle';

describe('SJF 非抢占', () => {
  for (const run of runsFor('sjf')) {
    it(`${run.caseId} ${run.title} 与手算一致`, () => {
      expectSchedule(run);
    });
  }
});
