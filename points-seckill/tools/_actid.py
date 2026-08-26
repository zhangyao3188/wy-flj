from pathlib import Path

def snip(fp, needle, n=3, before=200, after=400):
    t = Path(fp).read_text(encoding="utf-8", errors="ignore")
    idx = 0
    c = 0
    print("\n########", Path(fp).name, needle)
    while c < n:
        i = t.find(needle, idx)
        if i < 0:
            break
        print(f"\n--- @{i} ---")
        print(t[max(0, i - before) : i + after])
        idx = i + len(needle)
        c += 1

snip("points-seckill/tools/js_cache/15_layouts__index.c7db6ee2.async.js", "getActInfo")
snip("points-seckill/tools/js_cache/15_layouts__index.c7db6ee2.async.js", "actId")
snip("points-seckill/tools/js_cache/10_390.6055d837.async.js", "fetchActInfo")
snip("points-seckill/tools/js_3.js", "fetchActInfo")
