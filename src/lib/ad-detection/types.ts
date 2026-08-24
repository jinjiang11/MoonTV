export type AdEvidenceType =
  | 'cue'
  | 'date-range'
  | 'discontinuity'
  | 'host-switch'
  | 'path-switch'
  | 'key-switch'
  | 'map-switch'
  | 'uri-keyword'
  | 'resolution-switch'
  | 'codec-switch';

export interface AdEvidence {
  type: AdEvidenceType;
  weight: number;
  message: string;
  line?: number;
}

export interface AdCandidate {
  id: string;
  start: number;
  end: number;
  duration: number;
  confidence: number;
  evidence: AdEvidence[];
  manifestUrl?: string;
  segmentUris: string[];
}

export interface HlsAdAnalysis {
  candidates: AdCandidate[];
  segmentCount: number;
  manifestUrl?: string;
}
