const fs = require('fs');
const path = require('path');

const dir = __dirname;
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js') && f.startsWith('js_'));
const set = new Set();
const rePath = /["'`](\/v1\/[a-zA-Z0-9_\-./]+)["'`]/g;
const rePost = /\.post\(\s*["'`]([^"'`]+)["'`]/g;
const reGet = /\.get\(\s*["'`]([^"'`]+)["'`]/g;
const reUrl = /["'`](https?:\/\/[^"'`]+)["'`]/g;

for (const f of files) {
  const t = fs.readFileSync(path.join(dir, f), 'utf8');
  let m;
  while ((m = rePath.exec(t))) set.add(m[1]);
  while ((m = rePost.exec(t))) if (m[1].includes('/')) set.add('POST ' + m[1]);
  while ((m = reGet.exec(t))) if (m[1].includes('/')) set.add('GET ' + m[1]);
  while ((m = reUrl.exec(t))) {
    if (/inf-act|act\.ds|pay-api|inf\.ds/i.test(m[1])) set.add(m[1]);
  }
}

const keywords =
  /act|goods|point|score|exchange|redeem|mall|shop|role|server|store|coupon|grade|benefit|rights|reward|luck|task|item|square|gift|bind|game/i;

const filtered = [...set].filter((s) => keywords.test(s)).sort();
console.log(filtered.join('\n'));
fs.writeFileSync(
  path.join(dir, 'extracted-apis.txt'),
  filtered.join('\n') + '\n',
  'utf8'
);
console.error(`wrote ${filtered.length} paths`);
