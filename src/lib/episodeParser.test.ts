import {
  parseBestVodPlayEpisodes,
  parseVodPlayEpisodes,
} from './episodeParser';

describe('parseVodPlayEpisodes', () => {
  it('preserves names and URLs from the first play source', () => {
    const result = parseVodPlayEpisodes(
      '预告$https://cdn.example/preview.m3u8#第一集$https://cdn.example/1.m3u8$$$备用$https://backup.example/1.m3u8'
    );

    expect(result).toEqual({
      episodes: [
        'https://cdn.example/preview.m3u8',
        'https://cdn.example/1.m3u8',
      ],
      episodeNames: ['预告', '第一集'],
    });
  });

  it('preserves dollar signs that occur inside a URL', () => {
    const result = parseVodPlayEpisodes(
      '大结局$https://cdn.example/final.m3u8?token=a$b'
    );

    expect(result.episodes).toEqual([
      'https://cdn.example/final.m3u8?token=a$b',
    ]);
    expect(result.episodeNames).toEqual(['大结局']);
  });

  it('keeps names aligned when malformed entries are filtered out', () => {
    const result = parseVodPlayEpisodes(
      '第一集$https://cdn.example/1.m3u8#损坏$not-a-url#第三集$https://cdn.example/3.m3u8'
    );

    expect(result.episodes).toHaveLength(2);
    expect(result.episodeNames).toEqual(['第一集', '第三集']);
  });

  it('returns empty arrays when no play data is available', () => {
    expect(parseVodPlayEpisodes()).toEqual({
      episodes: [],
      episodeNames: [],
    });
  });
});

describe('parseBestVodPlayEpisodes', () => {
  it('keeps names from the play source with the most valid episodes', () => {
    const result = parseBestVodPlayEpisodes(
      '正片$https://first.example/1.m3u8$$$第1集$https://second.example/1.m3u8#第2集$https://second.example/2.m3u8'
    );

    expect(result).toEqual({
      episodes: [
        'https://second.example/1.m3u8',
        'https://second.example/2.m3u8',
      ],
      episodeNames: ['第1集', '第2集'],
    });
  });
});
