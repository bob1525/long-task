import { describe, it } from 'vitest';
import { expectSchedule, runsFor } from '../helpers/oracle';

describe('FCFS', () => {
  for (const run of runsFor('fcfs', 'all')) {
    it(`${run.caseId} ${run.title} 与手算一致`, () => {
      expectSchedule(run);
    });
  }
});
