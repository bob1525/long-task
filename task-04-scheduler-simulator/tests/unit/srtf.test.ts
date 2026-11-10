import { describe, it } from 'vitest';
import { expectSchedule, runsFor } from '../helpers/oracle';

describe('SRTF', () => {
  for (const run of runsFor('srtf')) {
    it(`${run.caseId} ${run.title} 与手算一致`, () => {
      expectSchedule(run);
    });
  }
});
