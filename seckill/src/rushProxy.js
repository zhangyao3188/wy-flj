/**
 * 福利金抢购出口代理（移植自 exchange-test-dk-proxy）
 * - shachen：闪臣 HTTP
 * - zdaye：站大爷短效优质代理纯生版 ShortEdgeProxy
 * 切换：RUSH_PROXY_PROVIDER=shachen|zdaye
 * RUSH_PROXY_ENABLED=0 时关闭。
 */
const crypto = require('crypto');
const { HttpsProxyAgent } = require('https-proxy-agent');

const SHACHEN_DEFAULT_API_BASE = 'https://sch.shanchendaili.com/api.html';
const ZDAYE_DEFAULT_API_BASE = 'http://s205.zdtps.com:8080/GetIP/';
const ZDAYE_DEFAULT_OPEN_BASE = 'http://www.zdopen.com';
const PROXY_FETCH_TIMEOUT_MS = 12_000;

function normalizeZdayeApiBase(raw) {
  const text = String(raw || '').trim();
  if (!text) return ZDAYE_DEFAULT_API_BASE;
  try {
    const u = new URL(text);
    u.search = '';
    u.hash = '';
    let out = u.toString();
    if (!/\/GetIP\/?$/i.test(u.pathname)) {
      out = `${u.origin}/GetIP/`;
    } else if (!out.endsWith('/')) {
      out = `${out}/`;
    }
    return out;
  } catch {
    return text.split('?')[0].split('#')[0] || ZDAYE_DEFAULT_API_BASE;
  }
}

let whitelistReady = false;

function isRushProxyEnabled() {
  const raw = String(process.env.RUSH_PROXY_ENABLED ?? '0').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes';
}

/** @returns {'shachen'|'zdaye'} */
function getRushProxyProvider() {
  const raw = String(process.env.RUSH_PROXY_PROVIDER || 'shachen').trim().toLowerCase();
  if (raw === 'zdaye' || raw === 'zd' || raw === '站大爷') return 'zdaye';
  return 'shachen';
}

function zdayeAkeyFromPassword(password) {
  const full = crypto.createHash('md5').update(String(password || ''), 'utf8').digest('hex');
  return full.slice(8, 24);
}

function getRushProxyConfig() {
  const provider = getRushProxyProvider();
  const common = {
    enabled: isRushProxyEnabled(),
    provider,
    qualityMaxMs: Math.max(50, Number(process.env.RUSH_PROXY_QUALITY_MAX_MS ?? 1500) || 1500),
    stopBeforeRushMs: Math.max(0, Number(process.env.RUSH_PROXY_STOP_BEFORE_RUSH_MS ?? 5000) || 0),
    whitelistIp: String(process.env.RUSH_PROXY_WHITELIST_IP || '').trim(),
  };

  if (provider === 'zdaye') {
    const instId = String(
      process.env.RUSH_PROXY_ZDAYE_INST_ID || process.env.RUSH_PROXY_ZDAYE_USERNAME || ''
    ).trim();
    const password = String(process.env.RUSH_PROXY_ZDAYE_PASSWORD || '').trim();
    const akeyEnv = String(process.env.RUSH_PROXY_ZDAYE_AKEY || '').trim();
    const authRaw = String(process.env.RUSH_PROXY_ZDAYE_AUTH || 'userpass').trim().toLowerCase();
    const auth =
      authRaw === 'whitelist' || authRaw === 'white'
        ? 'whitelist'
        : authRaw === 'both' || authRaw === 'all'
          ? 'both'
          : 'userpass';

    return {
      ...common,
      ipTimeMinutes: Math.max(1, Number(process.env.RUSH_PROXY_IP_TIME_MINUTES ?? 5) || 5),
      instId,
      password,
      akey: akeyEnv || (password ? zdayeAkeyFromPassword(password) : ''),
      apiBase: normalizeZdayeApiBase(process.env.RUSH_PROXY_ZDAYE_API_BASE || ZDAYE_DEFAULT_API_BASE),
      openBase:
        String(process.env.RUSH_PROXY_ZDAYE_OPEN_BASE || ZDAYE_DEFAULT_OPEN_BASE).trim() ||
        ZDAYE_DEFAULT_OPEN_BASE,
      dedup: String(process.env.RUSH_PROXY_ZDAYE_DEDUP ?? '0').trim() === '1' ? 1 : 0,
      timespan: Math.min(5, Math.max(1, Number(process.env.RUSH_PROXY_ZDAYE_TIMESPAN ?? 3) || 3)),
      adr: String(process.env.RUSH_PROXY_ZDAYE_ADR || '').trim(),
      auth,
      appKey: instId,
      securityCode: password,
    };
  }

  return {
    ...common,
    appKey: String(process.env.RUSH_PROXY_APP_KEY || '').trim(),
    securityCode: String(
      process.env.RUSH_PROXY_SECURITY_CODE || process.env.RUSH_PROXY_PASSWORD || ''
    ).trim(),
    packageKey: String(process.env.RUSH_PROXY_PACKAGE_KEY || '').trim(),
    apiBase:
      String(process.env.RUSH_PROXY_API_BASE || SHACHEN_DEFAULT_API_BASE).trim() ||
      SHACHEN_DEFAULT_API_BASE,
    ipTimeMinutes: Math.max(1, Number(process.env.RUSH_PROXY_IP_TIME_MINUTES ?? 5) || 5),
  };
}

