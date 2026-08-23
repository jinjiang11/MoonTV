/* eslint-disable @typescript-eslint/no-explicit-any,no-console */

import he from 'he';
import Hls from 'hls.js';

/**
 * 获取图片代理 URL 设置
 */
export function getImageProxyUrl(): string | null {
  if (typeof window === 'undefined') return null;

  // 本地未开启图片代理，则不使用代理
  const enableImageProxy = localStorage.getItem('enableImageProxy');
  if (enableImageProxy !== null) {
    if (!JSON.parse(enableImageProxy) as boolean) {
      return null;
    }
  }

  const localImageProxy = localStorage.getItem('imageProxyUrl');
  if (localImageProxy != null) {
    return localImageProxy.trim() ? localImageProxy.trim() : null;
  }

  // 如果未设置，则使用全局对象
  const serverImageProxy = (window as any).RUNTIME_CONFIG?.IMAGE_PROXY;
  return serverImageProxy && serverImageProxy.trim()
    ? serverImageProxy.trim()
    : null;
}

/**
 * 处理图片 URL，如果设置了图片代理则使用代理
 */
export function processImageUrl(originalUrl: string): string {
  if (!originalUrl) return originalUrl;

  const proxyUrl = getImageProxyUrl();
  if (!proxyUrl) return originalUrl;

  return `${proxyUrl}${encodeURIComponent(originalUrl)}`;
}

/**
 * 获取豆瓣代理 URL 设置
 */
export function getDoubanProxyUrl(): string | null {
  if (typeof window === 'undefined') return null;

  // 本地未开启豆瓣代理，则不使用代理
  const enableDoubanProxy = localStorage.getItem('enableDoubanProxy');
  if (enableDoubanProxy !== null) {
    if (!JSON.parse(enableDoubanProxy) as boolean) {
      return null;
    }
  }

  const localDoubanProxy = localStorage.getItem('doubanProxyUrl');
  if (localDoubanProxy != null) {
    return localDoubanProxy.trim() ? localDoubanProxy.trim() : null;
  }

  // 如果未设置，则使用全局对象
  const serverDoubanProxy = (window as any).RUNTIME_CONFIG?.DOUBAN_PROXY;
  return serverDoubanProxy && serverDoubanProxy.trim()
    ? serverDoubanProxy.trim()
    : null;
}

/**
 * 处理豆瓣 URL，如果设置了豆瓣代理则使用代理
 */
export function processDoubanUrl(originalUrl: string): string {
  if (!originalUrl) return originalUrl;

  const proxyUrl = getDoubanProxyUrl();
  if (!proxyUrl) return originalUrl;

  return `${proxyUrl}${encodeURIComponent(originalUrl)}`;
}

export function cleanHtmlTags(text: string): string {
  if (!text) return '';

  const cleanedText = text
    .replace(/<[^>]+>/g, '\n') // 将 HTML 标签替换为换行
    .replace(/\n+/g, '\n') // 将多个连续换行合并为一个
    .replace(/[ \t]+/g, ' ') // 将多个连续空格和制表符合并为一个空格，但保留换行符
    .replace(/^\n+|\n+$/g, '') // 去掉首尾换行
    .trim(); // 去掉首尾空格

  // 使用 he 库解码 HTML 实体
  return he.decode(cleanedText);
}

/**
 * 从m3u8地址获取视频质量等级和网络信息
 * @param m3u8Url m3u8播放列表的URL
 * @returns Promise<{quality: string, loadSpeed: string, pingTime: number}> 视频质量等级和网络信息
 */
interface VideoResolutionInfo {
  quality: string; // 如720p、1080p等
  loadSpeed: string; // 自动转换为KB/s或MB/s
  pingTime: number; // 网络延迟（毫秒）
}

export function getVideoQualityFromWidth(width: number): string {
  return width >= 3840
    ? '4K'
    : width >= 2560
    ? '2K'
    : width >= 1920
    ? '1080p'
    : width >= 1280
    ? '720p'
    : width >= 854
    ? '480p'
    : 'SD';
}

