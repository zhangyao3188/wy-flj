const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { CookieJar } = require('tough-cookie');
const { wrapper } = require('axios-cookiejar-support');
const { v4: uuidv4 } = require('uuid');
const { loadConfig, getActId } = require('./pointsConfig');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const LOG_DIR = path.resolve(__dirname, '../log');

let serverOffsetMs = 0;

function nowMs() {
  return Date.now() + serverOffsetMs;
}

function getServerOffsetMs() {
  return serverOffsetMs;
}

function sha1Hex(text) {
  return crypto.createHash('sha1').update(String(text), 'utf8').digest('hex');
}

function localDayYmd(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

function ensureLogDir(dir = LOG_DIR) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function createLogWriter(mobile, goodsId) {
  const day = localDayYmd();
  const dayDir = path.join(LOG_DIR, day);
  ensureLogDir(dayDir);
  const safeMobile = String(mobile || 'unknown').replace(/\W/g, '');
  const safeGoods = String(goodsId || 'nogoods')
    .replace(/\W/g, '')
    .slice(0, 32);
  const filePath = path.join(dayDir, `points-${safeMobile}-${safeGoods}-${day}.log`);
  let writeChain = Promise.resolve();
  return {
    filePath,
    write(text) {
      const line = text.endsWith('\n') ? text : `${text}\n`;
      writeChain = writeChain
        .then(() => fs.promises.appendFile(filePath, line, 'utf8'))
        .catch((e) => {
          console.error(`[log] ${safeMobile}/${safeGoods} 写盘失败: ${e.message || e}`);
        });
    },
    flush() {
      return writeChain;
    },
  };
}

function normalizeDomain(domain) {
  if (!domain) return '.ds.163.com';
  const d = String(domain).replace(/^\./, '');
  if (d === '163.com' || d.endsWith('.163.com')) return `.${d}`;
  return `.${d}`;
}

function readCookie(jar, name) {
  for (const url of [
    'https://act.ds.163.com/',
    'https://inf-act.ds.163.com/',
    'https://pay.ds.163.com/',
    'https://pay-api.ds.163.com/',
    'https://inf.ds.163.com/',
  ]) {
    try {
      const hit = jar.getCookiesSync(url).find((c) => c.key === name);
      if (hit && hit.value) return hit.value;
    } catch (_) {}
  }
  return null;
}

function attachGlHeaders(client, jar, { deviceId, godUuid }) {
  client.interceptors.request.use((config) => {
    const method = String(config.method || 'get').toLowerCase();
    const xsrf =
      readCookie(jar, 'GL-XSRF-TOKEN') ||
      client.defaults.headers.common['GL-X-XSRF-TOKEN'] ||
      '';
    const uid = readCookie(jar, 'GOD_UUID') || godUuid || '';
    config.headers = config.headers || {};
    config.headers['GL-DeviceId'] = deviceId;
    config.headers['GL-ClientType'] = '60';
    if (xsrf) config.headers['GL-X-XSRF-TOKEN'] = xsrf;
    if (uid) config.headers['GL-Uid'] = uid;
    if (method === 'post') {
      let data = config.data;
      if (data == null || data === '') data = {};
      const bodyStr = typeof data === 'string' ? data : JSON.stringify(data);
      config.headers['GL-CheckSum'] = sha1Hex(bodyStr + xsrf);
      if (typeof data !== 'string') {
        config.data = bodyStr;
        if (!config.headers['Content-Type'] && !config.headers['content-type']) {
          config.headers['Content-Type'] = 'application/json;charset=UTF-8';
        }
      }
    }
    config.metadata = { ...(config.metadata || {}), startAt: nowMs() };
    return config;
  });
}

function buildUrl(config) {
  const base = config.baseURL || '';
  const url = config.url || '';
  if (/^https?:\/\//i.test(url)) return url;
  return `${base}${url}`;
}

function isExchangeRequest(config) {
  if (!config) return false;
  return /\/market\/exchangePrize(?:\?|$|\/)/i.test(buildUrl(config));
}

function formatServerTime(ms) {
  const d = new Date(Number.isFinite(Number(ms)) ? Number(ms) : nowMs());
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes()
  )}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function parseBody(data) {
  if (data == null || data === '') return null;
  if (typeof data === 'string') {
    try {
      return JSON.parse(data);
    } catch (_) {
      return data;
    }
  }
  return data;
}

function logHttpExchange(writer, config, response, error) {
  if (!writer || !isExchangeRequest(config)) return;
  const meta = (config && config.metadata) || {};
  if (meta.warmupAcquire) return;
  const sep = '============================================================';
  const startAt = meta.startAt != null ? meta.startAt : nowMs();
  const endAt = nowMs();
  const method = String((config && config.method) || 'get').toUpperCase();
  let result;
  if (error && !response) {
    result = { error: true, message: error.message || String(error), code: error.code };
  } else {
    result = { httpStatus: response && response.status, data: response && response.data };
  }
  writer.write(
    [
      sep,
      meta.goodsName ? `[商品] ${meta.goodsName} ${meta.exchangeId || ''}` : null,
      meta.fireAt != null ? `[实际开火] ${formatServerTime(meta.fireAt)}` : null,
      `[请求时间] ${formatServerTime(startAt)}`,
      `[响应时间] ${formatServerTime(endAt)}`,
      `[耗时] ${Math.max(0, endAt - startAt)}ms`,
      `[请求路径] ${config ? buildUrl(config) : ''}`,
      `[请求方式] ${method}`,
      `[请求参数] ${JSON.stringify({ body: config ? parseBody(config.data) : null })}`,
      `[响应结果] ${JSON.stringify(result)}`,
      sep,
      '',
    ]
      .filter((line) => line != null)
      .join('\n')
  );
}

function attachHttpLogger(client, writer) {
  client.interceptors.response.use(
    (response) => {
      const cfg = response.config;
      const status = response.status;
      const data = response.data;
      setImmediate(() => {
        try {
          logHttpExchange(writer, cfg, { status, data }, null);
        } catch (e) {
          console.error(`[log] 记录响应失败: ${e.message || e}`);
        }
      });
      return response;
    },
    (error) => {
      const cfg = error.config || {};
      const resp = error.response;
      setImmediate(() => {
        try {
          logHttpExchange(
            writer,
            cfg,
            resp ? { status: resp.status, data: resp.data } : null,
            error
          );
        } catch (e) {
          console.error(`[log] 记录错误失败: ${e.message || e}`);
        }
      });
      return Promise.reject(error);
    }
  );
}

function createClientFromUser(user, options = {}) {
  const cfg = loadConfig();
  const jar = options.jar || new CookieJar();
  if (!options.jar) {
    const byName = new Map();
    for (const c of user.cookies || []) {
      if (!c || !c.name || c.value == null || c.value === '') continue;
      const domain = normalizeDomain(c.domain);
      byName.set(c.name, { name: c.name, value: c.value, domain, path: c.path || '/' });
    }
    if (user.cookieHeader) {
      for (const part of String(user.cookieHeader).split(';')) {
        const idx = part.indexOf('=');
        if (idx <= 0) continue;
        const name = part.slice(0, idx).trim();
        const value = part.slice(idx + 1).trim();
        if (!name || byName.has(name)) continue;
        byName.set(name, { name, value, domain: '.163.com', path: '/' });
      }
    }
    for (const c of byName.values()) {
      const cookieStr = `${c.name}=${c.value}; Domain=${c.domain}; Path=${c.path}`;
      for (const url of [
        'https://act.ds.163.com/',
        'https://inf-act.ds.163.com/',
        'https://pay.ds.163.com/',
        'https://pay-api.ds.163.com/',
        'https://inf.ds.163.com/',
      ]) {
        try {
          jar.setCookieSync(cookieStr, url);
        } catch (_) {}
      }
    }
  }
  const deviceId = user.deviceId || uuidv4();
  const origin = cfg.hosts.act;
  const client = wrapper(
    axios.create({
      jar,
      withCredentials: true,
      timeout: 15000,
      headers: {
        'User-Agent': UA,
        Accept: 'application/json, text/plain, */*',
        Origin: origin,
        Referer: `${cfg.pageUrl}/`,
        'Content-Type': 'application/json;charset=UTF-8',
        'GL-ClientType': '60',
        'GL-DeviceId': deviceId,
        ...(user.godUuid ? { 'GL-Uid': user.godUuid } : {}),
      },
      validateStatus: () => true,
    })
  );
  attachGlHeaders(client, jar, { deviceId, godUuid: user.godUuid });
  let logFile = null;
  if (!options.silent) {
    const logWriter = createLogWriter(user.mobile, user.goodsId);
    attachHttpLogger(client, logWriter);
    logFile = logWriter.filePath;
  }
  return { client, jar, logFile, cfg };
}

function infAct(cfg) {
  return cfg.hosts.infAct;
}

function api(cfg, name) {
  return cfg.apis[name];
}

async function ensureXsrf(client, jar) {
  const cfg = loadConfig();
  await client.get(`${cfg.hosts.payApi}/v1/web/init/server/time`).catch(() => {});
  const xsrf = readCookie(jar, 'GL-XSRF-TOKEN');
  if (xsrf) client.defaults.headers.common['GL-X-XSRF-TOKEN'] = xsrf;
  return xsrf || null;
}

async function ensureSession(client) {
  const cfg = loadConfig();
  const nlogin = await client.get(`${cfg.hosts.payApi}/api/nlogin`, { params: {} });
  return nlogin.data;
}

async function cookieExchange(client) {
  const cfg = loadConfig();
  const res = await client.get(`${cfg.hosts.inf}/v1/web/cooperate/plutus/cookie-exchange`);
  return res.data;
}

async function postAct(client, name, body, extraConfig) {
  const cfg = loadConfig();
  const res = await client.post(`${infAct(cfg)}${api(cfg, name)}`, body || {}, extraConfig || {});
  return res.data || {};
}

function unwrap(data) {
  return (data && (data.result || data.data)) || {};
}

async function fetchActInfo(client) {
  const cfg = loadConfig();
  const data = await postAct(client, 'actInfo', { actId: getActId(cfg) });
  return unwrap(data);
}

async function syncServerTime(client) {
  const localBefore = Date.now();
  const result = await fetchActInfo(client);
  const localAfter = Date.now();
  const currentTime = Number(result.currentTime);
  if (!Number.isFinite(currentTime)) {
    throw new Error(`actInfo 未返回 currentTime: ${JSON.stringify(result).slice(0, 200)}`);
  }
  const localMid = Math.floor((localBefore + localAfter) / 2);
  serverOffsetMs = currentTime - localMid;
  return { currentTime, serverOffsetMs, rttMs: localAfter - localBefore };
}

function moduleParams(actInfo) {
  const cfg = loadConfig();
  const list = (actInfo && (actInfo.moduleList || actInfo.modules)) || [];
  const asType = Number(cfg.asType || 10);
  const hit =
    list.find((m) => Number(m.asType) === asType && (!cfg.marketId || String(m.asId) === String(cfg.marketId))) ||
    list.find((m) => Number(m.asType) === asType);
  return {
    actId: (hit && hit.actId) || (actInfo && actInfo.actId) || cfg.mallActId || cfg.actId,
    asId: (hit && hit.asId) || cfg.marketId,
    asType,
  };
}

async function fetchExchangeList(client, actInfo) {
  const params = moduleParams(actInfo);
  const data = await postAct(client, 'getExchangeList', {
    ...params,
    pageSize: 100,
    pageNum: 0,
  });
  const result = unwrap(data);
  const list = result.exchangeList || result.list || [];
  return { data, list: Array.isArray(list) ? list : [], params };
}

async function exchangePrize(client, { exchangeId, roleId, server, appKey, fireMeta }) {
  return postAct(
    client,
    'exchangePrize',
    { exchangeId, roleId, server, appKey },
    { metadata: fireMeta && typeof fireMeta === 'object' ? fireMeta : {} }
  );
}

function isExchangeSuccess(resp) {
  if (!resp || typeof resp !== 'object') return false;
  return Number(resp.code) === 200;
}

function isAlreadyExchanged(resp) {
  if (!resp || typeof resp !== 'object') return false;
  const msg = String(resp.errmsg || resp.message || resp.msg || '');
  return /已兑换|已经兑换|兑换次数|达到上限|兑换过/.test(msg);
}

function isSessionExpired(resp) {
  if (!resp || typeof resp !== 'object') return false;
  if (Number(resp.code) === 873) return true;
  const msg = String(resp.errmsg || resp.message || '');
  return /离开太久|重新登录|刷新页面/.test(msg);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(targetMs, { label = '开抢', onTick, nowFn = nowMs, countdownLastMs = 10000 } = {}) {
  let printedCountdown = false;
  for (;;) {
    const now = nowFn();
    const left = targetMs - now;
    if (left <= 0) {
      if (printedCountdown) process.stdout.write('\n');
      return;
    }
    if (typeof onTick === 'function') onTick(left);
    if (left <= countdownLastMs) {
      printedCountdown = true;
      const sec = Math.floor(left / 1000);
      const milli = Math.ceil(left) % 1000;
      process.stdout.write(`\r[${label}] ${sec}.${String(milli).padStart(3, '0')}s   `);
      await sleep(Math.min(50, left));
    } else {
      await sleep(Math.min(200, left));
    }
  }
}

function parseStartAt(input, refNow = Date.now()) {
  if (input == null || input === '') return null;
  const s = String(input).trim();
  if (/^\d{13}$/.test(s)) return Number(s);
  if (/^\d{10}$/.test(s)) return Number(s) * 1000;
  const m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (m) {
    return new Date(
      Number(m[1]),
      Number(m[2]) - 1,
      Number(m[3]),
      Number(m[4]),
      Number(m[5]),
      Number(m[6] || 0),
      0
    ).getTime();
  }
  const hm = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (hm) {
    const d = new Date(refNow);
    d.setHours(Number(hm[1]), Number(hm[2]), Number(hm[3] || 0), 0);
    let t = d.getTime();
    if (t <= refNow) t += 24 * 60 * 60 * 1000;
    return t;
  }
  throw new Error(`无法解析开始时间: ${input}（需要 yyyy-mm-dd hh:mm:ss）`);
}

module.exports = {
  createClientFromUser,
  ensureXsrf,
  ensureSession,
  cookieExchange,
  fetchActInfo,
  syncServerTime,
  nowMs,
  getServerOffsetMs,
  fetchExchangeList,
  exchangePrize,
  isExchangeSuccess,
  isAlreadyExchanged,
  isSessionExpired,
  waitUntil,
  parseStartAt,
  sleep,
  unwrap,
  loadConfig,
  moduleParams,
};
