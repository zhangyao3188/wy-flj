const crypto = require('crypto');
const { createSession, ensureXsrf } = require('./http');
const C = require('./constants');
const accountRepo = require('./accountRepo');

function applyBrowserCookies(jar, cookies) {
  for (const c of cookies || []) {
    if (!c || !c.name) continue;
    let domain = c.domain || '.ds.163.com';
    if (!domain.startsWith('.') && (domain === '163.com' || domain.endsWith('.163.com'))) {
      domain = `.${domain}`;
    }
    const cookieStr = `${c.name}=${c.value}; Domain=${domain}; Path=${c.path || '/'}`;
    for (const url of [
      'https://pay.ds.163.com/',
      'https://pay-api.ds.163.com/',
      'https://inf.ds.163.com/',
      'https://www.163.com/',
      'https://dl.reg.163.com/',
      'https://reg.163.com/',
      'https://passport.163.com/',
    ]) {
      try {
        jar.setCookieSync(cookieStr, url);
      } catch (_) {}
    }
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
    map.NTES_PASSPORT ||
    map.S_INFO ||
    map.P_INFO ||
    map.GOD_UUID ||
    map.THE_LAST_LOGIN_MOBILE ||
    map.NTES_plutus_online_front ||
    map.NTES_plutus_p_info_online ||
    map.JSESSIONID
  );
}

function extractMobile(map) {
  if (map.THE_LAST_LOGIN_MOBILE && /^1\d{10}$/.test(String(map.THE_LAST_LOGIN_MOBILE))) {
    return String(map.THE_LAST_LOGIN_MOBILE);
  }
  for (const key of ['P_INFO', 'S_INFO', 'NTES_SESS_USER', 'URS_USER']) {
    if (!map[key]) continue;
    const m = String(map[key]).match(/(1\d{10})/);
    if (m) return m[1];
  }
  // 宽搜所有 cookie 值
  for (const v of Object.values(map)) {
    const m = String(v || '').match(/(?:^|[^\d])(1\d{10})(?:[^\d]|$)/);
    if (m) return m[1];
  }
  return null;
}

function extractMobileFromSelf(selfData) {
  if (!selfData || typeof selfData !== 'object') return null;
  const result = selfData.result || selfData.data || selfData;
  const candidates = [
    result.mobile,
    result.phone,
    result.account,
    result.actAccount,
    result.ursAccount,
    result.loginName,
    result.userName,
    result.user && result.user.mobile,
    result.user && result.user.phone,
    result.user && result.user.account,
  ];
  for (const c of candidates) {
    const m = String(c || '').match(/(1\d{10})/);
    if (m) return m[1];
  }
  const blob = JSON.stringify(result);
  const hit = blob.match(/1\d{10}/);
  return hit ? hit[0] : null;
}

function extractAccountHint(map) {
  // 账号密码登录常见：P_INFO 里是邮箱而非手机号
  if (map.P_INFO) {
    const email = String(map.P_INFO).split('|')[0];
    if (email && email.includes('@')) return email;
    const m = String(map.P_INFO).match(/(1\d{10})/);
    if (m) return m[1];
  }
  if (map.S_INFO) {
    const part = String(map.S_INFO).split('|').pop();
    if (part && part.includes('@')) return part;
  }
  return extractMobile(map);
}

function isSelfOk(selfData) {
  if (!selfData || typeof selfData !== 'object') return false;
  if (selfData.error) return false;
  return (
    selfData.code === 0 ||
    selfData.code === 200 ||
    selfData.msg === 'ok' ||
    selfData.errmsg === 'OK' ||
    !!(selfData.result || selfData.data) ||
    !!(selfData.nick || selfData.nickname || selfData.name)
  );
}

/**
 * 远程登录会话：网页版桌面视口内嵌。
 */
class RemoteLoginSession {
  constructor(token, targetCount = 1, buyerNickname = null) {
    this.token = token;
    this.targetCount = accountRepo.normalizeTargetCount(targetCount);
    this.buyerNickname = accountRepo.normalizeBuyerNickname(buyerNickname);
    this.browser = null;
    this.context = null;
    this.page = null;
    this.status = 'pending';
    this.message = '';
    this.mobile = null;
    this.account = null;
    this.lastFrame = null;
    // 网页版桌面视口，与官方 PC 登录页一致
    this.viewport = { width: 1100, height: 800 };
    this._closed = false;
    this._watchTimer = null;
  }