function buildUrl(base, params) {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) {
    if (value == null || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

async function readJsonResponse(response) {
  const rawText = await response.text();
  let data = null;
  try {
    data = rawText ? JSON.parse(rawText) : null;
  } catch {
    data = { raw: rawText };
  }
  return { data, rawText, httpStatus: response.status };
}

function isValidPublicIpv4(ip) {
  const parts = String(ip || '').split('.');
  if (parts.length !== 4) return false;
  return parts.every((p) => {
    // 禁止前导零，避免把页面噪声误识别成 IP
    if (!/^(0|[1-9]\d{0,2})$/.test(p)) return false;
    const n = Number(p);
    return n >= 0 && n <= 255;
  });
}

async function fetchPublicIp() {
  const endpoints = [
    'https://api.ipify.org?format=text',
    'https://ifconfig.me/ip',
    'https://4.ipw.cn',
  ];
  for (const endpoint of endpoints) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      // eslint-disable-next-line no-await-in-loop
      const res = await fetch(endpoint, {
        signal: controller.signal,
        headers: { Accept: 'text/plain' },
      });
      clearTimeout(timer);
      const text = (await res.text()).trim();
      const ip = text.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/)?.[0];
      if (ip && isValidPublicIpv4(ip)) return ip;
    } catch {
      /* try next */
    }
  }
  return '';
}

function parseExpireAt(raw) {
  if (raw == null || raw === '') return 0;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw < 1e12 ? raw * 1000 : raw;
  }
  const ms = Date.parse(String(raw));
  return Number.isFinite(ms) ? ms : 0;
}

function parseProxyItem(item) {
  if (item == null) return null;
  if (typeof item === 'string' && item.includes(':')) {
    const [ip, port] = item.split(':');
    return { ip: String(ip || '').trim(), port: String(port || '').trim() };
  }
  if (typeof item === 'object') {
    const ip = String(item.sever || item.server || item.ip || '').trim();
    const port = String(item.port || '').trim();
    return { ip, port };
  }
  return null;
}

function buildProxyAgentUrl(ip, port, authUser, authPass) {
  if (authUser && authPass) {
    return `http://${encodeURIComponent(authUser)}:${encodeURIComponent(authPass)}@${ip}:${port}`;
  }
  return `http://${ip}:${port}`;
}

function createProxyAgent(proxyUrl) {
  return new HttpsProxyAgent(proxyUrl);
}

// ---------- 闪臣 ----------

function shachenApiUrl(config, params) {
  return buildUrl(config.apiBase, params);
}

async function listShachenWhitelist(config) {
  const url = shachenApiUrl(config, {
    action: 'whiteList',
    appKey: config.appKey,
  });
  try {
    const response = await fetch(url, { method: 'GET' });
    const { data } = await readJsonResponse(response);
    return Array.isArray(data?.data) ? data.data : [];
  } catch (err) {
    console.warn(`[rush-proxy] 白名单列表查询失败: ${err.message}`);
    return [];
  }
}

function whitelistContainsIp(rows, ip) {
  return rows.some((row) => {
    if (typeof row === 'string') return row.trim() === ip;
    return String(row?.ip || row?.IP || '').trim() === ip;
  });
}

