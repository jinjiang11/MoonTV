import {
  AUTO_SKIP_LEAD_TIME_SECONDS,
  findActiveAdCandidate,
  getAdSkipTarget,
  getAdSkipWindowStart,
  MIN_AUTO_SKIP_CONFIDENCE,
  SAFARI_AUTO_SKIP_LEAD_TIME_SECONDS,
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
  it('matches one second before a range but not earlier or at its end', () => {
    const ad = candidate();

    expect(AUTO_SKIP_LEAD_TIME_SECONDS).toBe(1);
    expect(findActiveAdCandidate([ad], 8.999)).toBeNull();
    expect(findActiveAdCandidate([ad], 9)).toBe(ad);
    expect(findActiveAdCandidate([ad], 10)).toBe(ad);
    expect(findActiveAdCandidate([ad], 19.999)).toBe(ad);
    expect(findActiveAdCandidate([ad], 20)).toBeNull();
  });

  it('clamps the lead window to the beginning of the video', () => {
    expect(getAdSkipWindowStart(candidate({ start: 0.5 }))).toBe(0);
  });

  it('supports the larger Safari and AirPlay safety window', () => {
    const ad = candidate();

    expect(SAFARI_AUTO_SKIP_LEAD_TIME_SECONDS).toBe(3);
    expect(
      findActiveAdCandidate(
        [ad],
        7,
        MIN_AUTO_SKIP_CONFIDENCE,
        SAFARI_AUTO_SKIP_LEAD_TIME_SECONDS
      )
    ).toBe(ad);
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
