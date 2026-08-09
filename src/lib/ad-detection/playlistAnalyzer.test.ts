import { analyzeHlsManifest, mergeAdCandidates } from './playlistAnalyzer';

const header = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n';

describe('analyzeHlsManifest', () => {
  it('does not flag a clean playlist or mutate its contents', () => {
    const manifest = `${header}#EXTINF:6,\nvideo/001.ts\n#EXTINF:6,\nvideo/002.ts\n`;

    const analysis = analyzeHlsManifest(
      manifest,
      'https://media.example.com/show/index.m3u8'
    );

    expect(analysis.segmentCount).toBe(2);
    expect(analysis.candidates).toEqual([]);
    expect(manifest).toContain('video/001.ts');
  });

  it('detects an explicit cue-out/cue-in range', () => {
    const manifest = `${header}#EXTINF:6,\ncontent/001.ts\n#EXT-X-CUE-OUT:12\n#EXTINF:6,\nads/001.ts\n#EXTINF:6,\nads/002.ts\n#EXT-X-CUE-IN\n#EXTINF:6,\ncontent/002.ts\n`;

    const [candidate] = analyzeHlsManifest(
      manifest,
      'https://media.example.com/show/index.m3u8'
    ).candidates;

    expect(candidate.start).toBe(6);
    expect(candidate.end).toBe(18);
    expect(candidate.confidence).toBeGreaterThanOrEqual(0.95);
    expect(candidate.evidence.map((item) => item.type)).toContain('cue');
  });

  it('detects an advertising date range with a duration', () => {
    const manifest = `${header}#EXTINF:6,\ncontent/001.ts\n#EXT-X-DATERANGE:ID="ad-1",CLASS="com.apple.hls.interstitial",DURATION=15\n#EXTINF:6,\ncontent/002.ts\n`;

    const [candidate] = analyzeHlsManifest(manifest).candidates;

    expect(candidate.start).toBe(6);
    expect(candidate.end).toBe(21);
    expect(candidate.evidence.map((item) => item.type)).toContain('date-range');
  });

  it('detects a short host island enclosed by discontinuities', () => {
    const manifest = `${header}#EXTINF:6,\nhttps://content.example/show/001.ts\n#EXT-X-DISCONTINUITY\n#EXTINF:5,\nhttps://ads.example/campaign/001.ts\n#EXTINF:5,\nhttps://ads.example/campaign/002.ts\n#EXT-X-DISCONTINUITY\n#EXTINF:6,\nhttps://content.example/show/002.ts\n`;

    const [candidate] = analyzeHlsManifest(manifest).candidates;

    expect(candidate.start).toBe(6);
    expect(candidate.end).toBe(16);
    expect(candidate.evidence.map((item) => item.type)).toEqual(
      expect.arrayContaining(['discontinuity', 'host-switch'])
    );
  });

  it('does not flag ordinary discontinuities without supporting evidence', () => {
    const manifest = `${header}#EXTINF:6,\nshow/001.ts\n#EXT-X-DISCONTINUITY\n#EXTINF:6,\nshow/002.ts\n#EXT-X-DISCONTINUITY\n#EXTINF:6,\nshow/003.ts\n`;

    expect(
      analyzeHlsManifest(manifest, 'https://media.example.com/index.m3u8')
        .candidates
    ).toEqual([]);
  });

  it('merges duplicate candidates from variant playlists', () => {
    const manifest = `${header}#EXT-X-CUE-OUT:6\n#EXTINF:6,\nads/001.ts\n#EXT-X-CUE-IN\n`;
    const first = analyzeHlsManifest(
      manifest,
      'https://media.example.com/720p.m3u8'
    ).candidates;
    const second = analyzeHlsManifest(
      manifest,
      'https://media.example.com/1080p.m3u8'
    ).candidates;

    expect(mergeAdCandidates(first, second)).toHaveLength(1);
  });
});
