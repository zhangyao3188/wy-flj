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

/**
 * 远程登录会话：手机视口，方便移动端点击登录框。
 */
class RemoteLoginSession {
  constructor(token) {
    this.token = token;
    this.browser = null;
    this.context = null;
    this.page = null;
    this.status = 'pending';
    this.message = '';
    this.mobile = null;
    this.account = null;
    this.lastFrame = null;
    // 手机视口：登录弹窗占满画面，便于手指点击
    this.viewport = { width: 390, height: 844 };
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
      isMobile: true,
      hasTouch: true,
      // 与截图/点击同一套 CSS 像素，避免 2x 缩放导致点不准
      deviceScaleFactor: 1,
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
      locale: 'zh-CN',
    });
    this.page = await this.context.newPage();
    this.status = 'running';
    this.message = '请在下方画面中完成登录（手机号 / 验证码 / 滑块）';

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
    // 移动端页面更认 touch；再补一次 mouse，兼容部分控件
    try {
      await this.page.touchscreen.tap(cx, cy);
    } catch (_) {
      await this.page.mouse.click(cx, cy);
    }
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

    const saved = await accountRepo.upsertAccount(profile);
    this.mobile = saved.mobile;
    this.account = {
      mobile: saved.mobile,
      nickname: saved.nickname,
      vipLevel: saved.vipLevel,
    };
    this.status = 'success';
    this.message = '登录成功，账号已写入数据库';
    await accountRepo.updateLoginSession(this.token, {
      status: 'success',
      mobile: saved.mobile,
      account_id: saved.id,
      message: this.message,
    });
    await this.close();
  }

  async _buildProfile(cookies) {
    const map = cookieListToMap(cookies);
    const mobile = extractMobile(map);
    if (!mobile) return null;

    const session = createSession();
    applyBrowserCookies(session.jar, cookies);
    await ensureXsrf(session.client, session.jar);

    const hasGod = session.jar
      .getCookiesSync('https://pay.ds.163.com/')
      .some((c) => c.key === 'GOD_UUID' && c.value);
    if (!hasGod) {
      await session.client.get(`${C.PAY_API}/api/nlogin`, { params: {} }).catch(() => {});
      applyBrowserCookies(session.jar, await this.context.cookies());
      await ensureXsrf(session.client, session.jar);
    }

    const selfRes = await session.client.post(`${C.PAY_API}/api/self`, {});
    const selfData = selfRes.data || {};
    const selfOk =
      selfData.code === 0 ||
      selfData.code === 200 ||
      selfData.msg === 'ok' ||
      !!(selfData.result || selfData.data);

    if (!selfOk && !hasGod) return null;

    const { LoginService } = require('./loginService');
    const svc = new LoginService(session);
    return svc.fetchProfile(mobile);
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

  async create() {
    const token = crypto.randomBytes(16).toString('hex');
    const ttl = Number(process.env.LOGIN_SESSION_TTL_MS || 600000);
    const expiresAt = new Date(Date.now() + ttl);
    await accountRepo.createLoginSession({ token, expiresAt });

    const remote = new RemoteLoginSession(token);
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
