/**
 * 从抓包 curl / Cookie 原文解析登录 Cookie
 * 支持：Chrome/Edge「复制为 cURL」、Charles、Fiddler、纯 Cookie 头、多段粘贴合并
 */

function unescapeShell(str) {
  if (str == null) return '';
  let s = String(str);
  // 去掉包裹引号
  if (
    (s.startsWith("'") && s.endsWith("'")) ||
    (s.startsWith('"') && s.endsWith('"'))
  ) {
    s = s.slice(1, -1);
  }
  // bash $'...'
  if (s.startsWith("$'") && s.endsWith("'")) {
    s = s.slice(2, -1);
  }
  return s
    .replace(/\\'/g, "'")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t');
}

/** 规范化换行与续行符（bash \ / PowerShell `） */
function normalizeCurlText(raw) {
  let text = String(raw || '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
  // 续行：行末 \ 或 `
  text = text.replace(/\\\n/g, ' ').replace(/`\n/g, ' ');
  return text.trim();
}

function parseCookiePairString(cookieStr) {
  const cookies = {};
  if (!cookieStr) return cookies;
  const parts = String(cookieStr).split(';');
  for (const part of parts) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const name = part.slice(0, idx).trim();
    let value = part.slice(idx + 1).trim();
    // 去掉可能残留的引号
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!name || value === '') continue;
    if (/^['"]/.test(name) || /['"]$/.test(name)) continue;
    // Set-Cookie 属性不是登录 cookie
    if (/^(Path|Domain|Expires|Max-Age|Secure|HttpOnly|SameSite)$/i.test(name)) {
      continue;
    }
    cookies[name] = value;
  }
  return cookies;
}

/**
 * 从文本中提取所有 Cookie 片段（-H Cookie / -b / Cookie: 行）
 */
function extractCookieStrings(text) {
  const found = [];
  const patterns = [
    // -H 'Cookie: ...' / -H "Cookie: ..." / --header ...
    /(?:-H|--header)\s+(['"])(?:Cookie|cookie)\s*:\s*([\s\S]*?)\1/gi,
    // -H Cookie:...（无引号，到下一个 - 或结尾）
    /(?:-H|--header)\s+(?:Cookie|cookie)\s*:\s*([^\n]+)/gi,
    // -b / --cookie / --cookies（带引号）
    /(?:-b|--cookie|--cookies)\s+(['"])([\s\S]*?)\1/gi,
    // -b 无引号（避免再匹配已带引号的参数）
    /(?:-b|--cookie|--cookies)\s+(?!['"])(\S+)/gi,
    // 独立 Cookie / cookie 头行（抓包原文）
    /^(?:Cookie|cookie)\s*:\s*(.+)$/gim,
  ];

  for (const re of patterns) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      let raw;
      if (m.length >= 3 && m[2] != null) {
        raw = m[2];
      } else {
        raw = m[1];
      }
      const val = unescapeShell(raw).trim();
      if (val) found.push(val);
    }
  }
  return found;
}

/** 从 curl -H 提取可能有用的头（写入 cookie 或 client 头） */
function extractUsefulHeaders(text) {
  const headers = {};
  const re = /(?:-H|--header)\s+(['"])([^'"]+)\1/gi;
  let m;
  while ((m = re.exec(text))) {
    const line = unescapeShell(m[2]);
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const name = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (!name || !value) continue;
    headers[name.toLowerCase()] = value;
  }
  // 无引号头
  const re2 = /(?:-H|--header)\s+([A-Za-z0-9_-]+)\s*:\s*([^\n\\]+)/gi;
  while ((m = re2.exec(text))) {
    const name = m[1].trim();
    const value = m[2].trim();
    if (!name || !value) continue;
    if (!headers[name.toLowerCase()]) headers[name.toLowerCase()] = value;
  }
  return headers;
}

function extractMobileFromCookies(cookies) {
  for (const key of ['P_INFO', 'S_INFO', 'NTES_YD_SESS', 'NTES_SESS', 'YD_UDID']) {
    const v = cookies[key];
    if (!v) continue;
    const hit = String(v).match(/(1\d{10})/);
    if (hit) return hit[1];
  }
  for (const v of Object.values(cookies)) {
    const hit = String(v).match(/(?:^|[^\d])(1\d{10})(?:[^\d]|$)/);
    if (hit) return hit[1];
  }
  return null;
}

function extractMobileFromText(text) {
  // 表单/JSON 里常见 mobile / phone
  const m1 = String(text).match(
    /(?:mobile|phone|phonenum|account|username)["'\s:=]+["']?(1\d{10})/i
  );
  if (m1) return m1[1];
  const m2 = String(text).match(/(?:^|[^\d])(1\d{10})(?:[^\d]|$)/);
  return m2 ? m2[1] : null;
}

/**
 * @param {string} raw 粘贴的 curl 或 Cookie 原文
 * @returns {{ cookies: Record<string,string>, mobile: string|null, headers: Record<string,string>, cookieCount: number }}
 */
function parseCurlOrCookies(raw) {
  const text = normalizeCurlText(raw);
  if (!text) {
    return { cookies: {}, mobile: null, headers: {}, cookieCount: 0 };
  }

  const cookies = {};
  const cookieStrs = extractCookieStrings(text);
  for (const s of cookieStrs) {
    Object.assign(cookies, parseCookiePairString(s));
  }

  // 若整段就是 Cookie: a=b; c=d 或 a=b; c=d
  if (!Object.keys(cookies).length) {
    let maybe = text;
    if (/^(Cookie|cookie)\s*:/i.test(maybe)) {
      maybe = maybe.replace(/^(Cookie|cookie)\s*:/i, '').trim();
    }
    // 不像 curl 命令时，按纯 cookie 串解析
    if (!/\bcurl\b/i.test(text) && /=/.test(maybe) && /;/.test(maybe)) {
      Object.assign(cookies, parseCookiePairString(maybe));
    }
  }

  const headers = extractUsefulHeaders(text);

  // 把头里的身份信息补进 cookie（部分抓包只在 Header）
  const glUid = headers['gl-uid'] || headers['gl_uid'];
  if (glUid && !cookies.GOD_UUID) cookies.GOD_UUID = glUid;
  if (headers['gl-x-xsrf-token'] && !cookies['GL-XSRF-TOKEN']) {
    cookies['GL-XSRF-TOKEN'] = headers['gl-x-xsrf-token'];
  }
  if (headers['gl-deviceid'] && !cookies['GL-DeviceId']) {
    // deviceId 不是 cookie，但 import 时可用；先放进 map 无害，apply 时会写 jar
  }

  const mobile =
    extractMobileFromCookies(cookies) || extractMobileFromText(text) || null;

  return {
    cookies,
    mobile,
    headers,
    cookieCount: Object.keys(cookies).length,
  };
}

module.exports = {
  parseCurlOrCookies,
  parseCookiePairString,
  extractMobileFromCookies,
  normalizeCurlText,
};
