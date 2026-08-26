const C = require('./constants');
const { loadConfig, getActId } = require('./pointsConfig');
const { createSession, applyCookieMap, ensureXsrf } = require('./http');

function unwrap(data) {
  if (!data || typeof data !== 'object') return {};
  return data.result || data.data || {};
}

function okCode(data) {
  const code = data && data.code != null ? Number(data.code) : NaN;
  return !Number.isFinite(code) || code === 200 || code === 0;
}

function isLoggedActInfo(actInfo) {
  if (!actInfo || typeof actInfo !== 'object') return false;
  const role = actInfo.actRoleInfo;
  const roleId = role && (role.roleId || role.role_id);
  return !!(
    actInfo.actAccount ||
    actInfo.uid ||
    (actInfo.user && (actInfo.user.actAccount || actInfo.user.uid)) ||
    roleId
  );
}

const SESSION_EXPIRED_MSG = '会话已失效，请重新登录该账号后再查看角色';

function cookiesToMap(cookies, cookieHeader) {
  const map = {};
  for (const c of cookies || []) {
    if (!c || !c.name || c.value == null || c.value === '') continue;
    map[c.name] = String(c.value);
  }
  if (cookieHeader) {
    for (const part of String(cookieHeader).split(';')) {
      const idx = part.indexOf('=');
      if (idx <= 0) continue;
      const name = part.slice(0, idx).trim();
      const value = part.slice(idx + 1).trim();
      if (!name || map[name]) continue;
      map[name] = value;
    }
  }
  return map;
}

function applyActCookies(jar, cookieMap) {
  applyCookieMap(jar, cookieMap);
  for (const [name, value] of Object.entries(cookieMap || {})) {
    if (!name || value == null || value === '') continue;
    const cookieStr = `${name}=${value}; Domain=.163.com; Path=/`;
    for (const url of ['https://act.ds.163.com/', 'https://inf-act.ds.163.com/']) {
      try {
        jar.setCookieSync(cookieStr, url);
      } catch (_) {}
    }
  }
}

function pickField(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  for (const k of keys || []) {
    if (obj[k] != null && obj[k] !== '') return obj[k];
  }
  return null;
}

function formatStartAt(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'number' || /^\d+$/.test(String(raw))) {
    let n = Number(raw);
    if (!Number.isFinite(n)) return null;
    if (n < 1e12) n *= 1000;
    const d = new Date(n);
    if (Number.isNaN(d.getTime())) return null;
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(
      d.getMinutes()
    )}:${p(d.getSeconds())}`;
  }
  const s = String(raw).trim().replace('T', ' ').replace(/\//g, '-');
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/);
  if (m) return `${m[1]} ${m[2]}`;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return String(raw);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(
    d.getMinutes()
  )}:${p(d.getSeconds())}`;
}

