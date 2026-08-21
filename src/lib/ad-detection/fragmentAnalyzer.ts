import { AdCandidate } from './types';

export interface FragmentTrackObservation {
  start: number;
  duration: number;
  width: number;
  height: number;
  uri?: string;
  manifestUrl?: string;
}

interface VideoSignature {
  width: number;
  height: number;
}

interface PendingTrackSwitch {
  baseline: VideoSignature;
  changed: VideoSignature;
  start: number;
  manifestUrl?: string;
  segmentUris: string[];
}

const MAX_TEMPORARY_SWITCH_DURATION = 180;

function sameSignature(left: VideoSignature, right: VideoSignature): boolean {
  return left.width === right.width && left.height === right.height;
}

function validObservation(
  observation: FragmentTrackObservation
): observation is FragmentTrackObservation {
  return (
    Number.isFinite(observation.start) &&
    observation.start >= 0 &&
    Number.isFinite(observation.duration) &&
    observation.duration > 0 &&
    Number.isFinite(observation.width) &&
    observation.width > 0 &&
    Number.isFinite(observation.height) &&
    observation.height > 0
  );
}

function candidateId(start: number, end: number): string {
  return `hls-${Math.round(start * 1000)}-${Math.round(end * 1000)}`;
}

/**
 * Detect short clips that temporarily switch video dimensions and then return
 * to the previous dimensions. Hls.js emits these observations from parsed
 * init segments, so no segment is downloaded a second time.
 */
export class FragmentTrackAnalyzer {
  private baseline: VideoSignature | null = null;
  private pending: PendingTrackSwitch | null = null;

  reset(): void {
    this.baseline = null;
    this.pending = null;
  }

  observe(observation: FragmentTrackObservation): AdCandidate | null {
    if (!validObservation(observation)) return null;

    const signature = {
      width: observation.width,
      height: observation.height,
    };

    if (!this.baseline) {
      this.baseline = signature;
      return null;
    }

    if (!this.pending) {
      if (sameSignature(signature, this.baseline)) return null;

      this.pending = {
        baseline: this.baseline,
        changed: signature,
        start: observation.start,
        manifestUrl: observation.manifestUrl,
        segmentUris: observation.uri ? [observation.uri] : [],
      };
      return null;
    }

    if (sameSignature(signature, this.pending.changed)) {
      if (
        observation.uri &&
        !this.pending.segmentUris.includes(observation.uri)
      ) {
        this.pending.segmentUris.push(observation.uri);
      }
      return null;
    }

    if (!sameSignature(signature, this.pending.baseline)) {
      this.baseline = signature;
      this.pending = null;
      return null;
    }

    const pending = this.pending;
    const end = observation.start;
    const duration = end - pending.start;
    this.baseline = signature;
    this.pending = null;

    if (duration <= 0 || duration > MAX_TEMPORARY_SWITCH_DURATION) {
      return null;
    }

    return {
      id: candidateId(pending.start, end),
      start: pending.start,
      end,
      duration,
      confidence: 0.85,
      evidence: [
        {
          type: 'discontinuity',
          weight: 0.3,
          message: 'Short range is enclosed by parsed HLS track changes',
        },
        {
          type: 'resolution-switch',
          weight: 0.78,
          message: `Video dimensions temporarily change from ${pending.baseline.width}x${pending.baseline.height} to ${pending.changed.width}x${pending.changed.height} and then return`,
        },
      ],
      manifestUrl: pending.manifestUrl || observation.manifestUrl,
      segmentUris: pending.segmentUris,
    };
  }
}
