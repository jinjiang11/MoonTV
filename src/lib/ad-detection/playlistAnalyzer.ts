import { AdCandidate, AdEvidence, HlsAdAnalysis } from './types';

interface ParsedSegment {
  uri: string;
  absoluteUri: string;
  start: number;
  end: number;
  duration: number;
  line: number;
  discontinuityBefore: boolean;
  keyUri?: string;
  mapUri?: string;
}

interface OpenCue {
  start: number;
  duration?: number;
  line: number;
}

const AD_TEXT_PATTERN =
  /(^|[\s/_.?=&-])(ad(?:s|vert(?:isement|ising)?)?|commercial|interstitial|midroll|postroll|preroll|promo|sponsor)(?=$|[\s/_.?=&-])/i;

const MIN_CANDIDATE_CONFIDENCE = 0.5;
const MAX_HEURISTIC_DURATION = 180;

function parseDuration(value: string): number | undefined {
  const match = value.match(/(?:^|DURATION=)(\d+(?:\.\d+)?)/i);
  if (!match) return undefined;

  const duration = Number(match[1]);
  return Number.isFinite(duration) && duration > 0 ? duration : undefined;
}

function parseAttributeList(value: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const pattern = /([A-Z0-9-]+)=("(?:[^"\\]|\\.)*"|[^,]*)/gi;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(value)) !== null) {
    const rawValue = match[2].trim();
    attributes[match[1].toUpperCase()] = rawValue.startsWith('"')
      ? rawValue.slice(1, -1)
      : rawValue;
  }

  return attributes;
}

function resolveUri(uri: string, manifestUrl?: string): string {
  if (!manifestUrl) return uri;

  try {
    return new URL(uri, manifestUrl).toString();
  } catch (_) {
    return uri;
  }
}

function getHost(uri: string): string {
  try {
    return new URL(uri).host.toLowerCase();
  } catch (_) {
    return '';
  }
}

function getDirectory(uri: string): string {
  try {
    const url = new URL(uri);
    const slash = url.pathname.lastIndexOf('/');
    return `${url.host.toLowerCase()}${url.pathname.slice(0, slash + 1)}`;
  } catch (_) {
    const slash = uri.lastIndexOf('/');
    return uri.slice(0, slash + 1);
  }
}

function confidenceFor(evidence: AdEvidence[]): number {
  const remaining = evidence.reduce(
    (value, item) => value * (1 - Math.min(Math.max(item.weight, 0), 1)),
    1
  );
  return Math.round((1 - remaining) * 1000) / 1000;
}

function candidateId(start: number, end: number): string {
  return `hls-${Math.round(start * 1000)}-${Math.round(end * 1000)}`;
}

function buildCandidate(
  start: number,
  end: number,
  evidence: AdEvidence[],
  segments: ParsedSegment[],
  manifestUrl?: string
): AdCandidate | null {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return null;
  }

  const confidence = confidenceFor(evidence);
  if (confidence < MIN_CANDIDATE_CONFIDENCE) return null;

  return {
    id: candidateId(start, end),
    start,
    end,
    duration: end - start,
    confidence,
    evidence,
    manifestUrl,
    segmentUris: segments.map((segment) => segment.absoluteUri),
  };
}

function sameValueOutsideDifferentInside(
  before: string | undefined,
  inside: Array<string | undefined>,
  after: string | undefined
): boolean {
  if (!before || !after || before !== after || inside.length === 0) {
    return false;
  }

  return inside.every((value) => Boolean(value) && value !== before);
}

function mergeCandidates(candidates: AdCandidate[]): AdCandidate[] {
  const byId = new Map<string, AdCandidate>();

  candidates.forEach((candidate) => {
    const existing = byId.get(candidate.id);
    if (!existing) {
      byId.set(candidate.id, candidate);
      return;
    }

    const evidenceByType = new Map(
      existing.evidence.map((evidence) => [evidence.type, evidence])
    );
    candidate.evidence.forEach((evidence) => {
      const previous = evidenceByType.get(evidence.type);
      if (!previous || evidence.weight > previous.weight) {
        evidenceByType.set(evidence.type, evidence);
      }
    });

    const evidence = Array.from(evidenceByType.values());
    byId.set(candidate.id, {
      ...existing,
      confidence: confidenceFor(evidence),
      evidence,
      segmentUris: Array.from(
        new Set([...existing.segmentUris, ...candidate.segmentUris])
      ),
    });
  });

  return Array.from(byId.values()).sort((a, b) => a.start - b.start);
}

/**
 * Analyze an HLS media playlist without changing its contents.
 *
 * The result is intentionally conservative: explicit ad cues are reported
 * directly, while discontinuities only become candidates when another signal
 * (such as a temporary host/path/key change) supports them.
 */
