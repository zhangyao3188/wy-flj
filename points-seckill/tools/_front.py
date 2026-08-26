from pathlib import Path

t = Path("points-seckill/tools/js_3.js").read_text(encoding="utf-8", errors="ignore")
for n in ["fetchActFrontConfig", "frontConfig", "commonAppConfig", "setId"]:
    print("\n====", n, "count", t.count(n))

# find function l that is fetchActFrontConfig
i = t.find("fetchActFrontConfig:function(){return l}")
print("\nexport at", i)
# find function l for front config - search around commonAppConfig we already know uses {id:e}

# search fetchActFrontConfig usage
idx = 0
c = 0
while c < 8:
    j = t.find("fetchActFrontConfig", idx)
    if j < 0:
        break
    print("\n--- usage", j, "---")
    print(t[max(0,j-120):j+250])
    idx = j + 10
    c += 1

# find the implementation near commonAppConfig
k = t.find('pageConf/commonAppConfig')
print("\n==== commonAppConfig impl")
print(t[k-400:k+500])
