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
  appKeyFallbacks: ['h55', 'H55', 'l33'],
  currencyType: 'H55_ticket_ios',
  currencyName: '积分',
  marketId: '68258cf50b20f30f391d726c',
  asType: 10,
  roleChannel: 'ACT_CENTER_COMMON',
  hosts: {
    act: 'https://act.ds.163.com',
    infAct: 'https://inf-act.ds.163.com',
    payApi: 'https://pay-api.ds.163.com',
    inf: 'https://inf.ds.163.com',
  },
  apis: {
    actInfo: '/v1/act-web/module/common/actInfo',
    roleListByUrs: '/v1/act-web/module/common/roleListByUrs',
    getRoleDetail: '/v1/act-web/module/common/getRoleDetail',
    bindRole: '/v1/act-web/module/common/bindRole',
    getCurrencyInfo: '/v1/act-web/common/currency/getCurrencyInfo',
    getMarketInfo: '/v1/act-web/module/market/getMarketInfo',
    getAllExchangeGoodsTab: '/v1/act-web/module/market/getAllExchangeGoodsTab',
    getExchangeList: '/v1/act-web/module/market/getExchangeListV2_complexFilter',
    getExchangeDetail: '/v1/act-web/module/market/getExchangeDetail',
    exchangePrize: '/v1/act-web/module/market/exchangePrize',
  },
};

let cached = null;

function candidatePaths() {
  return [
    process.env.POINTS_CONFIG_PATH,
    path.resolve(__dirname, '../../points-seckill/config/identity-v.json'),
    path.resolve(__dirname, '../config/identity-v.json'),
  ].filter(Boolean);
}

function loadConfig() {
  if (cached) return cached;
  for (const p of candidatePaths()) {
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
  }
  cached = FALLBACK;
  return cached;
}

/** 积分商城 CMS「活动ID」，不是 URL 第一段模板 ID */
function getActId(cfg) {
  const c = cfg || loadConfig();
  return c.mallActId || c.actId;
}

function actIdAliases(cfg) {
  const c = cfg || loadConfig();
  return [...new Set([c.mallActId, c.actId, c.pageAppId].filter(Boolean).map(String))];
}

function isSameAct(id, cfg) {
  const want = String(id || '');
  return actIdAliases(cfg).includes(want);
}

module.exports = { loadConfig, FALLBACK, getActId, isSameAct, actIdAliases };
