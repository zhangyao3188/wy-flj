const fs = require('fs');
const path = require('path');
const dir = __dirname;
const files = ['js_11.js', 'js_12.js', 'js_3.js', 'js_4.js'];
const needles = [
  'fetchExchangeList',
  'exchangePrize',
  'fetchMarketInfo',
  'getModuleRequestParam',
  'goodsId',
  'marketId',
  'asId',
  'currencyType',
  'exchangeNum',
  'complexFilter',
];

for (const f of files) {
  const p = path.join(dir, f);
  if (!fs.existsSync(p)) continue;
  const t = fs.readFileSync(p, 'utf8');
  for (const n of needles) {
    let idx = 0;
    let count = 0;
    while ((idx = t.indexOf(n, idx)) !== -1 && count < 3) {
      console.log(`\n===== ${f} ${n} #${count} =====`);
      console.log(t.slice(Math.max(0, idx - 120), Math.min(t.length, idx + 280)).replace(/\s+/g, ' '));
      idx += n.length;
      count++;
    }
  }
}
