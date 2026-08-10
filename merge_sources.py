import argparse
import json
import os
import ssl
import socket
import logging
import time
import re
from urllib import request, parse, error
from concurrent.futures import ThreadPoolExecutor, as_completed

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
INPUT_FILES = [
    os.path.join(BASE_DIR, "config.json"),
    os.path.join(BASE_DIR, "NewSource.json"),
]
OUTPUT_FILE = os.path.join(BASE_DIR, "MergedSource.json")

USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari"
TIMEOUT = 7
MAX_WORKERS = 12
SEARCH_PATH = "?ac=videolist&wd="
SEARCH_PROBE_QUERY = os.getenv("MERGE_SEARCH_QUERY", "太平年")
M3U8_REGEX = re.compile(r"\$(https?:\/\/[^\"'\s]+?\.m3u8)")
RESOLUTION_REGEX = re.compile(r"RESOLUTION=(\d+)x(\d+)")

logger = logging.getLogger("merge_sources")


def load_json(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def normalize_url(url):
    if not isinstance(url, str) or not url:
        return ""
    parts = parse.urlsplit(url.strip())
    scheme = parts.scheme.lower()
    netloc = parts.netloc.lower()
    path = parts.path.rstrip("/")
    if not scheme or not netloc:
        return ""
    return parse.urlunsplit((scheme, netloc, path, parts.query, parts.fragment))


def _extract_episodes(vod_play_url):
    episodes = []
    if not isinstance(vod_play_url, str) or not vod_play_url:
        return episodes

    # Keep the same extraction strategy as src/lib/downstream.ts:
    # split by $$$ and select the segment with most m3u8 matches.
    for segment in vod_play_url.split("$$$"):
        matches = M3U8_REGEX.findall(segment)
        if len(matches) > len(episodes):
            episodes = matches

    cleaned = []
    seen = set()
    for link in episodes:
        paren_index = link.find("(")
        if paren_index > 0:
            link = link[:paren_index]
        if link not in seen:
            seen.add(link)
            cleaned.append(link)
    return cleaned


def _parse_search_list(items):
    parsed = []
    for item in items:
        if not isinstance(item, dict):
            continue
        vod_id = item.get("vod_id")
        vod_name = item.get("vod_name")
        if vod_id is None or vod_name is None:
            continue
        parsed.append(
            {
                "id": str(vod_id),
                "title": str(vod_name).strip(),
                "episodes": _extract_episodes(item.get("vod_play_url", "")),
                "type_name": item.get("type_name", ""),
            }
        )
    return parsed


def _quality_from_width(width):
    if width >= 3840:
        return "4K"
    if width >= 2560:
        return "2K"
    if width >= 1920:
        return "1080p"
    if width >= 1280:
        return "720p"
    if width >= 854:
        return "480p"
    if width > 0:
        return "SD"
    return "未知"


def _extract_first_episode_url(parsed_list):
    for item in parsed_list:
        episodes = item.get("episodes") or []
        if episodes:
            return episodes[0]
    return ""


def _first_non_comment_line(text):
    for line in text.splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            return line
    return ""


def _fetch_text(url, headers, ctx):
    req = request.Request(url, headers=headers, method="GET")
    with request.urlopen(req, timeout=TIMEOUT, context=ctx) as resp:
        status = getattr(resp, "status", 0)
        if not (200 <= status < 400):
            raise ValueError(f"HTTP {status}")
        return resp.read().decode("utf-8", errors="replace")


def _probe_video_info_from_m3u8(m3u8_url, headers, ctx):
    ping_start = time.perf_counter()
    playlist_text = _fetch_text(m3u8_url, headers, ctx)
    ping_time = int((time.perf_counter() - ping_start) * 1000)

    quality = "未知"
    media_playlist_url = m3u8_url

    # Master playlist: pick quality from RESOLUTION and follow the first variant URI.
    if "#EXT-X-STREAM-INF" in playlist_text:
        max_width = 0
        for match in RESOLUTION_REGEX.finditer(playlist_text):
            width = int(match.group(1))
            if width > max_width:
                max_width = width
        if max_width > 0:
            quality = _quality_from_width(max_width)

        variant_line = _first_non_comment_line(playlist_text)
        if variant_line:
            media_playlist_url = parse.urljoin(m3u8_url, variant_line)
            playlist_text = _fetch_text(media_playlist_url, headers, ctx)

    segment_line = _first_non_comment_line(playlist_text)
    if not segment_line:
        raise ValueError("no playable segment in m3u8")

    segment_url = parse.urljoin(media_playlist_url, segment_line)
    seg_headers = dict(headers)
    seg_headers["Range"] = "bytes=0-262143"
    seg_req = request.Request(segment_url, headers=seg_headers, method="GET")

    speed_start = time.perf_counter()
    with request.urlopen(seg_req, timeout=TIMEOUT, context=ctx) as seg_resp:
        status = getattr(seg_resp, "status", 0)
        if not (200 <= status < 400):
            raise ValueError(f"segment HTTP {status}")
        payload = seg_resp.read()
    elapsed = max(time.perf_counter() - speed_start, 0.001)
    size_bytes = len(payload)
    if size_bytes <= 0:
        raise ValueError("empty segment payload")

    speed_kbps = size_bytes / 1024.0 / elapsed
    if speed_kbps >= 1024:
        load_speed = f"{speed_kbps / 1024.0:.1f} MB/s"
    else:
        load_speed = f"{speed_kbps:.1f} KB/s"

    return {
        "quality": quality,
        "loadSpeed": load_speed,
        "pingTime": ping_time,
    }


def is_accessible(url):
    # Validate source by executing a real search request and parsing response JSON.
    if not url:
        return False
    req_headers = {"User-Agent": USER_AGENT, "Accept": "application/json"}
    ctx = ssl.create_default_context()
    start = time.perf_counter()
    search_url = f"{url}{SEARCH_PATH}{parse.quote(SEARCH_PROBE_QUERY)}"
    req = request.Request(search_url, headers=req_headers, method="GET")
    try:
        with request.urlopen(req, timeout=TIMEOUT, context=ctx) as resp:
            elapsed_ms = (time.perf_counter() - start) * 1000.0
            status = getattr(resp, "status", 0)
            if not (200 <= status < 400):
                logger.warning(
                    "FAIL(HTTP) %s status=%s latency=%.1f ms",
                    search_url,
                    status,
                    elapsed_ms,
                )
                return False
            raw = resp.read().decode("utf-8", errors="replace")
            data = json.loads(raw)
            if not isinstance(data, dict):
                logger.warning(
                    "FAIL(JSON) %s invalid payload type latency=%.1f ms",
                    search_url,
                    elapsed_ms,
                )
                return False
            data_list = data.get("list")
            if not isinstance(data_list, list):
                logger.warning(
                    "FAIL(JSON) %s missing list array latency=%.1f ms",
                    search_url,
                    elapsed_ms,
                )
                return False
            if len(data_list) == 0:
                logger.error(
                    "FAIL(EMPTY) %s empty list latency=%.1f ms",
                    search_url,
                    elapsed_ms,
                )
                return False

            parsed_list = _parse_search_list(data_list)
            if len(parsed_list) == 0:
                logger.error(
                    "FAIL(PARSE) %s no valid search entries latency=%.1f ms",
                    search_url,
                    elapsed_ms,
                )
                return False

            probe_episode = _extract_first_episode_url(parsed_list)
            if not probe_episode:
                logger.error(
                    "FAIL(EPISODE) %s no playable episode found latency=%.1f ms",
                    search_url,
                    elapsed_ms,
                )
                return False

            try:
                video_info = _probe_video_info_from_m3u8(
                    probe_episode,
                    req_headers,
                    ctx,
                )
            except Exception as ex:
                logger.error(
                    "FAIL(VIDEO_INFO) %s reason=%s",
                    search_url,
                    repr(ex),
                )
                return False

            logger.info(
                "OK (SEARCH+VIDEO) %s status=%s latency=%.1f ms raw=%d parsed=%d quality=%s speed=%s ping=%sms",
                search_url,
                status,
                elapsed_ms,
                len(data_list),
                len(parsed_list),
                video_info["quality"],
                video_info["loadSpeed"],
                video_info["pingTime"],
            )
            return True
    except error.HTTPError as e:
        elapsed_ms = (time.perf_counter() - start) * 1000.0
        logger.warning(
            "FAIL(HTTP) %s status=%s latency=%.1f ms",
            search_url,
            e.code,
            elapsed_ms,
        )
        return False
    except json.JSONDecodeError as ex:
        elapsed_ms = (time.perf_counter() - start) * 1000.0
        logger.warning(
            "FAIL(JSON) %s reason=%s latency=%.1f ms",
            search_url,
            repr(ex),
            elapsed_ms,
        )
        return False
    except (error.URLError, ValueError, socket.timeout, ssl.SSLError) as ex:
        elapsed_ms = (time.perf_counter() - start) * 1000.0
        logger.warning(
            "FAIL(NET)  %s reason=%s latency=%.1f ms",
            search_url,
            repr(ex),
            elapsed_ms,
        )
        return False
    except Exception as ex:
        elapsed_ms = (time.perf_counter() - start) * 1000.0
        logger.warning(
            "FAIL(UNK)  %s reason=%s latency=%.1f ms",
            search_url,
            repr(ex),
            elapsed_ms,
        )
        return False


def collect_items(data, source):
    items = []
    api_site = data.get("api_site") or {}
    if isinstance(api_site, dict):
        for _, v in api_site.items():
            if isinstance(v, dict):
                name = v.get("name")
                api = v.get("api")
                detail = v.get("detail", "")
                if api and name:
                    items.append({
                        "name": str(name),
                        "api": str(api),
                        "detail": str(detail) if detail is not None else "",
                        "source": source
                    })
    return items


def dedupe_by_api(items):
    seen = {}
    for it in items:
        norm = normalize_url(it.get("api", ""))
        if not norm:
            continue
        if norm not in seen:
            seen[norm] = {
                "name": it.get("name", ""),
                "api": it.get("api", ""),
                "detail": it.get("detail", ""),
                "source": it.get("source", "new")
            }
    return list(seen.values())


def remove_av_items(items):
    return [it for it in items if not str(it.get("name", "")).startswith("AV-")]


def filter_accessible(items):
    results = []
    failed = []
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        futures = {pool.submit(is_accessible, it["api"]): it for it in items}
        for fut in as_completed(futures):
            it = futures[fut]
            ok = False
            try:
                ok = fut.result()
            except Exception as ex:
                logger.warning("FAIL(FUTURE) %s reason=%s", it["api"], repr(ex))
                ok = False
            if ok:
                results.append(it)
            else:
                failed.append(it)
    return results, failed


def dedupe_output_by_api(items):
    unique = {}
    for it in items:
        api = it.get("api", "")
        key = normalize_url(api)
        if not key:
            continue
        if key not in unique:
            unique[key] = it
    return list(unique.values())


def write_output(items, cache_time, output_file):
    items_sorted = sorted(
        items,
        key=lambda x: (0 if x.get("source") == "config" else 1, (x.get("name") or "").lower())
    )
    api_site = {}
    for idx, it in enumerate(items_sorted, start=1):
        api_site[f"src_{idx}"] = {
            "name": it["name"],
            "api": it["api"],
            "detail": it.get("detail", "")
        }
    out = {"cache_time": cache_time, "api_site": api_site}
    with open(output_file, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)


def print_source_list(title, items):
    print(f"\n{title} ({len(items)}):")
    if not items:
        print("  None")
        return

    items_sorted = sorted(
        items,
        key=lambda x: (0 if x.get("source") == "config" else 1, (x.get("name") or "").lower())
    )
    for idx, it in enumerate(items_sorted, start=1):
        print(f"  {idx}. {it.get('name', '')} - {it.get('api', '')}")


def parse_args():
    parser = argparse.ArgumentParser(
        description="Merge, dedupe, and validate MoonTV source JSON files."
    )
    parser.add_argument(
        "inputs",
        nargs="*",
        help="Input JSON files. Defaults to config.json and NewSource.json.",
    )
    parser.add_argument(
        "-i",
        "--input",
        action="append",
        dest="input_files",
        help="Input JSON file. Can be used multiple times.",
    )
    parser.add_argument(
        "-o",
        "--output",
        default=OUTPUT_FILE,
        help="Output JSON file. Defaults to MergedSource.json.",
    )
    args = parser.parse_args()
    input_files = args.input_files or args.inputs or INPUT_FILES
    return [os.path.abspath(p) for p in input_files], os.path.abspath(args.output)


def main():
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s"
    )

    input_files, output_file = parse_args()

    all_items = []
    cache_time = None
    for p in input_files:
        if not os.path.exists(p):
            logger.warning("Input file not found: %s", p)
            continue
        data = load_json(p)
        if cache_time is None:
            cache_time = data.get("cache_time")
        source = "config" if os.path.basename(p) == "config.json" else "new"
        all_items.extend(collect_items(data, source))

    if cache_time is None:
        cache_time = 7200

    logger.info("Loaded %d items from inputs", len(all_items))
    merged = dedupe_by_api(all_items)
    logger.info("After dedupe: %d items", len(merged))
    merged = remove_av_items(merged)
    logger.info("After AV- filter: %d items", len(merged))
    merged, failed = filter_accessible(merged)
    logger.info("After search validation: %d accessible items", len(merged))
    merged = dedupe_output_by_api(merged)
    logger.info("After final api dedupe: %d items", len(merged))
    write_output(merged, cache_time, output_file)

    print(f"Merged {len(all_items)} items into {len(merged)} accessible unique items.")
    print_source_list("Successful sources", merged)
    print_source_list("Failed sources", failed)
    print(f"Output written to: {output_file}")


if __name__ == "__main__":
    main()
