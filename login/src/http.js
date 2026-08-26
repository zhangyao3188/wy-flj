const axios = require('axios');
const crypto = require('crypto');
const { CookieJar } = require('tough-cookie');
const { wrapper } = require('axios-cookiejar-support');
const { v4: uuidv4 } = require('uuid');
const C = require('./constants');

function sha1Hex(text) {
  return crypto.createHash('sha1').update(String(text), 'utf8').digest('hex');
}

function readCookie(jar, name) {
  for (const url of [
    'https://pay.ds.163.com/',
    'https://pay-api.ds.163.com/',
    'https://inf.ds.163.com/',
    'https://inf-act.ds.163.com/',
    'https://act.ds.163.com/',
  ]) {
    try {
      const hit = jar.getCookiesSync(url).find((c) => c.key === name);
      if (hit && hit.value) return hit.value;
    } catch (_) {}
  }
  return null;
}

/**
 * 与前端 / seckill 一致：POST 需 GL-CheckSum = SHA1(body + XSRF)
 * 缺签名时 get-info 会返回 825「签名无效」，等级会被误判为 V1
 */
function attachGlHeaders(client, jar, { deviceId }) {
  client.interceptors.request.use((config) => {
    const method = String(config.method || 'get').toLowerCase();
    const xsrf =
      readCookie(jar, 'GL-XSRF-TOKEN') ||
      client.defaults.headers.common['GL-X-XSRF-TOKEN'] ||
      '';
    const uid =
      readCookie(jar, 'GOD_UUID') ||
      client.defaults.headers.common['GL-Uid'] ||
      client.defaults.headers.common['gl-uid'] ||
      '';

    config.headers = config.headers || {};
    config.headers['GL-DeviceId'] =
      client.defaults.headers.common['GL-DeviceId'] ||
      client.defaults.headers.common['gl-deviceid'] ||
      deviceId;
    config.headers['GL-ClientType'] = '60';
    if (xsrf) config.headers['GL-X-XSRF-TOKEN'] = xsrf;
    if (uid) {
      config.headers['GL-Uid'] = uid;
      config.headers['gl-uid'] = uid;
    }

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
    return config;
  });
}

function createSession() {
  const jar = new CookieJar();
  const deviceId = uuidv4();
  const client = wrapper(
    axios.create({
      jar,
      withCredentials: true,
      timeout: 20000,
      headers: {
        'User-Agent': C.UA,
        Accept: 'application/json, text/plain, */*',
        Origin: C.PAY_ORIGIN,
        Referer: `${C.PAY_ORIGIN}/`,
        'GL-ClientType': '60',
        'GL-DeviceId': deviceId,
      },
      validateStatus: () => true,
    })
  );
  attachGlHeaders(client, jar, { deviceId });
  return { client, jar, deviceId };
}

function jarToJSON(jar) {
  const urls = [
    'https://pay.ds.163.com/',
    'https://pay-api.ds.163.com/',
    'https://inf.ds.163.com/',
    'https://inf-act.ds.163.com/',
    'https://dl.reg.163.com/',
    'https://reg.163.com/',
    'https://service.mkey.163.com/',
  ];
  const map = new Map();
  for (const url of urls) {
    try {
      for (const c of jar.getCookiesSync(url)) {
        map.set(`${c.key}@${c.domain}`, {
          name: c.key,
          value: c.value,
          domain: c.domain,
          path: c.path || '/',
        });
      }
    } catch (_) {}
  }
  return Array.from(map.values());
}

function applyCookieMap(jar, cookieMap = {}) {
  for (const [name, value] of Object.entries(cookieMap)) {
    if (!name || value == null || value === '') continue;
    // 只写一份宽域 cookie，避免同名重复导致会话校验失败
    const cookieStr = `${name}=${value}; Domain=.163.com; Path=/`;
    for (const url of [
      'https://pay.ds.163.com/',
      'https://pay-api.ds.163.com/',
      'https://inf.ds.163.com/',
      'https://inf-act.ds.163.com/',
    ]) {
      try {
        jar.setCookieSync(cookieStr, url);
      } catch (_) {
        try {
          jar.setCookieSync(`${name}=${value}; Path=/`, url);
        } catch (__) {}
      }
    }
  }
}

async function ensureXsrf(client, jar) {
  await client.get(`${C.PAY_API}/v1/web/init/server/time`);
  let xsrf = null;
  for (const url of ['https://pay-api.ds.163.com/', 'https://pay.ds.163.com/']) {
    const hit = jar.getCookiesSync(url).find((c) => c.key === 'GL-XSRF-TOKEN');
    if (hit) {
      xsrf = hit.value;
      break;
    }
  }
  if (xsrf) {
    client.defaults.headers.common['GL-X-XSRF-TOKEN'] = xsrf;
  }
  return xsrf;
}

module.exports = {
  createSession,
  jarToJSON,
  applyCookieMap,
  ensureXsrf,
  attachGlHeaders,
};
