import json
import os
import ssl
import socket
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


def is_accessible(url):
    if not url:
        return False
    req_headers = {"User-Agent": USER_AGENT}
    ctx = ssl.create_default_context()
    req = request.Request(url, headers=req_headers, method="HEAD")
    try:
        with request.urlopen(req, timeout=TIMEOUT, context=ctx) as resp:
            return 200 <= getattr(resp, "status", 0) < 400
    except error.HTTPError as e:
        if e.code in (403, 405):
            # Fallback to a minimal GET
            try:
                req_get = request.Request(url, headers={**req_headers, "Range": "bytes=0-0"}, method="GET")
                with request.urlopen(req_get, timeout=TIMEOUT, context=ctx) as resp2:
                    return 200 <= getattr(resp2, "status", 0) < 400
            except Exception:
                return False
        return False
    except (error.URLError, ValueError, socket.timeout, ssl.SSLError):
        return False
    except Exception:
        return False


def collect_items(data):
    items = []
    api_site = data.get("api_site") or {}
    if isinstance(api_site, dict):
        for _, v in api_site.items():
            if isinstance(v, dict):
                name = v.get("name")
                api = v.get("api")
                detail = v.get("detail", "")
                if api and name:
                    items.append({"name": str(name), "api": str(api), "detail": str(detail) if detail is not None else ""})
    return items


def dedupe_by_api(items):
    seen = {}
    for it in items:
        norm = normalize_url(it.get("api", ""))
        if not norm:
            continue
        if norm not in seen:
            seen[norm] = {"name": it.get("name", ""), "api": it.get("api", ""), "detail": it.get("detail", "")}
    return list(seen.values())


def remove_av_items(items):
    return [it for it in items if not str(it.get("name", "")).startswith("AV-")]


def filter_accessible(items):
    results = []
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        futures = {pool.submit(is_accessible, it["api"]): it for it in items}
        for fut in as_completed(futures):
            it = futures[fut]
            ok = False
            try:
                ok = fut.result()
            except Exception:
                ok = False
            if ok:
                results.append(it)
    return results


def write_output(items, cache_time):
    items_sorted = sorted(items, key=lambda x: (x.get("name") or "").lower())
    api_site = {}
    for idx, it in enumerate(items_sorted, start=1):
        api_site[f"src_{idx}"] = {"name": it["name"], "api": it["api"], "detail": it.get("detail", "")}
    out = {"cache_time": cache_time, "api_site": api_site}
    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)


def main():
    all_items = []
    cache_time = None
    for p in INPUT_FILES:
        if not os.path.exists(p):
            continue
        data = load_json(p)
        if cache_time is None:
            cache_time = data.get("cache_time")
        all_items.extend(collect_items(data))

    if cache_time is None:
        cache_time = 7200

    merged = dedupe_by_api(all_items)
    merged = remove_av_items(merged)
    merged = filter_accessible(merged)
    write_output(merged, cache_time)

    print(f"Merged {len(all_items)} items into {len(merged)} accessible unique items.")
    print(f"Output written to: {OUTPUT_FILE}")


if __name__ == "__main__":
    main()