function normalizeGoods(raw, fields) {
  const id = String(pickField(raw, fields.id) || raw.exchangeId || '');
  const exchanged = Number(pickField(raw, fields.exchanged) || 0) || 0;
  const giveCount = Number(raw.haveGiveCount || 0) || 0;
  const limit = Number(pickField(raw, fields.limit) || 0) || 0;
  const stockRaw = pickField(raw, fields.stock);
  const stock = stockRaw == null || stockRaw === '' ? null : Number(stockRaw);
  const prizeStatus = Number(raw.prizeStatus);
  const inventory = String(raw.prizeInventoryStatus || '');
  // 与线上商城一致：
  // - 已兑换：个人限兑次数达到上限（haveExchangeCount(+haveGiveCount) >= uidMaxNum）
  // - 已售罄：prizeStatus===2 / prizeLeftNum===0 / TOTAL_STOCK_ZERO / PERIOD_STOCK_ZERO
  // - 不要用 canExchange===false 判断已兑换（售罄时也会是 false）
  const usedCount = exchanged + giveCount;
  const alreadyExchanged = limit > 0 && usedCount >= limit;
  const soldOut =
    stock === 0 ||
    prizeStatus === 2 ||
    inventory === 'TOTAL_STOCK_ZERO' ||
    inventory === 'PERIOD_STOCK_ZERO';
  const startTime = pickField(raw, fields.startTime);
  const notStarted = !!(raw.timeLimit && startTime && new Date(startTime).getTime() > Date.now());
  // 展示优先级对齐线上：售罄角标 > 已兑换 > 未开始
  let stockStatus = 'available';
  if (soldOut) stockStatus = 'sold_out';
  else if (alreadyExchanged) stockStatus = 'exchanged';
  else if (notStarted) stockStatus = 'not_started';
  return {
    id,
    exchangeId: String(raw.exchangeId || id),
    name: String(pickField(raw, fields.name) || '未命名商品'),
    price: Number(pickField(raw, fields.price) || 0) || 0,
    stock: Number.isFinite(stock) ? stock : null,
    exchanged: usedCount,
    limit: limit || null,
    startAt: formatStartAt(startTime),
    startTime,
    endTime: pickField(raw, fields.endTime) || null,
    image: pickField(raw, fields.image) || null,
    canExchange: raw.canExchange !== false,
    soldOut,
    alreadyExchanged,
    notStarted,
    stockStatus,
    goodsTab: raw.goodsTab || null,
    prizeStatus: Number.isFinite(prizeStatus) ? prizeStatus : null,
    prizeInventoryStatus: inventory || null,
    raw,
  };
}

function normalizeRole(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const role = normalizeRole(item);
      if (role) return role;
    }
    return null;
  }
  const nested = raw.role || raw.actRoleInfo || raw.roleInfo || raw.gameRole;
  const src =
    raw.roleId || raw.role_id || raw.actRoleId || raw.userRoleId
      ? raw
      : nested && typeof nested === 'object'
        ? nested
        : raw;
  const roleId = src.roleId || src.role_id || src.actRoleId || src.userRoleId || src.id || null;
  if (roleId == null || roleId === '') return null;
  return {
    roleId: String(roleId),
    roleName: String(src.roleName || src.nick || src.nickname || src.name || roleId),
    server:
      src.server != null
        ? String(src.server)
        : src.serverId != null
          ? String(src.serverId)
          : src.actServerId != null
            ? String(src.actServerId)
            : '',
    serverName: String(src.serverName || src.server_name || src.areaName || src.area || ''),
    appKey: src.appKey || src.appkey || raw.appKey || null,
  };
}

function collectRoles(payload) {
  const result = unwrap(payload);
  const bags = [
    result.roleList,
    result.roles,
    result.list,
    result.gameRoleList,
    result.bindList,
    Array.isArray(result) ? result : null,
  ];
  const out = [];
  const seen = new Set();
  for (const bag of bags) {
    if (!Array.isArray(bag)) continue;
    for (const item of bag) {
      const role = normalizeRole(item);
      if (!role || seen.has(role.roleId)) continue;
      seen.add(role.roleId);
      out.push(role);
    }
  }
  return out;
}

function roleFromActInfo(result) {
  if (!result || typeof result !== 'object') return null;
  const candidates = [
    result.actRoleInfo,
    result.role,
    result.bindRole,
    result.userRole,
    result.currentRole,
    result.gameRole,
  ];
  for (const c of candidates) {
    const role = normalizeRole(c);
    if (role) return role;
  }
  return null;
}

function moduleParams(actInfo, cfg) {
  const list = (actInfo && (actInfo.moduleList || actInfo.modules)) || [];
  const asType = Number(cfg.asType || 10);
  const hit =
    list.find((m) => Number(m.asType) === asType && (!cfg.marketId || String(m.asId) === String(cfg.marketId))) ||
    list.find((m) => Number(m.asType) === asType) ||
    null;
  return {
    actId: (hit && hit.actId) || (actInfo && actInfo.actId) || cfg.mallActId || cfg.actId,
    asId: (hit && hit.asId) || cfg.marketId,
    asType,
  };
}

