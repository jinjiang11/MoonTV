import { AdCandidate } from './types';

export interface FragmentCodecObservation {
  start: number;
  duration: number;
  fingerprint: string;
  uri?: string;
  manifestUrl?: string;
}

interface PendingCodecSwitch {
  baseline: string;
  changed: string;
  start: number;
  manifestUrl?: string;
  observationCount: number;
  segmentUris: string[];
}

const MAX_TEMPORARY_SWITCH_DURATION = 180;
const MIN_CHANGED_OBSERVATIONS = 2;

function validObservation(
  observation: FragmentCodecObservation
): observation is FragmentCodecObservation {
  return (
    Number.isFinite(observation.start) &&
    observation.start >= 0 &&
    Number.isFinite(observation.duration) &&
    observation.duration > 0 &&
    Boolean(observation.fingerprint)
  );
}

function candidateId(start: number, end: number): string {
  return `hls-${Math.round(start * 1000)}-${Math.round(end * 1000)}`;
}

/**
 * Detect a short, temporary H.264 encoder configuration change. This catches
 * inserted clips that retain the programme's dimensions and playlist path but
 * were encoded separately before the stream returns to its original SPS/PPS.
 */
export class FragmentCodecAnalyzer {
  private baseline: string | null = null;
  private pending: PendingCodecSwitch | null = null;

  reset(): void {
    this.baseline = null;
    this.pending = null;
  }

  observe(observation: FragmentCodecObservation): AdCandidate | null {
    if (!validObservation(observation)) return null;

    if (!this.baseline) {
      this.baseline = observation.fingerprint;
      return null;
    }

    if (!this.pending) {
      if (observation.fingerprint === this.baseline) return null;

      this.pending = {
        baseline: this.baseline,
        changed: observation.fingerprint,
        start: observation.start,
        manifestUrl: observation.manifestUrl,
        observationCount: 1,
        segmentUris: observation.uri ? [observation.uri] : [],
      };
      return null;
    }

    if (observation.fingerprint === this.pending.changed) {
      this.pending.observationCount++;
      if (
        observation.uri &&
        !this.pending.segmentUris.includes(observation.uri)
      ) {
        this.pending.segmentUris.push(observation.uri);
      }
      return null;
    }

    if (observation.fingerprint !== this.pending.baseline) {
      this.baseline = observation.fingerprint;
      this.pending = null;
      return null;
    }

    const pending = this.pending;
    const end = observation.start;
    const duration = end - pending.start;
    this.baseline = observation.fingerprint;
    this.pending = null;

    if (
      duration <= 0 ||
      duration > MAX_TEMPORARY_SWITCH_DURATION ||
      pending.observationCount < MIN_CHANGED_OBSERVATIONS
    ) {
      return null;
    }

    return {
      id: candidateId(pending.start, end),
      start: pending.start,
      end,
      duration,
      confidence: 0.82,
      evidence: [
        {
          type: 'codec-switch',
          weight: 0.82,
          message:
            'H.264 encoder configuration temporarily changes and then returns',
        },
      ],
      manifestUrl: pending.manifestUrl || observation.manifestUrl,
      segmentUris: pending.segmentUris,
    };
  }
}