async function addShachenWhitelist(config, ip) {
  const targetIp = String(ip || config.whitelistIp || '').trim();
  if (!targetIp) {
    console.warn('[rush-proxy] 未配置 RUSH_PROXY_WHITELIST_IP 且无法探测本机公网 IP，跳过白名单');
    return { ok: false, skipped: true };
  }

  const existing = await listShachenWhitelist(config);
  if (whitelistContainsIp(existing, targetIp)) {
    console.log(`[rush-proxy] 白名单已包含 ${targetIp}`);
    return { ok: true, ip: targetIp, already: true };
  }

  if (!config.securityCode) {
    console.warn('[rush-proxy] 未配置 RUSH_PROXY_SECURITY_CODE（安全码 anquanma）');
  }

  try {
    const url = shachenApiUrl(config, {
      action: 'addWhiteList',
      appKey: config.appKey,
      anquanma: config.securityCode,
      ip: targetIp,
    });
    const response = await fetch(url, { method: 'GET' });
    const { data, rawText, httpStatus } = await readJsonResponse(response);
    const code = data?.code;
    const ok = code === 0 || code === 200 || String(data?.msg || '').includes('success');
    console.log(
      `[rush-proxy] 白名单添加 ${targetIp}: code=${code} msg=${data?.msg || ''} http=${httpStatus}`
    );
    if (!ok) {
      console.warn(`[rush-proxy] 白名单添加原始响应: ${String(rawText).slice(0, 200)}`);
    }
    return { ok, ip: targetIp, data };
  } catch (err) {
    console.warn(`[rush-proxy] 白名单添加失败: ${err.message}`);
    return { ok: false, ip: targetIp, error: err.message };
  }
}

async function raceTimeout(promise, ms, label = 'timeout') {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), Math.max(1, ms));
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function ensureShachenWhitelist(config) {
  if (whitelistReady || !config.enabled) return;
  if (!config.appKey) {
    console.warn('[rush-proxy] 已开启但未配置 RUSH_PROXY_APP_KEY');
    return;
  }
  try {
    // 白名单探测/添加最多 5s，避免拖死整轮分配
    await raceTimeout(
      (async () => {
        const ip = config.whitelistIp || (await fetchPublicIp());
        await addShachenWhitelist(config, ip);
      })(),
      5000,
      'whitelist-timeout'
    );
  } catch (err) {
    console.warn(`[rush-proxy] 白名单步骤跳过: ${err.message || err}`);
  }
  whitelistReady = true;
}

function isShachenGetIpOkStatus(status) {
  return status === 0 || status === '0' || Number(status) === 0;
}

function extractShachenProxyList(data) {
  const candidates = [data?.list, data?.data, data?.data?.list];
  for (const c of candidates) {
    if (Array.isArray(c) && c.length) return c;
    if (typeof c === 'string' && c.includes(':')) {
      return c
        .split(/[\r\n,;]+/)
        .map((s) => s.trim())
        .filter(Boolean)
        .map((line) => {
          const [ip, port] = line.split(':');
          return { sever: ip, port };
        });
    }
  }
  return [];
}

async function fetchShachenProxies(count, config) {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  if (!n) return [];
  if (!config.appKey) {
    throw new Error('RUSH_PROXY_ENABLED=1 但未配置 RUSH_PROXY_APP_KEY');
  }

  await ensureShachenWhitelist(config);

  const packageKey = config.packageKey || config.appKey;
  const url = shachenApiUrl(config, {
    action: 'get_ip',
    key: packageKey,
    time: config.ipTimeMinutes,
    count: n,
    type: 'json',
    only: 0,
  });

  console.log(
    `[rush-proxy:shachen] 请求提取代理: count=${n} time=${config.ipTimeMinutes}m key=${String(packageKey).slice(0, 6)}…`
  );

  let data;
  let rawText;
  let httpStatus;
  const doFetch = async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROXY_FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(url, { method: 'GET', signal: controller.signal });
      return readJsonResponse(response);
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    ({ data, rawText, httpStatus } = await doFetch());
    if (String(data?.status) === '-13') {
      console.warn('[rush-proxy:shachen] 提取失败：不在白名单，重新添加后重试');
      whitelistReady = false;
      await ensureShachenWhitelist(config);
      ({ data, rawText, httpStatus } = await doFetch());
    }
  } catch (err) {
    throw new Error(`闪臣 get_ip 请求失败: ${err.message || err}`);
  }

  const list = extractShachenProxyList(data);
  if (!isShachenGetIpOkStatus(data?.status) || !list.length) {
    const snippet = String(rawText || JSON.stringify(data) || '').slice(0, 240);
    const msg = data?.info || data?.msg || `获取代理失败 status=${data?.status} list=${list.length}`;
    throw new Error(`${msg} http=${httpStatus} raw=${snippet}`);
  }

  const expireAt = parseExpireAt(data.expire || list[0]?.expire_time || list[0]?.expire);
  const out = [];
  for (const item of list) {
    const parsed = parseProxyItem(item);
    if (!parsed?.ip || !parsed?.port) continue;
    const proxyUrl = buildProxyAgentUrl(parsed.ip, parsed.port);
    out.push({
      ip: parsed.ip,
      port: parsed.port,
      proxyUrl,
      expireAt,
      agent: createProxyAgent(proxyUrl),
      provider: 'shachen',
    });
  }

  console.log(
    `[rush-proxy:shachen] 已获取 ${out.length} 个代理（请求 ${n}） expire=${data.expire || '-'}`
  );
  return out;
}

