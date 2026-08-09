import {
  findActiveAdCandidate,
  getAdSkipTarget,
  MIN_AUTO_SKIP_CONFIDENCE,
} from './playback';
import { AdCandidate } from './types';

function candidate(overrides: Partial<AdCandidate> = {}): AdCandidate {
  return {
    id: 'ad-1',
    start: 10,
    end: 20,
    duration: 10,
    confidence: MIN_AUTO_SKIP_CONFIDENCE,
    evidence: [],
    segmentUris: [],
    ...overrides,
  };
}

describe('ad playback helpers', () => {
  it('matches the start of a range but not its end', () => {
    const ad = candidate();

    expect(findActiveAdCandidate([ad], 10)).toBe(ad);
    expect(findActiveAdCandidate([ad], 19.999)).toBe(ad);
    expect(findActiveAdCandidate([ad], 20)).toBeNull();
  });

  it('ignores candidates below the requested confidence', () => {
    const ad = candidate({ confidence: 0.7 });

    expect(findActiveAdCandidate([ad], 15, 0.8)).toBeNull();
  });

  it('prefers the highest-confidence overlapping candidate', () => {
    const lower = candidate({ id: 'lower', confidence: 0.6 });
    const higher = candidate({ id: 'higher', confidence: 0.9 });

    expect(findActiveAdCandidate([lower, higher], 15)).toBe(higher);
  });

  it('seeks just beyond the range and clamps to media duration', () => {
    const ad = candidate();

    expect(getAdSkipTarget(ad)).toBe(20.05);
    expect(getAdSkipTarget(ad, 20)).toBe(20);
  });
});