function infAct(cfg) {
  return (cfg.hosts && cfg.hosts.infAct) || C.INF_ACT;
}

function apiPath(cfg, name) {
  return (cfg.apis && cfg.apis[name]) || FALLBACK_APIS[name];
}

const FALLBACK_APIS = {
  actInfo: '/v1/act-web/module/common/actInfo',
  roleListByUrs: '/v1/act-web/module/common/roleListByUrs',
  bindRole: '/v1/act-web/module/common/bindRole',
  getCurrencyInfo: '/v1/act-web/common/currency/getCurrencyInfo',
  getMarketInfo: '/v1/act-web/module/market/getMarketInfo',
  getAllExchangeGoodsTab: '/v1/act-web/module/market/getAllExchangeGoodsTab',
  getExchangeList: '/v1/act-web/module/market/getExchangeListV2_complexFilter',
  getExchangeDetail: '/v1/act-web/module/market/getExchangeDetail',
  exchangePrize: '/v1/act-web/module/market/exchangePrize',
};

function createMallSession(account) {
  const cfg = loadConfig();
  const session = createSession();
  const origin = (cfg.hosts && cfg.hosts.act) || 'https://act.ds.163.com';
  session.client.defaults.headers.common.Origin = origin;
  session.client.defaults.headers.common.Referer = `${cfg.pageUrl || origin}/`;
  if (account.deviceId) {
    session.deviceId = account.deviceId;
    session.client.defaults.headers.common['GL-DeviceId'] = account.deviceId;
  }
  if (account.godUuid) {
    session.client.defaults.headers.common['GL-Uid'] = account.godUuid;
    session.client.defaults.headers.common['gl-uid'] = account.godUuid;
  }
  const cookieMap = cookiesToMap(account.cookies, account.cookieHeader);
  applyActCookies(session.jar, cookieMap);
  return { ...session, cfg, cookieMap };
}

async function postAct(session, name, body) {
  const cfg = session.cfg || loadConfig();
  const url = `${infAct(cfg)}${apiPath(cfg, name)}`;
  const res = await session.client.post(url, body || {});
  return res.data || {};
}

async function warmupMallSession(session) {
  await ensureXsrf(session.client, session.jar);
  await session.client.get(`${C.PAY_API}/api/nlogin`, { params: {} }).catch(() => {});
  await session.client.get(`${C.INF}/v1/web/cooperate/plutus/cookie-exchange`).catch(() => {});
  await ensureXsrf(session.client, session.jar);
  const cfg = session.cfg || loadConfig();
  const actId = getActId(cfg);
  session.resolvedActId = actId;
  return postAct(session, 'actInfo', { actId });
}

function resolveAppKey(actInfo, cfg) {
  const fromAct = actInfo && (actInfo.appKey || actInfo.gameCode || (actInfo.game && actInfo.game.appKey));
  if (fromAct) return String(fromAct);
  return cfg.appKey || 'h55';
}

async function fetchRoles(session, actInfo) {
  const cfg = session.cfg || loadConfig();
  const appKeys = [];
  const primary = resolveAppKey(actInfo, cfg);
  appKeys.push(primary);
  for (const k of cfg.appKeyFallbacks || []) {
    if (k && !appKeys.includes(k)) appKeys.push(k);
  }
  let roles = [];
  let lastErr = null;
  for (const appKey of appKeys) {
    try {
      const data = await postAct(session, 'roleListByUrs', {
        appKey,
        actId: (actInfo && actInfo.actId) || getActId(cfg),
        channel: cfg.roleChannel || 'ACT_CENTER_COMMON',
      });
      const list = collectRoles(data);
      if (list.length) {
        roles = list.map((r) => ({ ...r, appKey: r.appKey || appKey }));
        break;
      }
      if (isSessionExpired(data)) {
        lastErr = SESSION_EXPIRED_MSG;
        break;
      }
      if (!okCode(data)) lastErr = data.errmsg || data.msg || `code=${data.code}`;
    } catch (e) {
      lastErr = e.message || String(e);
    }
  }
  return { roles, error: roles.length ? null : lastErr };
}