export function analyzeHlsManifest(
  manifest: string,
  manifestUrl?: string
): HlsAdAnalysis {
  if (!manifest || !manifest.includes('#EXTM3U')) {
    return { candidates: [], segmentCount: 0, manifestUrl };
  }

  const lines = manifest.split(/\r?\n/);
  const segments: ParsedSegment[] = [];
  const candidates: AdCandidate[] = [];
  const discontinuityIndexes: number[] = [];

  let currentTime = 0;
  let pendingDuration: number | undefined;
  let pendingDiscontinuity = false;
  let currentKeyUri: string | undefined;
  let currentMapUri: string | undefined;
  let openCue: OpenCue | null = null;

  lines.forEach((rawLine, index) => {
    const line = rawLine.trim();
    const lineNumber = index + 1;
    if (!line) return;

    if (line.startsWith('#EXTINF:')) {
      pendingDuration = parseDuration(line.slice('#EXTINF:'.length));
      return;
    }

    if (line === '#EXT-X-DISCONTINUITY') {
      pendingDiscontinuity = true;
      return;
    }

    if (line.startsWith('#EXT-X-KEY:')) {
      const attributes = parseAttributeList(line.slice('#EXT-X-KEY:'.length));
      currentKeyUri = attributes.URI
        ? resolveUri(attributes.URI, manifestUrl)
        : undefined;
      return;
    }

    if (line.startsWith('#EXT-X-MAP:')) {
      const attributes = parseAttributeList(line.slice('#EXT-X-MAP:'.length));
      currentMapUri = attributes.URI
        ? resolveUri(attributes.URI, manifestUrl)
        : undefined;
      return;
    }

    if (line === '#EXT-X-CUE-OUT' || line.startsWith('#EXT-X-CUE-OUT:')) {
      openCue = {
        start: currentTime,
        duration: parseDuration(line.split(':').slice(1).join(':')),
        line: lineNumber,
      };
      return;
    }

    if (line.startsWith('#EXT-X-CUE-IN') && openCue) {
      const closedCue = openCue;
      const candidate = buildCandidate(
        closedCue.start,
        currentTime,
        [
          {
            type: 'cue',
            weight: 0.98,
            message: 'HLS cue-out/cue-in advertising range',
            line: closedCue.line,
          },
        ],
        segments.filter(
          (segment) =>
            segment.start >= closedCue.start && segment.end <= currentTime
        ),
        manifestUrl
      );
      if (candidate) candidates.push(candidate);
      openCue = null;
      return;
    }

    if (line.startsWith('#EXT-X-DATERANGE:')) {
      const attributes = parseAttributeList(
        line.slice('#EXT-X-DATERANGE:'.length)
      );
      const description = [
        attributes.CLASS,
        attributes.ID,
        attributes['X-ASSET-URI'],
      ]
        .filter(Boolean)
        .join(' ');
      const hasScte = Boolean(
        attributes['SCTE35-OUT'] || attributes['SCTE35-IN']
      );
      const isAdRange = hasScte || AD_TEXT_PATTERN.test(description);
      const duration = parseDuration(
        attributes.DURATION ||
          attributes['PLANNED-DURATION'] ||
          attributes['X-ASSET-DURATION'] ||
          ''
      );

      if (isAdRange && duration) {
        const candidate = buildCandidate(
          currentTime,
          currentTime + duration,
          [
            {
              type: 'date-range',
              weight: hasScte ? 0.98 : 0.92,
              message: hasScte
                ? 'SCTE-35 advertising date range'
                : 'HLS advertising/interstitial date range',
              line: lineNumber,
            },
          ],
          [],
          manifestUrl
        );
        if (candidate) candidates.push(candidate);
      }
      return;
    }

    if (line.startsWith('#') || pendingDuration === undefined) return;

    const segment: ParsedSegment = {
      uri: line,
      absoluteUri: resolveUri(line, manifestUrl),
      start: currentTime,
      end: currentTime + pendingDuration,
      duration: pendingDuration,
      line: lineNumber,
      discontinuityBefore: pendingDiscontinuity,
      keyUri: currentKeyUri,
      mapUri: currentMapUri,
    };

    if (pendingDiscontinuity) discontinuityIndexes.push(segments.length);
    segments.push(segment);
    currentTime = segment.end;
    pendingDuration = undefined;
    pendingDiscontinuity = false;
  });

  // TypeScript does not track assignments made inside Array#forEach, so keep
  // an explicit post-parse view of a cue that remained open at end-of-file.
  const remainingCue = openCue as OpenCue | null;
  if (remainingCue?.duration) {
    const cueEnd = Math.min(
      remainingCue.start + remainingCue.duration,
      currentTime
    );
    const candidate = buildCandidate(
      remainingCue.start,
      cueEnd,
      [
        {
          type: 'cue',
          weight: 0.95,
          message: 'HLS cue-out advertising range with declared duration',
          line: remainingCue.line,
        },
      ],
      segments.filter(
        (segment) =>
          segment.start >= remainingCue.start && segment.end <= cueEnd
      ),
      manifestUrl
    );
    if (candidate) candidates.push(candidate);
  }

  // URI keywords can identify ad runs even when a provider omits cue metadata.
  let keywordRunStart = -1;
  for (let index = 0; index <= segments.length; index++) {
    const isKeywordSegment =
      index < segments.length &&
      AD_TEXT_PATTERN.test(segments[index].absoluteUri);

    if (isKeywordSegment && keywordRunStart === -1) keywordRunStart = index;
    if (
      (!isKeywordSegment || index === segments.length) &&
      keywordRunStart !== -1
    ) {
      const run = segments.slice(keywordRunStart, index);
      const candidate = buildCandidate(
        run[0].start,
        run[run.length - 1].end,
        [
          {
            type: 'uri-keyword',
            weight: 0.72,
            message: 'Segment URL contains an advertising indicator',
            line: run[0].line,
          },
        ],
        run,
        manifestUrl
      );
      if (candidate) candidates.push(candidate);
      keywordRunStart = -1;
    }
  }

  // Analyze ranges enclosed by discontinuities. A discontinuity alone is not
  // sufficient evidence; the content inside must temporarily change origin,
  // directory, encryption key, init map, or contain an ad-like URL.
  for (
    let boundary = 0;
    boundary < discontinuityIndexes.length - 1;
    boundary++
  ) {
    const startIndex = discontinuityIndexes[boundary];
    const endIndex = discontinuityIndexes[boundary + 1];
    const run = segments.slice(startIndex, endIndex);
    const before = segments[startIndex - 1];
    const after = segments[endIndex];
    if (!before || !after || run.length === 0) continue;

    const duration = run[run.length - 1].end - run[0].start;
    if (duration > MAX_HEURISTIC_DURATION) continue;

    const evidence: AdEvidence[] = [
      {
        type: 'discontinuity',
        weight: 0.3,
        message: 'Short range is enclosed by HLS discontinuities',
        line: run[0].line,
      },
    ];

    if (
      sameValueOutsideDifferentInside(
        getHost(before.absoluteUri),
        run.map((segment) => getHost(segment.absoluteUri)),
        getHost(after.absoluteUri)
      )
    ) {
      evidence.push({
        type: 'host-switch',
        weight: 0.48,
        message: 'Segment host changes temporarily and then returns',
        line: run[0].line,
      });
    }

    if (
      sameValueOutsideDifferentInside(
        getDirectory(before.absoluteUri),
        run.map((segment) => getDirectory(segment.absoluteUri)),
        getDirectory(after.absoluteUri)
      )
    ) {
      evidence.push({
        type: 'path-switch',
        weight: 0.34,
        message: 'Segment directory changes temporarily and then returns',
        line: run[0].line,
      });
    }

    if (
      sameValueOutsideDifferentInside(
        before.keyUri,
        run.map((segment) => segment.keyUri),
        after.keyUri
      )
    ) {
      evidence.push({
        type: 'key-switch',
        weight: 0.3,
        message: 'Encryption key changes temporarily and then returns',
        line: run[0].line,
      });
    }

    if (
      sameValueOutsideDifferentInside(
        before.mapUri,
        run.map((segment) => segment.mapUri),
        after.mapUri
      )
    ) {
      evidence.push({
        type: 'map-switch',
        weight: 0.3,
        message:
          'Media initialization map changes temporarily and then returns',
        line: run[0].line,
      });
    }

    if (run.some((segment) => AD_TEXT_PATTERN.test(segment.absoluteUri))) {
      evidence.push({
        type: 'uri-keyword',
        weight: 0.72,
        message: 'Segment URL contains an advertising indicator',
        line: run[0].line,
      });
    }

    const candidate = buildCandidate(
      run[0].start,
      run[run.length - 1].end,
      evidence,
      run,
      manifestUrl
    );
    if (candidate) candidates.push(candidate);
  }

  return {
    candidates: mergeCandidates(candidates),
    segmentCount: segments.length,
    manifestUrl,
  };
}

export function mergeAdCandidates(
  existing: AdCandidate[],
  incoming: AdCandidate[]
): AdCandidate[] {
  return mergeCandidates([...existing, ...incoming]);
}
