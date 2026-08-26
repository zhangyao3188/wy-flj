#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Crawl Identity V (第五人格) points-mall page JS and lock API / payload fields."""

from __future__ import annotations

import json
import re
import ssl
import sys
import urllib.request
from html.parser import HTMLParser
from pathlib import Path
from typing import Iterable
from urllib.parse import urljoin, urlparse

PAGE_URL = (
    "https://act.ds.163.com/6c5dff79fefb9cf3/65c083d29d2bb100013d3069"
    "?channel=yydc_cps10.cczx&wvFullScreen=true&wvStatusBarStyle=white"
)
ACT_ID = "6c5dff79fefb9cf3"
PAGE_SET_ID = "65c083d29d2bb100013d3069"
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
)

ROOT = Path(__file__).resolve().parents[1]
CONFIG_PATH = ROOT / "config" / "identity-v.json"
LOCAL_JS_DIR = Path(__file__).resolve().parent
JS_CACHE_DIR = LOCAL_JS_DIR / "js_cache"

API_HINTS = [
    "getExchangeListV2_complexFilter",
    "getAllExchangeGoodsTab",
    "getMarketInfo",
    "getExchangeDetail",
    "exchangePrize",
    "getCurrencyInfo",
    "roleListByUrs",
    "getRoleDetail",
    "bindRole",
    "actInfo",
    "commonAppConfig",
]

DEFAULT_CONFIG = {
    "game": "identity-v",
    "gameName": "第五人格",
    "actId": ACT_ID,
    "pageSetId": PAGE_SET_ID,
    "pageUrl": f"https://act.ds.163.com/{ACT_ID}/{PAGE_SET_ID}",
    "appKey": "h55",
    "currencyType": "H55_ticket_ios",
    "marketId": "68258cf50b20f30f391d726c",
    "mallActId": "681c2ad9522bf029b6fce6d0",
    "roleChannel": "ACT_CENTER_COMMON",
    "hosts": {
        "act": "https://act.ds.163.com",
        "infAct": "https://inf-act.ds.163.com",
        "payApi": "https://pay-api.ds.163.com",
        "inf": "https://inf.ds.163.com",
    },
    "apis": {
        "actInfo": "/v1/act-web/module/common/actInfo",
        "roleListByUrs": "/v1/act-web/module/common/roleListByUrs",
        "getRoleDetail": "/v1/act-web/module/common/getRoleDetail",
        "bindRole": "/v1/act-web/module/common/bindRole",
        "getCurrencyInfo": "/v1/act-web/common/currency/getCurrencyInfo",
        "getMarketInfo": "/v1/act-web/module/market/getMarketInfo",
        "getAllExchangeGoodsTab": "/v1/act-web/module/market/getAllExchangeGoodsTab",
        "getExchangeList": "/v1/act-web/module/market/getExchangeListV2_complexFilter",
        "getExchangeDetail": "/v1/act-web/module/market/getExchangeDetail",
        "exchangePrize": "/v1/act-web/module/market/exchangePrize",
        "commonAppConfig": "/v1/act-web/pageConf/commonAppConfig",
    },
    "bodies": {
        "actInfo": ["actId"],
        "roleListByUrs": ["appKey", "actId", "channel"],
        "getRoleDetail": ["appKey", "roleId", "server"],
        "bindRole": ["appKey", "roleId", "server", "actId"],
        "getCurrencyInfo": ["currencyType", "actId", "roleInfo"],
        "getMarketInfo": ["actId", "asId", "asType"],
        "getAllExchangeGoodsTab": ["actId", "asId", "asType"],
        "getExchangeList": ["actId", "asId", "asType", "pageSize", "pageNum", "goodsTab"],
        "getExchangeDetail": ["actId", "asId", "asType", "exchangeId"],
        "exchangePrize": ["exchangeId", "roleId", "server", "appKey"],
    },
    "goodsFields": {
        "id": ["goodsId", "id", "prizeId", "exchangeId", "goodsID"],
        "name": ["goodsName", "name", "title", "prizeName", "goodsTitle"],
        "price": ["price", "needNum", "currencyNum", "cost", "score", "needCurrency"],
        "stock": ["remainStock", "leftNum", "stock", "remain", "remainNum", "leftStock"],
        "exchanged": [
            "userExchangedNum",
            "exchangedNum",
            "userExchangeCount",
            "alreadyExchangeNum",
            "exchanged",
        ],
        "limit": ["limitNum", "userLimit", "exchangeLimit", "maxExchangeNum"],
        "startTime": [
            "startTime",
            "exchangeStartTime",
            "beginTime",
            "saleStartTime",
            "seckillStartTime",
        ],
        "endTime": ["endTime", "exchangeEndTime", "saleEndTime", "seckillEndTime"],
        "image": ["img", "picUrl", "icon", "image", "goodsImg", "pic"],
    },
    "scraped": {},
}


class AssetParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.urls: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        ad = {k: v for k, v in attrs}
        for key in ("src", "href"):
            val = ad.get(key)
            if not val:
                continue
            if tag in {"script", "link"} or val.endswith(".js") or "async.js" in val:
                self.urls.append(val)
        as_type = (ad.get("as") or "").lower()
        if as_type == "script" and ad.get("href"):
            self.urls.append(ad["href"])


def ssl_ctx() -> ssl.SSLContext:
    ctx = ssl.create_default_context()
    try:
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
    except Exception:
        pass
    return ctx


def http_get(url: str, timeout: int = 25) -> bytes:
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": UA,
            "Accept": "*/*",
            "Referer": f"https://act.ds.163.com/{ACT_ID}/",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout, context=ssl_ctx()) as resp:
        return resp.read()


def unique(seq: Iterable[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for item in seq:
        if item and item not in seen:
            seen.add(item)
            out.append(item)
    return out


def extract_js_urls(html: str, base: str) -> list[str]:
    parser = AssetParser()
    try:
        parser.feed(html)
    except Exception:
        pass
    found = list(parser.urls)
    found += re.findall(
        r"""(?:src|href)=["']([^"']+\.js[^"']*)["']""", html, flags=re.I
    )
    found += re.findall(
        r"""["'](https?://[^"']+\.js[^"']*)["']""", html, flags=re.I
    )
    abs_urls = []
    for raw in found:
        u = urljoin(base, raw.strip())
        path = urlparse(u).path.lower()
        if path.endswith(".js") or "async.js" in path:
            abs_urls.append(u.split("?")[0])
    return unique(abs_urls)


def download_js(urls: list[str], limit: int = 40) -> list[Path]:
    JS_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    saved: list[Path] = []
    for i, url in enumerate(urls[:limit]):
        name = Path(urlparse(url).path).name or f"chunk_{i}.js"
        dest = JS_CACHE_DIR / f"{i:02d}_{name}"
        try:
            data = http_get(url)
            dest.write_bytes(data)
            saved.append(dest)
            print(f"[scrape] js {i+1}/{min(len(urls), limit)} {name} ({len(data)} bytes)")
        except Exception as e:
            print(f"[scrape] skip {url}: {e}")
    return saved


def collect_local_js() -> list[Path]:
    files = []
    for p in LOCAL_JS_DIR.glob("js_*.js"):
        files.append(p)
    if JS_CACHE_DIR.exists():
        files.extend(JS_CACHE_DIR.glob("*.js"))
    return files


def find_quoted(text: str, key: str) -> list[str]:
    pat = re.compile(
        rf"""(?:["']{re.escape(key)}["']\s*:\s*["']([^"']+)["']|{re.escape(key)}\s*[:=]\s*["']([^"']+)["'])"""
    )
    hits = []
    for m in pat.finditer(text):
        val = m.group(1) or m.group(2)
        if val:
            hits.append(val)
    return unique(hits)


def find_api_paths(text: str) -> list[str]:
    return unique(
        re.findall(r"/v1/act(?:-web)?/[A-Za-z0-9_./-]+", text)
    )


def nearby_object_keys(text: str, needle: str, window: int = 400) -> list[str]:
    keys: list[str] = []
    for m in re.finditer(re.escape(needle), text):
        chunk = text[max(0, m.start() - window) : m.end() + window]
        keys += re.findall(r"""["']([A-Za-z_][A-Za-z0-9_]{1,40})["']\s*:""", chunk)
        keys += re.findall(
            r"""\b(actId|appKey|goodsId|tabId|pageNo|pageSize|currencyType|roleId|server|num|exchangeNum|marketId|channel)\b""",
            chunk,
        )
    return unique(keys)


def pick_best(values: list[str], prefer: Iterable[str] | None = None, reject: Iterable[str] | None = None) -> str:
    if not values:
        return ""
    bad = {*(reject or []), "appKey", "appkey", "currencyType", "actId"}
    cleaned = [v for v in values if v and v not in bad]
    pref = list(prefer or [])
    for p in pref:
        if p in cleaned:
            return p
    for v in cleaned:
        if v.lower() in {"h55", "l33", "nshm", "a19"}:
            return v
    short = [v for v in cleaned if 1 < len(v) <= 64 and " " not in v]
    return (short or cleaned or [""])[0]


def scan_sources(files: list[Path]) -> dict:
    api_paths: list[str] = []
    app_keys: list[str] = []
    currency_types: list[str] = []
    body_keys: dict[str, list[str]] = {name: [] for name in API_HINTS}
    market_config_hits: list[str] = []

    for fp in files:
        try:
            text = fp.read_text(encoding="utf-8", errors="ignore")
        except Exception:
            continue
        if not text:
            continue
        api_paths += find_api_paths(text)
        app_keys += find_quoted(text, "appKey")
        app_keys += find_quoted(text, "appkey")
        currency_types += find_quoted(text, "currencyType")
        if "marketConfig" in text or "积分商城" in text:
            market_config_hits.append(fp.name)
        for hint in API_HINTS:
            if hint in text:
                body_keys[hint] = unique(body_keys[hint] + nearby_object_keys(text, hint))

    known_body = {
        "actId",
        "appKey",
        "goodsId",
        "tabId",
        "pageNo",
        "pageSize",
        "page",
        "size",
        "currencyType",
        "roleId",
        "server",
        "num",
        "exchangeNum",
        "marketId",
        "channel",
        "filterList",
        "sortType",
    }
    bodies: dict[str, list[str]] = {}
    for hint, keys in body_keys.items():
        filtered = [k for k in keys if k in known_body]
        if filtered:
            bodies[hint] = filtered

    return {
        "apiPaths": unique(p for p in api_paths if "market" in p or "currency" in p or "role" in p.lower() or "actInfo" in p or "bindRole" in p),
        "appKeys": unique(app_keys),
        "currencyTypes": unique(currency_types),
        "bodies": bodies,
        "marketConfigFiles": unique(market_config_hits),
        "allApiPathsSample": unique(api_paths)[:80],
    }


def try_common_app_config() -> dict | None:
    url = "https://inf-act.ds.163.com/v1/act-web/pageConf/commonAppConfig"
    payload = json.dumps({"id": PAGE_SET_ID}).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=payload,
        method="POST",
        headers={
            "User-Agent": UA,
            "Content-Type": "application/json;charset=UTF-8",
            "Origin": "https://act.ds.163.com",
            "Referer": f"https://act.ds.163.com/{ACT_ID}/{PAGE_SET_ID}",
            "Accept": "application/json, text/plain, */*",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=20, context=ssl_ctx()) as resp:
            data = json.loads(resp.read().decode("utf-8", errors="ignore"))
        dump = LOCAL_JS_DIR / "captured"
        dump.mkdir(parents=True, exist_ok=True)
        (dump / "commonAppConfig.json").write_text(
            json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        print("[scrape] commonAppConfig saved")
        return data
    except Exception as e:
        print(f"[scrape] commonAppConfig failed: {e}")
        return None


def walk_find(obj, keys: set[str], acc: dict[str, list] | None = None, depth: int = 0):
    if acc is None:
        acc = {k: [] for k in keys}
    if depth > 12:
        return acc
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k in keys and isinstance(v, (str, int, float)) and str(v):
                acc[k].append(str(v))
            walk_find(v, keys, acc, depth + 1)
    elif isinstance(obj, list):
        for it in obj[:80]:
            walk_find(it, keys, acc, depth + 1)
    return acc


def extract_mall_meta(app_conf: dict) -> dict:
    """Parse 积分商城 CMS: 货币类型 / 商城模块 / 活动ID."""
    result = (app_conf or {}).get("result") or (app_conf or {}).get("data") or {}
    meta: dict[str, str] = {}

    def walk(node) -> None:
        if isinstance(node, dict):
            name = str(node.get("name") or "")
            content = node.get("content")
            ext = node.get("ext")
            if name == "货币类型" and content:
                meta["currencyType"] = str(content).strip()
            if name == "商城模块" and content:
                meta["marketId"] = str(content).strip()
            if name == "活动ID" and content:
                meta["mallActId"] = str(content).strip()
            if name in {"货币信息", "货币配置"} and isinstance(ext, str):
                try:
                    obj = json.loads(ext)
                    if obj.get("type") and not meta.get("currencyType"):
                        meta["currencyType"] = str(obj["type"])
                    if obj.get("currencyType"):
                        meta["currencyType"] = str(obj["currencyType"])
                except Exception:
                    pass
            for it in node.get("itemList") or []:
                walk(it)
        elif isinstance(node, list):
            for it in node:
                walk(it)

    walk(result)
    return meta


def merge_config(scraped: dict, app_conf: dict | None) -> dict:
    cfg = json.loads(json.dumps(DEFAULT_CONFIG))
    app_key = pick_best(scraped.get("appKeys") or [], prefer=["h55", "l33"])
    currency = pick_best(scraped.get("currencyTypes") or [])
    market_id = ""
    mall_act_id = ""
    if app_conf and isinstance(app_conf, dict):
        found = walk_find(app_conf, {"appKey", "appkey", "currencyType", "actId", "type"})
        app_key = (
            pick_best(found.get("appKey") or found.get("appkey") or [], prefer=["h55", "l33"])
            or app_key
        )
        currency = pick_best(found.get("currencyType") or found.get("type") or []) or currency
        mall_meta = extract_mall_meta(app_conf)
        if mall_meta.get("currencyType"):
            currency = mall_meta["currencyType"]
        if mall_meta.get("marketId"):
            market_id = mall_meta["marketId"]
        if mall_meta.get("mallActId"):
            mall_act_id = mall_meta["mallActId"]
        if mall_meta.get("appKey"):
            app_key = mall_meta["appKey"]

    if app_key:
        cfg["appKey"] = app_key
    if currency:
        cfg["currencyType"] = currency
    if market_id:
        cfg["marketId"] = market_id
    if mall_act_id:
        cfg["mallActId"] = mall_act_id

    bodies = cfg["bodies"]
    mapping = {
        "getExchangeListV2_complexFilter": "getExchangeList",
        "exchangePrize": "exchangePrize",
        "getCurrencyInfo": "getCurrencyInfo",
        "getExchangeDetail": "getExchangeDetail",
        "getMarketInfo": "getMarketInfo",
        "getAllExchangeGoodsTab": "getAllExchangeGoodsTab",
        "roleListByUrs": "roleListByUrs",
        "bindRole": "bindRole",
        "actInfo": "actInfo",
    }
    for src, dest in mapping.items():
        extra = (scraped.get("bodies") or {}).get(src) or []
        if extra:
            bodies[dest] = unique((bodies.get(dest) or []) + extra)

    cfg["scraped"] = {
        "pageUrl": PAGE_URL,
        "appKeys": scraped.get("appKeys") or [],
        "currencyTypes": scraped.get("currencyTypes") or [],
        "apiPaths": scraped.get("apiPaths") or [],
        "bodyKeys": scraped.get("bodies") or {},
        "marketConfigFiles": scraped.get("marketConfigFiles") or [],
    }
    return cfg


def main() -> int:
    print(f"[scrape] fetch {PAGE_URL}")
    html = ""
    try:
        html = http_get(PAGE_URL).decode("utf-8", errors="ignore")
        (LOCAL_JS_DIR / "page.html").write_text(html, encoding="utf-8")
        print(f"[scrape] html {len(html)} chars")
    except Exception as e:
        print(f"[scrape] html failed: {e}")

    urls = extract_js_urls(html, PAGE_URL) if html else []
    print(f"[scrape] discovered {len(urls)} js urls")
    if urls:
        download_js(urls)

    files = collect_local_js()
    print(f"[scrape] scanning {len(files)} js files")
    scraped = scan_sources(files)
    app_conf = try_common_app_config()
    cfg = merge_config(scraped, app_conf)

    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    CONFIG_PATH.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[scrape] wrote {CONFIG_PATH}")
    print(f"[scrape] appKey={cfg.get('appKey')} currencyType={cfg.get('currencyType') or '(empty)'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
