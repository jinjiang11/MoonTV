import { AdCandidate } from './types';

export const MIN_AUTO_SKIP_CONFIDENCE = 0.5;

export function findActiveAdCandidate(
  candidates: AdCandidate[],
  currentTime: number,
  minimumConfidence = MIN_AUTO_SKIP_CONFIDENCE
): AdCandidate | null {
  return (
    candidates
      .filter(
        (candidate) =>
          candidate.confidence >= minimumConfidence &&
          currentTime >= candidate.start &&
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
