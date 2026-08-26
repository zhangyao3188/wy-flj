const fs = require('fs');
const path = require('path');

const FALLBACK = {
  game: 'identity-v',
  gameName: '第五人格',
  pageAppId: '6c5dff79fefb9cf3',
  actId: '681c2ad9522bf029b6fce6d0',
  mallActId: '681c2ad9522bf029b6fce6d0',
  pageSetId: '65c083d29d2bb100013d3069',
  pageUrl: 'https://act.ds.163.com/6c5dff79fefb9cf3/65c083d29d2bb100013d3069',
  appKey: 'h55',
  currencyType: 'H55_ticket_ios',
  marketId: '68258cf50b20f30f391d726c',
  asType: 10,
  hosts: {
    act: 'https://act.ds.163.com',
    infAct: 'https://inf-act.ds.163.com',
    payApi: 'https://pay-api.ds.163.com',
    inf: 'https://inf.ds.163.com',
  },
  apis: {
    actInfo: '/v1/act-web/module/common/actInfo',
    getExchangeList: '/v1/act-web/module/market/getExchangeListV2_complexFilter',
    exchangePrize: '/v1/act-web/module/market/exchangePrize',
    getCurrencyInfo: '/v1/act-web/common/currency/getCurrencyInfo',
  },
};

let cached = null;

function loadConfig() {
  if (cached) return cached;
  const p = path.resolve(__dirname, '../config/identity-v.json');
  try {
    if (fs.existsSync(p)) {
      const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
      cached = {
        ...FALLBACK,
        ...parsed,
        hosts: { ...FALLBACK.hosts, ...(parsed.hosts || {}) },
        apis: { ...FALLBACK.apis, ...(parsed.apis || {}) },
      };
      return cached;
    }
  } catch (_) {}
  cached = FALLBACK;
  return cached;
}

function getActId(cfg) {
  const c = cfg || loadConfig();
  return c.mallActId || c.actId;
}

module.exports = { loadConfig, FALLBACK, getActId };
