const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { CookieJar } = require('tough-cookie');
const { wrapper } = require('axios-cookiejar-support');
const { v4: uuidv4 } = require('uuid');

const PAY_ORIGIN = 'https://pay.ds.163.com';
const PAY_API = 'https://pay-api.ds.163.com';
const INF = 'https://inf.ds.163.com';
const INF_ACT = 'https://inf-act.ds.163.com';
/** 活动 actInfo 用于取 currentTime（任意登录账号可调） */
const ACT_INFO_ID = process.env.ACT_ID || '656d6d6b6085e70001ac05df';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const LOG_DIR = path.resolve(__dirname, '../log');

/** serverTime ≈ Date.now() + serverOffsetMs */
let serverOffsetMs = 0;

function nowMs() {
  return Date.now() + serverOffsetMs;
}

function getServerOffsetMs() {
  return serverOffsetMs;
}

function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

function createLogWriter(mobile) {
  ensureLogDir();
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const safeMobile = String(mobile || 'unknown').replace(/\W/g, '');
  const filePath = path.join(LOG_DIR, `seckill-${safeMobile}-${day}.log`);
  return {
    filePath,
    write(text) {
      fs.appendFileSync(filePath, text.endsWith('\n') ? text : `${text}\n`, 'utf8');
    },
  };
}

function normalizeDomain(domain) {
  if (!domain) return '.ds.163.com';
  const d = String(domain).replace(/^\./, '');
  if (d === '163.com' || d.endsWith('.163.com')) return `.${d}`;
  return `.${d}`;
}

function sha1Hex(text) {
  return crypto.createHash('sha1').update(String(text), 'utf8').digest('hex');
}

function readCookie(jar, name) {
  for (const url of [
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

/**
 * 与前端 axios 拦截器一致：
 * GL-CheckSum = SHA1(JSON.stringify(body) + GL-X-XSRF-TOKEN)
 */
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

    config.metadata = { startAt: nowMs() };
    return config;
  });
}

function formatHeaders(headers) {
  if (!headers) return {};
  const raw = typeof headers.toJSON === 'function' ? headers.toJSON() : { ...headers };
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v == null) continue;
    out[k] = v;
  }
  return out;
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

function buildUrl(config) {
  const base = config.baseURL || '';
  const url = config.url || '';
  if (/^https?:\/\//i.test(url)) return url;
  return `${base}${url}`;
}

/** 校准后的服务器时间戳 → 精确到毫秒的可读字符串 */
function formatServerTime(ms) {
  const t = Number(ms);
  const d = new Date(Number.isFinite(t) ? t : nowMs());
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return (
    `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(
      d.getMilliseconds(),
      3
    )}`
  );
}

function logHttpExchange(writer, config, response, error) {
  if (!writer) return;
  const sep = '============================================================';
  const startAt =
    (config && config.metadata && config.metadata.startAt) != null
      ? config.metadata.startAt
      : nowMs();
  const endAt = nowMs();
  const costMs = Math.max(0, endAt - startAt);
  const method = String((config && config.method) || 'get').toUpperCase();
  const reqPath = config ? buildUrl(config) : '';
  const params = {
    query: (config && config.params) || null,
    body: config ? parseBody(config.data) : null,
  };
  const headers = formatHeaders(config && config.headers);
  let result;
  if (error && !response) {
    result = {
      error: true,
      message: error.message || String(error),
      code: error.code,
    };
  } else {
    result = {
      httpStatus: response && response.status,
      data: response && response.data,
    };
  }

  writer.write(
    [
      sep,
      `[请求时间] ${formatServerTime(startAt)}`,
      `[响应时间] ${formatServerTime(endAt)}`,
      `[耗时] ${costMs}ms`,
      `[请求路径] ${reqPath}`,
      `[请求方式] ${method}`,
      `[请求参数] ${JSON.stringify(params)}`,
      `[请求头] ${JSON.stringify(headers)}`,
      `[响应结果] ${JSON.stringify(result)}`,
      sep,
      '',
    ].join('\n')
  );
}

function attachHttpLogger(client, writer) {
  client.interceptors.response.use(
    (response) => {
      logHttpExchange(writer, response.config, response, null);
      return response;
    },
    (error) => {
      logHttpExchange(writer, error.config || {}, error.response, error);
      return Promise.reject(error);
    }
  );
}

function createClientFromUser(user) {
  const jar = new CookieJar();
  const byName = new Map();

  for (const c of user.cookies || []) {
    if (!c || !c.name || c.value == null || c.value === '') continue;
    const prev = byName.get(c.name);
    const domain = normalizeDomain(c.domain);
    if (!prev || domain === '.163.com' || (domain === '.ds.163.com' && prev.domain !== '.163.com')) {
      byName.set(c.name, { name: c.name, value: c.value, domain, path: c.path || '/' });
    }
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
      'https://pay.ds.163.com/',
      'https://pay-api.ds.163.com/',
      'https://inf.ds.163.com/',
    ]) {
      try {
        jar.setCookieSync(cookieStr, url);
      } catch (_) {}
    }
  }

  const deviceId = user.deviceId || uuidv4();
  const client = wrapper(
    axios.create({
      jar,
      withCredentials: true,
      timeout: 15000,
      headers: {
        'User-Agent': UA,
        Accept: 'application/json, text/plain, */*',
        Origin: PAY_ORIGIN,
        Referer: `${PAY_ORIGIN}/`,
        'Content-Type': 'application/json;charset=UTF-8',
        'GL-ClientType': '60',
        'GL-DeviceId': deviceId,
        ...(user.godUuid ? { 'GL-Uid': user.godUuid } : {}),
      },
      validateStatus: () => true,
    })
  );

  attachGlHeaders(client, jar, { deviceId, godUuid: user.godUuid });
  const logWriter = createLogWriter(user.mobile);
  attachHttpLogger(client, logWriter);
  return { client, jar, logFile: logWriter.filePath };
}

