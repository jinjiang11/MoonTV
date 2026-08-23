import { getHighestHlsManifestWidth, getVideoQualityFromWidth } from './utils';

describe('HLS resolution helpers', () => {
  it('reads the highest resolution from a multivariant playlist', () => {
    const manifest = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=1280x720
720p/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1800000,RESOLUTION=1920x1080
1080p/index.m3u8
`;

    expect(getHighestHlsManifestWidth(manifest)).toBe(1920);
  });

  it('returns null for media playlists without declared dimensions', () => {
    const manifest = `#EXTM3U
#EXTINF:4,
segment-1.ts
`;

    expect(getHighestHlsManifestWidth(manifest)).toBeNull();
  });

  it('uses the existing quality thresholds', () => {
    expect(getVideoQualityFromWidth(3840)).toBe('4K');
    expect(getVideoQualityFromWidth(2560)).toBe('2K');
    expect(getVideoQualityFromWidth(1920)).toBe('1080p');
    expect(getVideoQualityFromWidth(1280)).toBe('720p');
    expect(getVideoQualityFromWidth(854)).toBe('480p');
    expect(getVideoQualityFromWidth(640)).toBe('SD');
  });
});