export function getHighestHlsManifestWidth(manifest: string): number | null {
  if (!manifest.includes('#EXTM3U')) return null;

  let highestWidth = 0;
  const resolutionPattern = /(?:^|,)\s*RESOLUTION\s*=\s*(\d+)x(\d+)/gim;
  let match: RegExpExecArray | null;

  while ((match = resolutionPattern.exec(manifest)) !== null) {
    const width = Number(match[1]);
    if (Number.isFinite(width) && width > highestWidth) {
      highestWidth = width;
    }
  }

  return highestWidth > 0 ? highestWidth : null;
}

function formatLoadSpeed(byteLength: number, elapsedMs: number): string {
  if (byteLength <= 0 || elapsedMs <= 0) return '未知';

  const speedKBps = byteLength / 1024 / (elapsedMs / 1000);
  return speedKBps >= 1024
    ? `${(speedKBps / 1024).toFixed(1)} MB/s`
    : `${speedKBps.toFixed(1)} KB/s`;
}

function getVideoResolutionWithNativeHls(
  m3u8Url: string
): Promise<VideoResolutionInfo> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    const abortController = new AbortController();
    const startedAt = performance.now();
    let pingTime = 0;
    let loadSpeed = '未知';
    let settled = false;
    let nativeWidth = 0;
    let manifestRequestFinished = false;

    video.muted = true;
    video.preload = 'metadata';
    video.playsInline = true;
    video.disableRemotePlayback = true;
    video.setAttribute('disableRemotePlayback', '');
    video.setAttribute('x-webkit-airplay', 'deny');

    const cleanup = () => {
      clearTimeout(timeout);
      abortController.abort();
      video.removeAttribute('src');
      video.load();
      video.remove();
    };

    const finish = (width: number) => {
      if (settled || !Number.isFinite(width) || width <= 0) return;
      settled = true;
      cleanup();
      resolve({
        quality: getVideoQualityFromWidth(width),
        loadSpeed,
        pingTime: Math.round(pingTime),
      });
    };

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('Timeout loading native HLS metadata'));
    }, 5000);

    video.onloadedmetadata = () => {
      nativeWidth = video.videoWidth;
      if (manifestRequestFinished) finish(nativeWidth);
    };
    video.onerror = () => {
      // Playlist parsing can still provide a resolution after native metadata
      // loading fails, so wait for it or the shared timeout.
    };

    fetch(m3u8Url, {
      method: 'GET',
      cache: 'no-store',
      signal: abortController.signal,
    })
      .then(async (response) => {
        pingTime = performance.now() - startedAt;
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const manifest = await response.text();
        const elapsedMs = performance.now() - startedAt;
        loadSpeed = formatLoadSpeed(
          new TextEncoder().encode(manifest).length,
          elapsedMs
        );
        const manifestWidth = getHighestHlsManifestWidth(manifest);
        manifestRequestFinished = true;
        if (manifestWidth) {
          finish(manifestWidth);
        } else {
          finish(nativeWidth);
        }
      })
      .catch((error) => {
        if (error instanceof Error && error.name === 'AbortError') return;
        pingTime = performance.now() - startedAt;
        manifestRequestFinished = true;
        finish(nativeWidth);
      });

    video.src = m3u8Url;
    video.load();
  });
}

