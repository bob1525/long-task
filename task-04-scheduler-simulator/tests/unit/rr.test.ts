import { describe, it } from 'vitest';
import { expectSchedule, runsFor } from '../helpers/oracle';

describe('Round Robin', () => {
  for (const run of runsFor('rr', 'all')) {
    it(`${run.caseId} ${run.title} 与手算一致`, () => {
      expectSchedule(run);
    });
  }
});
