const { createSession, ensureXsrf } = require('./http');
const C = require('./constants');

/**
 * 可视页面登录：
 * 打开官方登录页，用户在浏览器里自行完成手机号 / 验证码 / 滑块，
 * 程序只负责检测登录成功并落盘用户信息。
 */
class BrowserLoginService {
  constructor() {
    this.browser = null;
    this.page = null;
    this.context = null;
  }

  async init() {
    const { chromium } = require('playwright');
    const launchOpts = {
      headless: false,
      args: ['--disable-blink-features=AutomationControlled'],
    };
    try {
      this.browser = await chromium.launch({ ...launchOpts, channel: 'chrome' });
    } catch (_) {
      this.browser = await chromium.launch(launchOpts);
    }
    // 桌面视口，方便完成滑块
    this.context = await this.browser.newContext({
      viewport: { width: 1100, height: 800 },
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      locale: 'zh-CN',
    });
    this.page = await this.context.newPage();
  }

  /**
   * 打开登录页并等待用户在浏览器中手动完成登录。
   * @param {{ timeoutMs?: number }} options
   */
  async waitForManualLogin(options = {}) {
    const timeoutMs = options.timeoutMs || 10 * 60 * 1000;
    if (!this.page) await this.init();

    const page = this.page;
    await page.goto('https://pay.ds.163.com/login', {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
    await page.waitForTimeout(1200);

    // 尽量点出登录框；失败也不影响，用户可自己点
    await this._clickFirst(page, [
      'text=登录',
      'text=立即登录',
      'button:has-text("登录")',
      '.loginBtn',
    ]);

    console.log('');
    console.log('------------------------------------------------');
    console.log('  请在已打开的浏览器窗口中完成登录：');
    console.log('  1. 选择手机号登录（或账号密码）');
    console.log('  2. 输入手机号，获取并填写验证码');
    console.log('  3. 若出现滑块 / 图形验证，直接在该页面完成');
    console.log('  4. 点击登录，看到进入充值站即可');
    console.log('  程序会自动检测登录成功并保存用户信息');
    console.log('------------------------------------------------');
    console.log('');

    const started = Date.now();
    let lastHint = 0;
    let navigatedAfterHint = false;

    while (Date.now() - started < timeoutMs) {
      const cookies = await this.context.cookies();
      const map = cookieListToMap(cookies);

      if (hasSessionHint(map)) {
        // 检测到会话后，进一次业务页，促使站点完成换票
        if (!navigatedAfterHint) {
          navigatedAfterHint = true;
          try {
            await page.goto('https://pay.ds.163.com/vip/profile', {
              waitUntil: 'domcontentloaded',
              timeout: 30000,
            });
            await page.waitForTimeout(1500);
          } catch (_) {}
        }

        const freshCookies = await this.context.cookies();
        const profile = await this._tryBuildProfile(freshCookies, cookieListToMap(freshCookies));
        if (profile) {
          await this.close();
          return { ok: true, channel: 'browser-manual', user: profile };
        }
      }

      const now = Date.now();
      if (now - lastHint > 15000) {
        lastHint = now;
        const left = Math.ceil((timeoutMs - (now - started)) / 1000);
        console.log(`[login] 等待浏览器登录中… 剩余约 ${left}s`);
      }
      await page.waitForTimeout(1000);
    }

    throw new Error('等待登录超时。请重新运行 npm start，并在浏览器内完成登录。');
  }

  async _tryBuildProfile(cookies, map) {
    const session = createSession();
    applyBrowserCookies(session.jar, cookies);
    await ensureXsrf(session.client, session.jar);

    // 浏览器里登录成功后，站点通常已经完成换票（已有 GOD_UUID / plutus cookie）。
    // 此时再调 /api/nlogin 常会返回 413「登录失败」，并不代表页面登录失败。
    const jarCookies = session.jar.getCookiesSync('https://pay.ds.163.com/');
    const hasGod = jarCookies.some((c) => c.key === 'GOD_UUID' && c.value);
    let nloginOk = false;
    let nloginData = null;

    if (!hasGod) {
      const nloginRes = await session.client.get(`${C.PAY_API}/api/nlogin`, { params: {} });
      nloginData = nloginRes.data || {};
      nloginOk = nloginData.code === 200 || nloginData.status === 200;
    } else {
      nloginOk = true;
      console.log('[login] 浏览器已具备 GOD_UUID，跳过 nlogin 换票');
    }

    // 再拉一次浏览器 cookie，补齐 Node 侧
    const fresh = await this.context.cookies();
    applyBrowserCookies(session.jar, fresh);
    await ensureXsrf(session.client, session.jar);

    const mobile = extractMobile(map) || extractMobile(cookieListToMap(fresh));
    if (!mobile) {
      return null;
    }

    const selfRes = await session.client.post(`${C.PAY_API}/api/self`, {});
    const selfData = selfRes.data || {};
    const selfOk =
      selfData.code === 0 ||
      selfData.code === 200 ||
      selfData.msg === 'ok' ||
      !!(selfData.result || selfData.data) ||
      !!(selfData.nick || selfData.nickname || selfData.name);

    if (!nloginOk && !selfOk) {
      return null;
    }

    if (!hasGod && nloginData && !nloginOk) {
      console.warn(
        `[login] 备注: Node 侧 nlogin 返回 ${JSON.stringify(nloginData).slice(0, 120)}（页面登录仍可能有效，以 /api/self 为准）`
      );
    }
    if (selfOk) {
      const nick =
        (selfData.result && selfData.result.nickname) ||
        selfData.nickname ||
        '';
      console.log(`[login] 账号校验成功${nick ? `：${nick}` : ''}`);
    }

    const { LoginService } = require('./loginService');
    const svc = new LoginService(session);
    return svc.fetchProfile(mobile);
  }

  async _clickFirst(root, selectors) {
    for (const sel of selectors) {
      const loc = root.locator(sel).first();
      if (await loc.count()) {
        try {
          await loc.click({ timeout: 2000 });
          return true;
        } catch (_) {}
      }
    }
    return false;
  }

  async close() {
    try {
      if (this.browser) await this.browser.close();
    } catch (_) {}
    this.browser = null;
    this.page = null;
    this.context = null;
  }
}

function cookieListToMap(cookies) {
  const map = {};
  for (const c of cookies || []) {
    if (c && c.name) map[c.name] = c.value;
  }
  return map;
}

function hasSessionHint(map) {
  return !!(
    map.NTES_YD_SESS ||
    map.NTES_SESS ||
    map.NTES_YD_PASSPORT ||
    map.S_INFO ||
    map.P_INFO ||
    map.GOD_UUID ||
    map.THE_LAST_LOGIN_MOBILE
  );
}

function extractMobile(map) {
  if (map.THE_LAST_LOGIN_MOBILE && /^1\d{10}$/.test(map.THE_LAST_LOGIN_MOBILE)) {
    return map.THE_LAST_LOGIN_MOBILE;
  }
  if (map.P_INFO) {
    const m = String(map.P_INFO).match(/(1\d{10})/);
    if (m) return m[1];
  }
  if (map.S_INFO) {
    const m = String(map.S_INFO).match(/(1\d{10})/);
    if (m) return m[1];
  }
  return null;
}

function applyBrowserCookies(jar, cookies) {
  for (const c of cookies || []) {
    if (!c || !c.name) continue;
    let domain = c.domain || '.ds.163.com';
    if (!domain.startsWith('.') && (domain === '163.com' || domain.endsWith('.163.com'))) {
      domain = `.${domain}`;
    }
    const path = c.path || '/';
    const cookieStr = `${c.name}=${c.value}; Domain=${domain}; Path=${path}`;
    for (const url of [
      'https://pay.ds.163.com/',
      'https://pay-api.ds.163.com/',
      'https://inf.ds.163.com/',
      'https://www.163.com/',
    ]) {
      try {
        jar.setCookieSync(cookieStr, url);
      } catch (_) {}
    }
  }
}

module.exports = { BrowserLoginService };