// ---------- 站大爷 ----------

function zdayeOpenUrl(config, path, params) {
  const base = String(config.openBase || ZDAYE_DEFAULT_OPEN_BASE).replace(/\/+$/, '');
  const p = path.startsWith('/') ? path : `/${path}`;
  return buildUrl(`${base}${p}`, params);
}

async function listZdayeWhitelist(config) {
  const url = zdayeOpenUrl(config, '/ShortEdgeProxy/GetIpWhiteList/', {
    inst_id: config.instId,
    akey: config.akey,
  });
  try {
    const response = await fetch(url, { method: 'GET' });
    const { data } = await readJsonResponse(response);
    return Array.isArray(data?.list) ? data.list : [];
  } catch (err) {
    console.warn(`[rush-proxy:zdaye] 白名单列表查询失败: ${err.message}`);
    return [];
  }
}

async function addZdayeWhitelist(config, ip) {
  const targetIp = String(ip || config.whitelistIp || '').trim();
  const params = {
    inst_id: config.instId,
    akey: config.akey,
  };
  if (targetIp) params.ipList = targetIp;

  try {
    const url = zdayeOpenUrl(config, '/ShortEdgeProxy/AddWhiteIp/', params);
    const response = await fetch(url, { method: 'GET' });
    const { data, rawText, httpStatus } = await readJsonResponse(response);
    const code = String(data?.code ?? '');
    const ok = code === '10001';
    console.log(
      `[rush-proxy:zdaye] 白名单添加 ${targetIp || '(当前出口)'}: code=${code} msg=${data?.msg || ''} http=${httpStatus}`
    );
    if (!ok) {
      console.warn(`[rush-proxy:zdaye] 白名单添加原始响应: ${String(rawText).slice(0, 200)}`);
    }
    return { ok, ip: targetIp, data };
  } catch (err) {
    console.warn(`[rush-proxy:zdaye] 白名单添加失败: ${err.message}`);
    return { ok: false, ip: targetIp, error: err.message };
  }
}

async function ensureZdayeWhitelist(config) {
  if (whitelistReady || !config.enabled) return;
  if (!config.instId || !config.akey) {
    console.warn('[rush-proxy:zdaye] 已开启但未配置 INST_ID / PASSWORD(akey)');
    return;
  }
  const needWhite =
    config.auth === 'whitelist' || config.auth === 'both' || config.auth === 'userpass';
  if (!needWhite) {
    whitelistReady = true;
    return;
  }

  try {
    await raceTimeout(
      (async () => {
        const existing = await listZdayeWhitelist(config);
        const targetIp = config.whitelistIp || (await fetchPublicIp());
        if (targetIp && existing.some((row) => String(row).trim() === targetIp)) {
          console.log(`[rush-proxy:zdaye] 白名单已包含 ${targetIp}`);
          return;
        }
        await addZdayeWhitelist(config, targetIp);
      })(),
      5000,
      'whitelist-timeout'
    );
  } catch (err) {
    console.warn(`[rush-proxy:zdaye] 白名单步骤跳过: ${err.message || err}`);
  }
  whitelistReady = true;
}

