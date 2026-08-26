from pathlib import Path

files = list(Path("points-seckill/tools").rglob("*.js"))
for p in files:
    t = p.read_text(encoding="utf-8", errors="ignore")
    for n in ["fetchActInfo(", ".fetchActInfo", "getActInfo("]:
        if n in t:
            idx = 0
            c = 0
            while c < 4:
                i = t.find(n, idx)
                if i < 0:
                    break
                print(f"\n==== {p.name} {n} @{i}")
                print(t[max(0,i-220):i+180])
                idx = i + len(n)
                c += 1

# mapping 活动ID
print("\n\n==== mapping 活动ID")
t = Path("points-seckill/tools/js_3.js").read_text(encoding="utf-8", errors="ignore")
i = t.find("活动ID")
print("idx", i)
if i >= 0:
    print(t[i-80:i+80])
# also 活动id
for n in ['"活动ID"', '"活动id"', "actId.content"]:
    print(n, t.find(n))
    j = t.find(n)
    if j >= 0:
        print(t[j-60:j+80])
