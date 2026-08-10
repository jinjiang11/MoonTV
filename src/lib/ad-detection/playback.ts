import { AdCandidate } from './types';

export const MIN_AUTO_SKIP_CONFIDENCE = 0.5;
export const AUTO_SKIP_LEAD_TIME_SECONDS = 1;

export function getAdSkipWindowStart(
  candidate: AdCandidate,
  leadTime = AUTO_SKIP_LEAD_TIME_SECONDS
): number {
  return Math.max(0, candidate.start - Math.max(0, leadTime));
}

export function findActiveAdCandidate(
  candidates: AdCandidate[],
  currentTime: number,
  minimumConfidence = MIN_AUTO_SKIP_CONFIDENCE,
  leadTime = AUTO_SKIP_LEAD_TIME_SECONDS
): AdCandidate | null {
  return (
    candidates
      .filter(
        (candidate) =>
          candidate.confidence >= minimumConfidence &&
          currentTime >= getAdSkipWindowStart(candidate, leadTime) &&
          currentTime < candidate.end
      )
      .sort(
        (left, right) =>
          right.confidence - left.confidence || left.duration - right.duration
      )[0] || null
  );
}

export function getAdSkipTarget(
  candidate: AdCandidate,
  mediaDuration?: number
): number {
  const target = candidate.end + 0.05;
  if (!mediaDuration || !Number.isFinite(mediaDuration) || mediaDuration <= 0) {
    return target;
  }

  return Math.min(target, mediaDuration);
}