async function fetchZdayeProxies(count, config) {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  if (!n) return [];
  if (!config.instId || !config.akey) {
    throw new Error(
      'RUSH_PROXY_PROVIDER=zdaye 需要配置 RUSH_PROXY_ZDAYE_INST_ID 与 RUSH_PROXY_ZDAYE_PASSWORD（或 AKEY）'
    );
  }

  await ensureZdayeWhitelist(config);

  const params = {
    inst_id: config.instId,
    akey: config.akey,
    count: n,
    dedup: config.dedup,
    timespan: config.timespan,
    type: 2,
  };
  if (config.adr) params.adr = config.adr;

  const url = buildUrl(config.apiBase, params);
  console.log(
    `[rush-proxy:zdaye] 请求提取代理: count=${n} timespan=${config.timespan} dedup=${config.dedup}` +
      ` inst=${String(config.instId).slice(0, 8)}… auth=${config.auth}`
  );

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROXY_FETCH_TIMEOUT_MS);
  let data;
  let rawText;
  let httpStatus;
  try {
    let response = await fetch(url, { method: 'GET', signal: controller.signal });
    ({ data, rawText, httpStatus } = await readJsonResponse(response));

    if (String(data?.code) === '12007') {
      console.warn('[rush-proxy:zdaye] 提取失败：未设置白名单，重新添加后重试');
      whitelistReady = false;
      await ensureZdayeWhitelist(config);
      response = await fetch(url, { method: 'GET', signal: controller.signal });
      ({ data, rawText, httpStatus } = await readJsonResponse(response));
    }
  } catch (err) {
    const hint = /timeout|aborted|ECONNREFUSED|UND_ERR_CONNECT/i.test(
      String(err.message || err.cause || '')
    )
      ? '（若连不上 :8080，请到站大爷后台复制完整提取域名填入 RUSH_PROXY_ZDAYE_API_BASE）'
      : '';
    throw new Error(`站大爷 GetIP 请求失败: ${err.message}${hint}`);
  } finally {
    clearTimeout(timer);
  }

  const code = String(data?.code ?? '');
  const list = Array.isArray(data?.data?.proxy_list) ? data.data.proxy_list : [];
  if (code !== '10001' || !list.length) {
    const snippet = String(rawText || JSON.stringify(data) || '').slice(0, 240);
    const msg = data?.msg || `获取代理失败 code=${code} list=${list.length}`;
    throw new Error(`${msg} http=${httpStatus} raw=${snippet}`);
  }

  const useUserPass = config.auth === 'userpass' || config.auth === 'both';
  const authUser = useUserPass ? config.instId : '';
  const authPass = useUserPass ? config.password : '';

  const out = [];
  for (const item of list) {
    const parsed = parseProxyItem(item);
    if (!parsed?.ip || !parsed?.port) continue;
    const expiredSeconds = Number(item?.expired_seconds);
    const expireAt =
      Number.isFinite(expiredSeconds) && expiredSeconds > 0
        ? Date.now() + expiredSeconds * 1000
        : 0;
    const proxyUrl = buildProxyAgentUrl(parsed.ip, parsed.port, authUser, authPass);
    out.push({
      ip: parsed.ip,
      port: parsed.port,
      proxyUrl,
      expireAt,
      agent: createProxyAgent(proxyUrl),
      provider: 'zdaye',
      outIp: item?.out_ip || '',
      adr: item?.adr || '',
    });
  }

  console.log(
    `[rush-proxy:zdaye] 已获取 ${out.length} 个代理（请求 ${n}） today_left=${data?.data?.today_left_count ?? '-'}`
  );
  return out;
}

/**
 * @param {number} count
 * @param {{ timeoutMs?: number }} [options]
 */
async function fetchProxies(count, options = {}) {
  const config = getRushProxyConfig();
  if (!config.enabled) return [];
  const run =
    config.provider === 'zdaye'
      ? () => fetchZdayeProxies(count, config)
      : () => fetchShachenProxies(count, config);
  const timeoutMs = Number(options.timeoutMs);
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    return raceTimeout(run(), timeoutMs, `fetchProxies-timeout(${timeoutMs}ms)`);
  }
  return run();
}

async function ensureWhitelist(config = getRushProxyConfig()) {
  if (!config.enabled) return;
  if (config.provider === 'zdaye') {
    await ensureZdayeWhitelist(config);
    return;
  }
  await ensureShachenWhitelist(config);
}

module.exports = {
  isRushProxyEnabled,
  getRushProxyProvider,
  getRushProxyConfig,
  ensureWhitelist,
  fetchProxies,
  fetchPublicIp,
  createProxyAgent,
  zdayeAkeyFromPassword,
};