async function ensureXsrf(client, jar) {
  await client.get(`${PAY_API}/v1/web/init/server/time`).catch(() => {});
  const xsrf = readCookie(jar, 'GL-XSRF-TOKEN');
  if (xsrf) {
    client.defaults.headers.common['GL-X-XSRF-TOKEN'] = xsrf;
  }
  return xsrf || null;
}

async function ensureSession(client) {
  const nlogin = await client.get(`${PAY_API}/api/nlogin`, { params: {} });
  return nlogin.data;
}

/** 页面「刷新/更新 cookie」接口：GET cookie-exchange，新 cookie 由 jar 自动承接 */
async function cookieExchange(client) {
  const res = await client.get(`${INF}/v1/web/cooperate/plutus/cookie-exchange`);
  return res.data;
}

function isSessionExpired(resp) {
  if (!resp || typeof resp !== 'object') return false;
  const code = resp.code != null ? Number(resp.code) : NaN;
  if (code === 873) return true;
  const msg = String(resp.errmsg || resp.message || '');
  return /离开太久|重新登录|刷新页面/.test(msg);
}

/** 抢购成功：acquire 返回 code=200 且 result.received=true */
function isAcquireSuccess(resp) {
  if (!resp || typeof resp !== 'object') return false;
  const code = resp.code != null ? Number(resp.code) : NaN;
  if (code !== 200) return false;
  const result = resp.result || resp.data || null;
  if (result && result.received === true) return true;
  return false;
}

/** 已领取 / 无需再抢 */
function isAlreadyAcquired(resp) {
  if (!resp || typeof resp !== 'object') return false;
  const msg = String(resp.errmsg || resp.message || '');
  if (/已领取|已经领取|重复领取/.test(msg)) return true;
  const result = resp.result || resp.data || null;
  if (result && (result.acquiredStatus === 'ACQUIRED' || result.received === true)) {
    return true;
  }
  return false;
}

function jarToCookieList(jar) {
  const map = new Map();
  for (const url of [
    'https://pay.ds.163.com/',
    'https://pay-api.ds.163.com/',
    'https://inf.ds.163.com/',
    'https://www.163.com/',
  ]) {
    try {
      for (const c of jar.getCookiesSync(url)) {
        if (!c || !c.key) continue;
        map.set(c.key, {
          name: c.key,
          value: c.value,
          domain: c.domain || '.ds.163.com',
          path: c.path || '/',
        });
      }
    } catch (_) {}
  }
  return Array.from(map.values());
}

function jarToCookieHeader(jar) {
  return jarToCookieList(jar)
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
}

function toMs(ts) {
  if (ts == null) return NaN;
  const n = typeof ts === 'number' ? ts : Number(ts);
  if (!Number.isFinite(n)) {
    const d = new Date(ts);
    return d.getTime();
  }
  return n > 1e12 ? n : n * 1000;
}

