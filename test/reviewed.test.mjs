import { describe, expect, it } from 'vitest';
import { REVIEWED_LINKS, reviewedPairs } from '../src/reviewed.mjs';

describe('hand-reviewed links', () => {
  it('every entry is complete: 2+ addresses, reviewer, date, evidence', () => {
    for (const e of REVIEWED_LINKS) {
      expect(e.wallets.length).toBeGreaterThanOrEqual(2);
      for (const w of e.wallets) expect(w).toMatch(/^0x[0-9a-f]{40}$/);
      expect(e.reviewedBy).toBeTruthy();
      expect(e.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(e.evidence.length).toBeGreaterThan(40);
    }
  });
  it('chains each entry into one person', () => {
    expect(reviewedPairs([{ wallets: ['0xA', '0xB', '0xC'] }])).toEqual([
      ['0xb', '0xa'],
      ['0xc', '0xa'],
    ]);
  });
});