async function fetchCurrency(session, actInfo, role) {
  const cfg = session.cfg || loadConfig();
  const body = {
    currencyType: cfg.currencyType,
    actId: (actInfo && actInfo.actId) || getActId(cfg),
  };
  if (role && role.roleId) {
    body.roleInfo = {
      roleId: role.roleId,
      server: role.server,
      appKey: role.appKey || resolveAppKey(actInfo, cfg),
    };
  }
  const data = await postAct(session, 'getCurrencyInfo', body);
  const result = unwrap(data);
  const balance = result.balance != null ? Number(result.balance) : Number(result.currencyBalance);
  return {
    ok: okCode(data),
    balance: Number.isFinite(balance) ? balance : null,
    currencyType: result.currencyType || cfg.currencyType,
    currencyName: cfg.currencyName || '积分',
    raw: data,
    message: okCode(data) ? null : data.errmsg || data.msg || '积分查询失败',
  };
}

function collectGoodsList(data) {
  const result = unwrap(data);
  const bags = [result.exchangeList, result.list, result.goodsList, result.items, result.records];
  for (const bag of bags) {
    if (Array.isArray(bag) && bag.length) return bag;
  }
  if (Array.isArray(result)) return result;
  return [];
}

async function fetchGoodsList(session, actInfo) {
  const cfg = session.cfg || loadConfig();
  const fields = (cfg.goodsFields || loadConfig().goodsFields) || {};
  const params = moduleParams(actInfo, cfg);
  const body = {
    ...params,
    pageSize: 100,
    pageNum: 0,
  };
  let data = await postAct(session, 'getExchangeList', body);
  let list = collectGoodsList(data);
  if (!list.length) {
    const alt = await postAct(session, 'getExchangeList', {
      ...params,
      pageSize: 100,
      pageNo: 1,
    });
    if (collectGoodsList(alt).length) {
      data = alt;
      list = collectGoodsList(alt);
    }
  }
  const goods = list.map((item) => normalizeGoods(item, fields)).filter((g) => g.id);
  return {
    ok: okCode(data) || goods.length > 0,
    goods,
    module: params,
    raw: data,
    message: goods.length || okCode(data) ? null : data.errmsg || data.msg || '商品列表为空',
  };
}

async function fetchProfile(account) {
  const session = createMallSession(account);
  const cfg = session.cfg;
  const actData = await warmupMallSession(session);
  let actInfo = unwrap(actData);
  if (isSessionExpired(actData) || !isLoggedActInfo(actInfo)) {
    if (!okCode(actData) && !isSessionExpired(actData)) {
      throw new Error(actData.errmsg || actData.msg || '活动信息失败，请确认账号在线');
    }
    throw new Error(SESSION_EXPIRED_MSG);
  }
  const { roles } = await fetchRoles(session, actInfo);
  let role = roleFromActInfo(actInfo);
  if (!role && roles.length) {
    const pick = roles[0];
    const actId = actInfo.actId || getActId(cfg);
    const bind = await postAct(session, 'bindRole', {
      appKey: pick.appKey || resolveAppKey(actInfo, cfg),
      roleId: pick.roleId,
      server: pick.server,
      actId,
    });
    if (okCode(bind)) {
      const again = await postAct(session, 'actInfo', { actId });
      actInfo = unwrap(again);
      role = roleFromActInfo(actInfo) || pick;
    } else {
      role = pick;
    }
  }
  if (role && !role.appKey) role.appKey = resolveAppKey(actInfo, cfg);
  if (role && (!role.roleName || role.roleName === role.roleId || !role.serverName)) {
    try {
      const detailData = await postAct(session, 'getRoleDetail', {
        appKey: role.appKey,
        roleId: role.roleId,
        server: role.server,
      });
      const detail = normalizeRole(unwrap(detailData)) || normalizeRole(detailData.result);
      if (detail) {
        role = {
          ...role,
          roleName: detail.roleName && detail.roleName !== detail.roleId ? detail.roleName : role.roleName,
          serverName: detail.serverName || role.serverName,
          server: detail.server || role.server,
        };
      }
    } catch (_) {}
  }
  const currency = await fetchCurrency(session, actInfo, role).catch((e) => ({
    ok: false,
    balance: null,
    message: e.message || String(e),
  }));
  return {
    actAccount:
      actInfo.actAccount ||
      actInfo.account ||
      (actInfo.user && actInfo.user.actAccount) ||
      account.actAccount ||
      null,
    currentTime: actInfo.currentTime || null,
    appKey: resolveAppKey(actInfo, cfg),
    role,
    roles,
    currency,
    actInfo,
  };
}

