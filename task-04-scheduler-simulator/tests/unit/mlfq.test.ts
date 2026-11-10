import { describe, it } from 'vitest';
import { expectSchedule, runsFor } from '../helpers/oracle';

describe('MLFQ', () => {
  for (const run of runsFor('mlfq')) {
    it(`${run.caseId} ${run.title} 与手算一致`, () => {
      expectSchedule(run);
    });
  }
});
