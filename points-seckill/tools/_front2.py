from pathlib import Path

t = Path("points-seckill/tools/js_3.js").read_text(encoding="utf-8", errors="ignore")
print("==== front config consumer @209956")
print(t[209700:211200])

print("\n\n==== fetchActInfo calls")
idx = 0
c = 0
while c < 10:
    j = t.find(".fetchActInfo(", idx)
    if j < 0:
        break
    print("\n---", j, "---")
    print(t[max(0,j-180):j+200])
    idx = j + 10
    c += 1

# layouts getActInfo
lay = Path("points-seckill/tools/js_cache/15_layouts__index.c7db6ee2.async.js").read_text(encoding="utf-8", errors="ignore")
print("\n\n==== layouts getActInfo usage")
idx = 0
c = 0
while c < 6:
    j = lay.find("getActInfo", idx)
    if j < 0:
        break
    print("\n---", j, "---")
    print(lay[max(0,j-150):j+350])
    idx = j + 8
    c += 1