async function fetchGoods(account) {
  const session = createMallSession(account);
  const actData = await warmupMallSession(session);
  const actInfo = unwrap(actData);
  if (!okCode(actData) && !actInfo.uid && !actInfo.actAccount) {
    throw new Error(actData.errmsg || actData.msg || '无法拉取商城（会话可能失效）');
  }
  const listed = await fetchGoodsList(session, actInfo);
  return {
    ...listed,
    actAccount: actInfo.actAccount || account.actAccount || null,
    currentTime: actInfo.currentTime || null,
  };
}

async function bindRole(account, role) {
  if (!role || !role.roleId) return { ok: false, message: '未选择角色' };
  const session = createMallSession(account);
  const cfg = session.cfg;
  await warmupMallSession(session);
  const data = await postAct(session, 'bindRole', {
    appKey: role.appKey || cfg.appKey,
    roleId: role.roleId,
    server: role.server,
    actId: getActId(cfg),
  });
  return {
    ok: okCode(data),
    message: okCode(data) ? '已绑定角色' : data.errmsg || data.msg || '绑定失败',
    raw: data,
  };
}

async function exchangePrize(session, { exchangeId, role, appKey }) {
  return postAct(session, 'exchangePrize', {
    exchangeId,
    roleId: role && role.roleId,
    server: role && role.server,
    appKey: appKey || (role && role.appKey),
  });
}

function isExchangeSuccess(resp) {
  if (!resp || typeof resp !== 'object') return false;
  const code = resp.code != null ? Number(resp.code) : NaN;
  return code === 200;
}

function isAlreadyExchanged(resp) {
  if (!resp || typeof resp !== 'object') return false;
  const msg = String(resp.errmsg || resp.message || resp.msg || '');
  return /已兑换|已经兑换|兑换次数|达到上限|兑换过/.test(msg);
}

function isSoldOut(resp) {
  if (!resp || typeof resp !== 'object') return false;
  const msg = String(resp.errmsg || resp.message || resp.msg || '');
  return /库存|售罄|没有库存|已抢完|发完/.test(msg);
}

function isSessionExpired(resp) {
  if (!resp || typeof resp !== 'object') return false;
  const code = resp.code != null ? Number(resp.code) : NaN;
  if (code === 873) return true;
  const msg = String(resp.errmsg || resp.message || '');
  return /离开太久|重新登录|刷新页面/.test(msg);
}

module.exports = {
  loadConfig,
  createMallSession,
  warmupMallSession,
  fetchProfile,
  fetchGoods,
  fetchGoodsList,
  fetchCurrency,
  bindRole,
  exchangePrize,
  moduleParams,
  normalizeGoods,
  normalizeRole,
  formatStartAt,
  isExchangeSuccess,
  isAlreadyExchanged,
  isSoldOut,
  isSessionExpired,
  postAct,
  unwrap,
};