function normalizeLevel(level) {
  if (level == null || level === '') return 'V1';
  const s = String(level).trim().toUpperCase();
  if (/^V\d+$/.test(s)) return s;
  const m = s.match(/(\d+)/);
  if (m) return `V${m[1]}`;
  return s.startsWith('V') ? s : `V${s}`;
}

function levelRank(level) {
  const m = String(normalizeLevel(level)).match(/V?(\d+)/i);
  return m ? Number(m[1]) : 0;
}

/** POST /v1/web/exp/xy/user/get-info → 账号最大可抢档位 currentLv */
async function fetchXyUserInfo(client) {
  const res = await client.post(`${INF}/v1/web/exp/xy/user/get-info`, {});
  return res.data;
}

function parseCurrentLv(vipData) {
  if (!vipData || typeof vipData !== 'object') return null;
  const result = vipData.result || vipData.data || vipData;
  const raw =
    result.currentLv ||
    result.maxLv ||
    result.level ||
    result.vipLevel ||
    (result.user && (result.user.currentLv || result.user.level)) ||
    null;
  return raw != null && raw !== '' ? normalizeLevel(raw) : null;
}

/**
 * 解析账号最大档位：优先 get-info.currentLv；
 * 若列表里有不超过该等级的券，取其中最高档（通常等于 currentLv）。
 */
function resolveMaxVipLevel(vipData, listResult, fallback) {
  const fromApi = parseCurrentLv(vipData);
  let level = fromApi || (fallback ? normalizeLevel(fallback) : null);
  if (!level) level = 'V1';

  const coupons =
    (listResult && (listResult.coupons || listResult.list || listResult.items)) || [];
  if (coupons.length && fromApi) {
    const maxAllowed = levelRank(fromApi);
    let best = 0;
    for (const c of coupons) {
      const r = levelRank(c.xyLevel || c.vipLevel || c.level);
      if (r > 0 && r <= maxAllowed && r > best) best = r;
    }
    if (best > 0) level = `V${best}`;
  }
  return normalizeLevel(level);
}

function collectLevelCandidates(listResult, vipLevel) {
  const level = normalizeLevel(vipLevel);
  const coupons = (listResult && (listResult.coupons || listResult.list || listResult.items)) || [];
  const candidates = [];

  for (const coupon of coupons) {
    const xyLevel = normalizeLevel(coupon.xyLevel || coupon.vipLevel || coupon.level);
    if (xyLevel !== level) continue;
    const periods = coupon.periods || [];
    for (const period of periods) {
      const status = period.acquiredStatus || period.status || period.currentStatus;
      candidates.push({
        couponId: coupon.couponId || period.couponId,
        stockId: period.stockId || coupon.stockId || null,
        amount: coupon.amount != null ? coupon.amount : period.amount,
        xyLevel,
        status,
        weekDay: period.weekDay,
        stockRemain: period.stockRemain,
        seckillStartTime: toMs(period.seckillStartTime || period.startTime),
        seckillEndTime: toMs(period.seckillEndTime || period.endTime),
        rawPeriod: period,
        rawCoupon: coupon,
      });
    }
  }
  return candidates;
}

/**
 * 按会员等级选品：
 * 取该等级下全部 NOT_STARTED，选 seckillStartTime 最近（即将开抢）的一场预备。
 */
function pickTargetByVip(listResult, vipLevel, nowMsArg = nowMs()) {
  const level = normalizeLevel(vipLevel);
  const candidates = collectLevelCandidates(listResult, level);

  if (!candidates.length) {
    return { target: null, reason: `未找到会员等级 ${level} 的秒杀商品`, candidates };
  }

  const notStarted = candidates.filter((c) => c.status === 'NOT_STARTED');
  if (!notStarted.length) {
    // 若已开抢，回退到当前可抢/进行中场次，便于调试
    const live = candidates
      .filter((c) => ['PROGRESSING', 'UN_ACQUIRED', 'OUT_OF_STOCK'].includes(c.status))
      .sort((a, b) => a.seckillStartTime - b.seckillStartTime);
    if (live.length) {
      return {
        target: live[0],
        reason: `无 NOT_STARTED，使用当前场次 ${live[0].status}`,
        candidates,
      };
    }
    return { target: null, reason: `等级 ${level} 无 NOT_STARTED 商品`, candidates };
  }

  const upcoming = notStarted
    .filter((c) => Number.isFinite(c.seckillStartTime) && c.seckillStartTime >= nowMsArg - 1000)
    .sort((a, b) => a.seckillStartTime - b.seckillStartTime);

  if (upcoming.length) {
    return {
      target: upcoming[0],
      reason: `使用最近一场 NOT_STARTED（seckillStartTime=${upcoming[0].seckillStartTime}）`,
      candidates,
    };
  }

  notStarted.sort((a, b) => a.seckillStartTime - b.seckillStartTime);
  return {
    target: notStarted[0],
    reason: `使用最早 NOT_STARTED（无未来场次）`,
    candidates,
  };
}