  async start() {
    const { chromium } = require('playwright');
    const launchOpts = {
      headless: true,
      args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
    };
    try {
      this.browser = await chromium.launch({ ...launchOpts, channel: 'chrome' });
    } catch (_) {
      this.browser = await chromium.launch(launchOpts);
    }
    this.context = await this.browser.newContext({
      viewport: this.viewport,
      isMobile: false,
      hasTouch: false,
      deviceScaleFactor: 1,
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      locale: 'zh-CN',
    });
    this.page = await this.context.newPage();
    this.status = 'running';
    this.message = '请在下方画面中完成登录（网页版：手机号 / 验证码 / 账号密码 / 滑块）';

    await this.page.goto('https://pay.ds.163.com/login', {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
    await this.page.waitForTimeout(800);
    await this._clickFirst([
      'text=登录',
      'text=立即登录',
      'button:has-text("登录")',
      '.loginBtn',
    ]);
    await this.page.waitForTimeout(600);
    // 尽量把登录框滚到可视区域中心
    try {
      await this.page.evaluate(() => {
        const el =
          document.querySelector('iframe') ||
          document.querySelector('[class*="login"]') ||
          document.body;
        if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center', inline: 'center' });
      });
    } catch (_) {}
    await this.refreshFrame();
    this._watchTimer = setInterval(() => {
      this._pollSuccess().catch(() => {});
    }, 2000);
  }

  async _clickFirst(selectors) {
    for (const sel of selectors) {
      try {
        const loc = this.page.locator(sel).first();
        if (await loc.count()) {
          await loc.click({ timeout: 2000 });
          return true;
        }
      } catch (_) {}
    }
    return false;
  }

  async refreshFrame() {
    if (!this.page || this._closed) return null;
    // scale: 'css' 保证截图像素 = viewport，与 mouse/touch 坐标一致
    this.lastFrame = await this.page.screenshot({
      type: 'jpeg',
      quality: 70,
      scale: 'css',
    });
    return this.lastFrame;
  }

  async click(x, y) {
    if (!this.page) return;
    const vp = this.page.viewportSize() || this.viewport;
    const cx = Math.max(0, Math.min(vp.width - 1, Math.round(Number(x) || 0)));
    const cy = Math.max(0, Math.min(vp.height - 1, Math.round(Number(y) || 0)));
    // 网页版用鼠标点击
    await this.page.mouse.click(cx, cy);
    await this.page.waitForTimeout(180);
    // 尽量把焦点落到点击处的输入框（含 iframe）
    try {
      await this.page.evaluate(
        ({ x: px, y: py }) => {
          const topEl = document.elementFromPoint(px, py);
          if (!topEl) return;
          const dig = (el) => {
            if (!el) return null;
            if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable) {
              return el;
            }
            if (el.shadowRoot) {
              const inner = el.shadowRoot.elementFromPoint(px, py);
              if (inner) return dig(inner) || inner;
            }
            return el.closest && el.closest('input, textarea, [contenteditable="true"]');
          };
          let target = dig(topEl);
          if (!target && topEl.tagName === 'IFRAME') {
            try {
              const rect = topEl.getBoundingClientRect();
              const doc = topEl.contentDocument;
              if (doc) {
                const inner = doc.elementFromPoint(px - rect.left, py - rect.top);
                target = dig(inner) || inner;
              }
            } catch (_) {}
          }
          if (target && typeof target.focus === 'function') {
            target.focus();
            if (typeof target.click === 'function') target.click();
          }
        },
        { x: cx, y: cy }
      );
    } catch (_) {}
    await this.refreshFrame();
  }

  async type(text, { replace = true } = {}) {
    if (!this.page) return;
    const value = String(text);
    let filled = false;
    try {
      filled = await this.page.evaluate(
        ({ v, replace: rep }) => {
          const tryFill = (doc) => {
            const el =
              doc.activeElement &&
              (doc.activeElement.tagName === 'INPUT' ||
                doc.activeElement.tagName === 'TEXTAREA' ||
                doc.activeElement.isContentEditable)
                ? doc.activeElement
                : null;
            if (!el) return false;
            el.focus();
            if ('value' in el) {
              const proto =
                el.tagName === 'TEXTAREA'
                  ? window.HTMLTextAreaElement.prototype
                  : window.HTMLInputElement.prototype;
              const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
              const next = rep ? v : String(el.value || '') + v;
              if (setter) setter.call(el, next);
              else el.value = next;
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
            } else if (el.isContentEditable) {
              el.textContent = rep ? v : String(el.textContent || '') + v;
              el.dispatchEvent(new Event('input', { bubbles: true }));
            }
            return true;
          };
          if (tryFill(document)) return true;
          for (const frame of Array.from(document.querySelectorAll('iframe'))) {
            try {
              if (frame.contentDocument && tryFill(frame.contentDocument)) return true;
            } catch (_) {}
          }
          return false;
        },
        { v: value, replace }
      );
    } catch (_) {}
    if (!filled) {
      if (replace) {
        await this.page.keyboard.press('Control+A');
        await this.page.keyboard.press('Backspace');
      }
      await this.page.keyboard.type(value, { delay: 30 });
    }
    await this.refreshFrame();
  }

  async clear() {
    if (!this.page) return;
    let cleared = false;
    try {
      cleared = await this.page.evaluate(() => {
        const tryClear = (doc) => {
          const el =
            doc.activeElement &&
            (doc.activeElement.tagName === 'INPUT' ||
              doc.activeElement.tagName === 'TEXTAREA' ||
              doc.activeElement.isContentEditable)
              ? doc.activeElement
              : null;
          if (!el) return false;
          el.focus();
          if ('value' in el) {
            const proto =
              el.tagName === 'TEXTAREA'
                ? window.HTMLTextAreaElement.prototype
                : window.HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
            if (setter) setter.call(el, '');
            else el.value = '';
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          } else if (el.isContentEditable) {
            el.textContent = '';
            el.dispatchEvent(new Event('input', { bubbles: true }));
          }
          return true;
        };
        if (tryClear(document)) return true;
        for (const frame of Array.from(document.querySelectorAll('iframe'))) {
          try {
            if (frame.contentDocument && tryClear(frame.contentDocument)) return true;
          } catch (_) {}
        }
        return false;
      });
    } catch (_) {}
    if (!cleared) {
      await this.page.keyboard.press('Control+A');
      await this.page.keyboard.press('Backspace');
    }
    await this.refreshFrame();
  }

  async press(key) {
    if (!this.page) return;
    await this.page.keyboard.press(key);
    await this.refreshFrame();
  }

  async _pollSuccess() {
    if (this._closed || this.status === 'success' || !this.context) return;
    const cookies = await this.context.cookies();
    const map = cookieListToMap(cookies);
    if (!hasSessionHint(map)) return;

    try {
      const url = this.page.url();
      if (!/vip\/profile/.test(url)) {
        await this.page.goto('https://pay.ds.163.com/vip/profile', {
          waitUntil: 'domcontentloaded',
          timeout: 20000,
        });
        await this.page.waitForTimeout(1000);
      }
    } catch (_) {}

    const fresh = await this.context.cookies();
    const profile = await this._buildProfile(fresh);
    if (!profile) return;

    await this._commitSuccess(profile);
  }

  /**
   * 手动提取：兼容验证码 / 账号密码登录。
   * 账号密码登录后常无手机号 Cookie，且需先在 pay 域完成换票，因此走浏览器内探测 + 强制落库。
   */
  async extractAndSave(opts = {}) {
    if (this._closed) throw new Error('会话已关闭');
    if (this.status === 'success') {
      return {
        ok: true,
        mobile: this.mobile,
        account: this.account,
        message: '已入库，无需重复提取',
      };
    }
    if (this.status !== 'running' || !this.context || !this.page) {
      throw new Error('会话不可用');
    }

    const mobileHint = opts.mobile ? String(opts.mobile).trim() : '';
    if (mobileHint && !/^1\d{10}$/.test(mobileHint)) {
      throw new Error('手机号格式不正确');
    }

    this.message = '正在提取账号信息并写入数据库…';
    await accountRepo.updateLoginSession(this.token, {
      status: 'running',
      message: this.message,
    });

    try {
      await this._ensurePaySessionReady();
    } catch (e) {
      console.warn(`[login] ensurePaySession: ${e.message || e}`);
    }

    const fresh = await this.context.cookies();
    const map = cookieListToMap(fresh);
    const cookieNames = Object.keys(map);
    console.log(
      `[login] extract cookies(${cookieNames.length}): ${cookieNames.slice(0, 30).join(',')}`
    );

    const probe = await this._probeFromBrowser();
    console.log(
      `[login] extract probe selfOk=${isSelfOk(probe.self)} getInfo=${
        probe.getInfo && (probe.getInfo.code || probe.getInfo.errmsg)
      } localMobile=${probe.localMobile || ''}`
    );

    if (!hasSessionHint(map) && !isSelfOk(probe.self) && !mobileHint) {
      throw new Error(
        `尚未检测到登录态（Cookie: ${cookieNames.slice(0, 12).join(',') || '无'}）。请确认画面已登录成功后再提取`
      );
    }

    const profile = await this._buildProfile(fresh, mobileHint || null, probe);
    if (!profile) {
      const accountHint = extractAccountHint(map) || '';
      throw new Error(
        `提取失败：未能拿到可用于入库的手机号或会话。` +
          (accountHint ? `检测到账号标识=${accountHint}，` : '') +
          `请在上方填写绑定手机号后重试。（Cookie: ${cookieNames.slice(0, 15).join(',') || '无'}）`
      );
    }

    await this._commitSuccess(profile);
    return {
      ok: true,
      mobile: this.mobile,
      account: this.account,
      message: this.message,
    };
  }

  /** 账号密码登录后，等 pay 域换票完成（GOD_UUID / plutus） */
  async _ensurePaySessionReady() {
    if (!this.page) return;
    try {
      await this.page.goto('https://pay.ds.163.com/', {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      await this.page.waitForTimeout(1200);
    } catch (_) {}

    try {
      await this.page.goto('https://pay.ds.163.com/vip/profile', {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      await this.page.waitForTimeout(1500);
    } catch (_) {}

    // 浏览器内主动触发 nlogin / cookie-exchange，帮助密码登录换票
    try {
      await this.page.evaluate(async () => {
        const tryFetch = async (url, init) => {
          try {
            await fetch(url, init);
          } catch (_) {}
        };
        await tryFetch('https://pay-api.ds.163.com/api/nlogin', {
          method: 'GET',
          credentials: 'include',
        });
        await tryFetch('https://inf.ds.163.com/v1/web/cooperate/plutus/cookie-exchange', {
          method: 'GET',
          credentials: 'include',
        });
      });
      await this.page.waitForTimeout(800);
    } catch (_) {}

    for (let i = 0; i < 10; i++) {
      const cookies = await this.context.cookies();
      const map = cookieListToMap(cookies);
      if (map.GOD_UUID || map.NTES_plutus_online_front || map.NTES_plutus_p_info_online) {
        return;
      }
      // 已有 URS 会话也继续等一会换票
      if (!(map.NTES_YD_SESS || map.NTES_SESS || map.P_INFO || map.S_INFO)) {
        return;
      }
      await this.page.waitForTimeout(800);
    }
  }

  async _probeFromBrowser() {
    const empty = { self: null, getInfo: null, localMobile: null };
    if (!this.page) return empty;
    try {
      return await this.page.evaluate(async () => {
        const out = { self: null, getInfo: null, localMobile: null };
        const postJson = async (url) => {
          const r = await fetch(url, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json;charset=UTF-8' },
            body: '{}',
          });
          return r.json();
        };
        try {
          out.self = await postJson('https://pay-api.ds.163.com/api/self');
        } catch (e) {
          out.self = { error: String(e && e.message ? e.message : e) };
        }
        try {
          out.getInfo = await postJson('https://inf.ds.163.com/v1/web/exp/xy/user/get-info');
        } catch (e) {
          out.getInfo = { error: String(e && e.message ? e.message : e) };
        }
        try {
          for (const k of Object.keys(localStorage || {})) {
            const v = String(localStorage.getItem(k) || '');
            const m = v.match(/1\d{10}/);
            if (m) {
              out.localMobile = m[0];
              break;
            }
          }
          if (!out.localMobile) {
            const m2 = String(document.cookie || '').match(/1\d{10}/);
            if (m2) out.localMobile = m2[0];
          }
        } catch (_) {}
        return out;
      });
    } catch (_) {
      return empty;
    }
  }

  async _commitSuccess(profile) {
    const saved = await accountRepo.upsertAccount({
      ...profile,
      targetCount: this.targetCount,
      buyerNickname: this.buyerNickname,
    });
    this.mobile = saved.mobile;
    this.account = {
      mobile: saved.mobile,
      nickname: saved.nickname,
      buyerNickname: saved.buyerNickname,
      actAccount: saved.actAccount,
      vipLevel: saved.vipLevel,
      targetCount: saved.targetCount,
      successCount: saved.successCount,
    };
    this.status = 'success';
    this.message = `登录成功，账号已写入数据库（抢购次数=${saved.targetCount}${
      saved.buyerNickname ? `，买家=${saved.buyerNickname}` : ''
    }${saved.actAccount ? `，账户=${saved.actAccount}` : ''}）`;
    await accountRepo.updateLoginSession(this.token, {
      status: 'success',
      mobile: saved.mobile,
      account_id: saved.id,
      message: this.message,
    });
    await this.close();
  }

  async _buildProfile(cookies, mobileHint = null, probe = null) {
    const map = cookieListToMap(cookies);
    let mobile =
      (mobileHint && /^1\d{10}$/.test(mobileHint) ? mobileHint : null) ||
      extractMobile(map) ||
      (probe && probe.localMobile) ||
      extractMobileFromSelf(probe && probe.self);

    const session = createSession();
    applyBrowserCookies(session.jar, cookies);
    await ensureXsrf(session.client, session.jar);

    const readJar = (name) => {
      for (const url of [
        'https://pay.ds.163.com/',
        'https://pay-api.ds.163.com/',
        'https://inf.ds.163.com/',
        'https://www.163.com/',
      ]) {
        try {
          const hit = session.jar.getCookiesSync(url).find((c) => c.key === name);
          if (hit && hit.value) return hit.value;
        } catch (_) {}
      }
      return null;
    };

    let hasGod = !!readJar('GOD_UUID');
    const hasPlutus = !!(readJar('NTES_plutus_online_front') || readJar('NTES_plutus_p_info_online'));
    const hasUrs = !!(readJar('NTES_YD_SESS') || readJar('NTES_SESS') || readJar('P_INFO'));

    if (!hasGod) {
      await session.client.get(`${C.PAY_API}/api/nlogin`, { params: {} }).catch(() => {});
      try {
        await session.client.get(
          `${C.INF}/v1/web/cooperate/plutus/cookie-exchange`
        );
      } catch (_) {}
      if (this.context) {
        applyBrowserCookies(session.jar, await this.context.cookies());
      }
      await ensureXsrf(session.client, session.jar);
      hasGod = !!readJar('GOD_UUID');
    }

    if (hasGod) {
      session.client.defaults.headers.common['gl-uid'] = readJar('GOD_UUID');
      session.client.defaults.headers.common['GL-Uid'] = readJar('GOD_UUID');
    }

    let selfData = (probe && probe.self) || null;
    let selfOk = isSelfOk(selfData);
    if (!selfOk) {
      const selfRes = await session.client.post(`${C.PAY_API}/api/self`, {});
      selfData = selfRes.data || {};
      selfOk = isSelfOk(selfData);
    }

    if (!mobile) {
      mobile = extractMobileFromSelf(selfData);
    }

    // 账号密码登录：允许用「用户填写的手机号」作为入库主键，只要会话有效
    const sessionOk = hasGod || hasPlutus || hasUrs || selfOk;
    if (!sessionOk) {
      console.warn('[login] extract session invalid', {
        hasGod,
        hasPlutus,
        hasUrs,
        selfOk,
        selfCode: selfData && selfData.code,
      });
      return null;
    }
    if (!mobile) {
      console.warn('[login] extract no mobile', {
        accountHint: extractAccountHint(map),
        selfSnippet: JSON.stringify(selfData || {}).slice(0, 240),
      });
      return null;
    }

    const { LoginService, normalizeVipLevel } = require('./loginService');
    const svc = new LoginService(session);
    try {
      return await svc.fetchProfile(mobile);
    } catch (e) {
      console.warn(`[login] fetchProfile 失败，使用兜底资料: ${e.message || e}`);
    }

    // 兜底：浏览器 probe / self 拼一份可入库资料
    const vipData = (probe && probe.getInfo) || {};
    const vipResult = vipData.result || vipData.data || {};
    const selfResult =
      (selfData && (selfData.result || selfData.data)) || selfData || {};
    const { jarToJSON } = require('./http');

    let actAccount = null;
    try {
      await session.client.get(`${C.PAY_API}/api/nlogin`, { params: {} }).catch(() => {});
      try {
        await session.client.get(`${C.INF}/v1/web/cooperate/plutus/cookie-exchange`);
      } catch (_) {}
      await ensureXsrf(session.client, session.jar);
      const actRes = await session.client.post(`${C.INF_ACT}/v1/act-web/module/common/actInfo`, {
        actId: C.ACT_ID,
      });
      const actRaw = actRes.data || {};
      const actResult = actRaw.result || actRaw.data || {};
      actAccount =
        actResult.actAccount ||
        actResult.account ||
        (actResult.user && actResult.user.actAccount) ||
        null;
    } catch (e) {
      console.warn(`[login] 兜底 actInfo 失败: ${e.message || e}`);
    }

    return {
      mobile: String(mobile),
      nickname: String(
        selfResult.nick ||
          selfResult.nickname ||
          selfResult.nickName ||
          selfResult.name ||
          mobile
      ),
      actAccount: actAccount ? String(actAccount) : null,
      vipLevel: normalizeVipLevel(
        vipResult.currentLv || vipResult.level || vipResult.vipLevel || 'V1'
      ),
      vipLevelTrusted: !!(vipResult.currentLv || vipResult.level || vipResult.vipLevel),
      uid: selfResult.uid || selfResult.userId || null,
      godUuid: readJar('GOD_UUID'),
      deviceId: session.deviceId,
      cookies: jarToJSON(session.jar),
      cookieHeader: session.jar.getCookieStringSync('https://pay.ds.163.com/'),
      vipRaw: vipData,
      selfRaw: selfData,
      loggedInAt: new Date().toISOString(),
    };
  }

  async close() {
    this._closed = true;
    if (this._watchTimer) {
      clearInterval(this._watchTimer);
      this._watchTimer = null;
    }
    try {
      if (this.browser) await this.browser.close();
    } catch (_) {}
    this.browser = null;
    this.page = null;
    this.context = null;
  }
}

class SessionManager {
  constructor() {
    this.sessions = new Map();
  }

  async create({ targetCount, buyerNickname } = {}) {
    const token = crypto.randomBytes(16).toString('hex');
    const ttl = Number(process.env.LOGIN_SESSION_TTL_MS || 600000);
    const expiresAt = new Date(Date.now() + ttl);
    const quota = accountRepo.normalizeTargetCount(targetCount);
    const buyer = accountRepo.normalizeBuyerNickname(buyerNickname);
    await accountRepo.createLoginSession({
      token,
      expiresAt,
      targetCount: quota,
      buyerNickname: buyer,
    });

    const remote = new RemoteLoginSession(token, quota, buyer);
    this.sessions.set(token, remote);
    try {
      await remote.start();
      await accountRepo.updateLoginSession(token, {
        status: 'running',
        message: remote.message,
      });
    } catch (e) {
      remote.status = 'failed';
      remote.message = e.message || String(e);
      await accountRepo.updateLoginSession(token, {
        status: 'failed',
        message: remote.message,
      });
      await remote.close();
      this.sessions.delete(token);
      throw e;
    }

    setTimeout(() => {
      this.expire(token).catch(() => {});
    }, ttl);

    return remote;
  }

  get(token) {
    return this.sessions.get(token) || null;
  }

  async expire(token) {
    const remote = this.sessions.get(token);
    if (!remote) return;
    if (remote.status !== 'success') {
      remote.status = 'expired';
      remote.message = '登录会话已过期';
      await accountRepo.updateLoginSession(token, {
        status: 'expired',
        message: remote.message,
      });
    }
    await remote.close();
    this.sessions.delete(token);
  }
}

module.exports = { SessionManager, RemoteLoginSession };
