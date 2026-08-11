export interface ParsedEpisodeList {
  episodes: string[];
  episodeNames: string[];
}

/**
 * Parse the first play source from the Apple CMS `vod_play_url` format:
 * `name$url#name$url$$$other-source`.
 *
 * Names and URLs are kept in aligned arrays so filtering malformed entries
 * cannot shift a name onto the wrong episode.
 */
export function parseVodPlayEpisodes(vodPlayUrl?: string): ParsedEpisodeList {
  const episodes: string[] = [];
  const episodeNames: string[] = [];
  if (!vodPlayUrl) return { episodes, episodeNames };

  const mainSource = vodPlayUrl.split('$$$')[0];
  if (!mainSource) return { episodes, episodeNames };

  mainSource.split('#').forEach((entry) => {
    const separatorIndex = entry.indexOf('$');
    if (separatorIndex < 0) return;

    const name = entry.slice(0, separatorIndex).trim();
    const url = entry.slice(separatorIndex + 1).trim();
    if (!url.startsWith('http://') && !url.startsWith('https://')) return;

    episodeNames.push(name);
    episodes.push(url);
  });

  return { episodes, episodeNames };
}