export async function getVideoResolutionFromM3u8(
  m3u8Url: string
): Promise<VideoResolutionInfo> {
  try {
    const userAgent =
      typeof navigator !== 'undefined' ? navigator.userAgent : '';
    const isAppleWebKit =
      /AppleWebKit/i.test(userAgent) &&
      !/(Chrome|Chromium|Edg|OPR|SamsungBrowser)/i.test(userAgent);
    const nativeHlsVideo = document.createElement('video');

    if (
      isAppleWebKit &&
      nativeHlsVideo.canPlayType('application/vnd.apple.mpegurl')
    ) {
      return getVideoResolutionWithNativeHls(m3u8Url);
    }

    // 直接使用m3u8 URL作为视频源，避免CORS问题
    return new Promise((resolve, reject) => {
      const video = document.createElement('video');
      video.muted = true;
      video.preload = 'metadata';

      // 测量网络延迟（ping时间） - 使用m3u8 URL而不是ts文件
      const pingStart = performance.now();
      let pingTime = 0;

      // 测量ping时间（使用m3u8 URL）
      fetch(m3u8Url, { method: 'HEAD', mode: 'no-cors' })
        .then(() => {
          pingTime = performance.now() - pingStart;
        })
        .catch(() => {
          pingTime = performance.now() - pingStart; // 记录到失败为止的时间
        });

      // 固定使用hls.js加载
      const hls = new Hls();

      // 设置超时处理
      const timeout = setTimeout(() => {
        hls.destroy();
        video.remove();
        reject(new Error('Timeout loading video metadata'));
      }, 4000);

      video.onerror = () => {
        clearTimeout(timeout);
        hls.destroy();
        video.remove();
        reject(new Error('Failed to load video metadata'));
      };

      let actualLoadSpeed = '未知';
      let hasSpeedCalculated = false;
      let hasMetadataLoaded = false;

      let fragmentStartTime = 0;

      // 检查是否可以返回结果
      const checkAndResolve = () => {
        if (
          hasMetadataLoaded &&
          (hasSpeedCalculated || actualLoadSpeed !== '未知')
        ) {
          clearTimeout(timeout);
          const width = video.videoWidth;
          if (width && width > 0) {
            hls.destroy();
            video.remove();

            resolve({
              quality: getVideoQualityFromWidth(width),
              loadSpeed: actualLoadSpeed,
              pingTime: Math.round(pingTime),
            });
          } else {
            // webkit 无法获取尺寸，直接返回
            resolve({
              quality: '未知',
              loadSpeed: actualLoadSpeed,
              pingTime: Math.round(pingTime),
            });
          }
        }
      };

      // 监听片段加载开始
      hls.on(Hls.Events.FRAG_LOADING, () => {
        fragmentStartTime = performance.now();
      });

      // 监听片段加载完成，只需首个分片即可计算速度
      hls.on(Hls.Events.FRAG_LOADED, (event: any, data: any) => {
        if (
          fragmentStartTime > 0 &&
          data &&
          data.payload &&
          !hasSpeedCalculated
        ) {
          const loadTime = performance.now() - fragmentStartTime;
          const size = data.payload.byteLength || 0;

          if (loadTime > 0 && size > 0) {
            const speedKBps = size / 1024 / (loadTime / 1000);

            // 立即计算速度，无需等待更多分片
            const avgSpeedKBps = speedKBps;

            if (avgSpeedKBps >= 1024) {
              actualLoadSpeed = `${(avgSpeedKBps / 1024).toFixed(1)} MB/s`;
            } else {
              actualLoadSpeed = `${avgSpeedKBps.toFixed(1)} KB/s`;
            }
            hasSpeedCalculated = true;
            checkAndResolve(); // 尝试返回结果
          }
        }
      });

      hls.loadSource(m3u8Url);
      hls.attachMedia(video);

      // 监听hls.js错误
      hls.on(Hls.Events.ERROR, (event: any, data: any) => {
        console.error('HLS错误:', data);
        if (data.fatal) {
          clearTimeout(timeout);
          hls.destroy();
          video.remove();
          reject(new Error(`HLS播放失败: ${data.type}`));
        }
      });

      // 监听视频元数据加载完成
      video.onloadedmetadata = () => {
        hasMetadataLoaded = true;
        checkAndResolve(); // 尝试返回结果
      };
    });
  } catch (error) {
    throw new Error(
      `Error getting video resolution: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}
