const fs = require('fs');
const path = require('path');

const dir = __dirname;
const files = fs.readdirSync(dir).filter((f) => f.startsWith('js_') && f.endsWith('.js'));
const keywords = [
  'exchangePrize',
  'getExchangeList',
  'getMarketInfo',
  'getAllExchangeGoodsTab',
  'getExchangeDetail',
  'getCurrencyInfo',
  'roleListByUrs',
  'getRoleDetail',
  'bindRole',
  'getAccount',
  'actInfo',
];

for (const f of files) {
  const t = fs.readFileSync(path.join(dir, f), 'utf8');
  for (const kw of keywords) {
    let idx = 0;
    while ((idx = t.indexOf(kw, idx)) !== -1) {
      const start = Math.max(0, idx - 200);
      const end = Math.min(t.length, idx + 400);
      const snippet = t.slice(start, end).replace(/\s+/g, ' ');
      console.log(`\n===== ${f} :: ${kw} @${idx} =====\n${snippet}`);
      idx += kw.length;
    }
  }
}