/**
 * 开抢后刷新列表，按 couponId + seckillStartTime 找回同一场次并补齐 stockId
 */
function findSamePeriod(listResult, target) {
  const candidates = collectLevelCandidates(listResult, target.xyLevel);
  const start = target.seckillStartTime;
  return (
    candidates.find(
      (c) =>
        c.couponId === target.couponId &&
        Number.isFinite(c.seckillStartTime) &&
        Math.abs(c.seckillStartTime - start) < 1000
    ) || null
  );
}

async function fetchShowingList(client) {
  const res = await client.post(`${INF}/v1/web/exp/week-coupon/showing-list-v2`, {});
  return res.data;
}

async function acquire(client, { couponId, stockId }) {
  const res = await client.post(`${INF}/v1/web/exp/week-coupon/acquire`, {
    couponId,
    stockId,
  });
  return res.data;
}

/**
 * 同步服务器时间：POST inf-act .../actInfo → result.currentTime
 * 之后用 nowMs() 代替 Date.now() 做倒计时/开火。
 */
async function syncServerTime(client) {
  const localBefore = Date.now();
  const res = await client.post(`${INF_ACT}/v1/act-web/module/common/actInfo`, {
    actId: ACT_INFO_ID,
  });
  const localAfter = Date.now();
  const data = res.data || {};
  const result = data.result || data.data || {};
  const currentTime = Number(result.currentTime);
  if (!Number.isFinite(currentTime)) {
    throw new Error(`actInfo 未返回 currentTime: ${JSON.stringify(data).slice(0, 200)}`);
  }
  const localMid = Math.floor((localBefore + localAfter) / 2);
  serverOffsetMs = currentTime - localMid;
  return {
    currentTime,
    serverOffsetMs,
    rttMs: localAfter - localBefore,
    localNow: localAfter,
    serverNow: nowMs(),
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 毫秒倒计时文案：9.876s */
function formatCountdownMs(ms) {
  const total = Math.max(0, Math.ceil(ms));
  const sec = Math.floor(total / 1000);
  const milli = total % 1000;
  return `${sec}.${String(milli).padStart(3, '0')}s`;
}

/**
 * 等到目标时刻（默认按校准后的服务器时间）。
 * 距目标 ≤ countdownLastMs（默认 10s）时，同行刷新毫秒倒计时。
 */
async function waitUntil(
  targetMs,
  {
    label = '开抢',
    onTick,
    nowFn = nowMs,
    countdownLastMs = 10000,
    quiet = false,
  } = {}
) {
  let printedCountdown = false;
  for (;;) {
    const now = nowFn();
    const left = targetMs - now;
    if (left <= 0) {
      if (printedCountdown && !quiet) process.stdout.write('\n');
      return;
    }
    if (typeof onTick === 'function') onTick(left, now);

    if (left <= countdownLastMs) {
      if (!quiet) {
        process.stdout.write(`\r[${label}] 倒计时 ${formatCountdownMs(left)}   `);
        printedCountdown = true;
      }
      // 末段尽量密：约 1 帧刷新
      await sleep(left > 32 ? 16 : Math.max(1, left));
      continue;
    }

    const step = left > 60000 ? 10000 : left > 15000 ? 1000 : left > 200 ? 50 : left;
    await sleep(Math.max(10, step));
  }
}

module.exports = {
  createClientFromUser,
  ensureXsrf,
  ensureSession,
  cookieExchange,
  isSessionExpired,
  isAcquireSuccess,
  isAlreadyAcquired,
  jarToCookieList,
  jarToCookieHeader,
  fetchXyUserInfo,
  parseCurrentLv,
  resolveMaxVipLevel,
  levelRank,
  pickTargetByVip,
  findSamePeriod,
  fetchShowingList,
  acquire,
  syncServerTime,
  nowMs,
  getServerOffsetMs,
  formatCountdownMs,
  normalizeLevel,
  sleep,
  waitUntil,
  toMs,
  readCookie,
  formatServerTime,
  LOG_DIR,
  ACT_INFO_ID,
};
