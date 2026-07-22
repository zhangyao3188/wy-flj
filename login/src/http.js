const axios = require('axios');
const { CookieJar } = require('tough-cookie');
const { wrapper } = require('axios-cookiejar-support');
const { v4: uuidv4 } = require('uuid');
const C = require('./constants');

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
        'gl-clienttype': '60',
        'gl-deviceid': deviceId,
      },
      validateStatus: () => true,
    })
  );
  return { client, jar, deviceId };
}

function jarToJSON(jar) {
  const urls = [
    'https://pay.ds.163.com/',
    'https://pay-api.ds.163.com/',
    'https://inf.ds.163.com/',
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
    try {
      jar.setCookieSync(`${name}=${value}; Domain=.163.com; Path=/`, 'https://pay.ds.163.com/');
    } catch (_) {
      try {
        jar.setCookieSync(`${name}=${value}; Path=/`, 'https://pay.ds.163.com/');
      } catch (__) {}
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
};
