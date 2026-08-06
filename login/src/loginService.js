const qs = require('querystring');
const C = require('./constants');
const { ensureXsrf, applyCookieMap, jarToJSON } = require('./http');

/**
 * 手机号短信登录客户端
 *
 * 登录链路（与 H5 UniSDK / URS 对齐的精简版）：
 * 1) 发送短信验证码
 * 2) 校验验证码拿到 URS 会话 Cookie（NTES_YD_SESS 等）
 * 3) 调用 pay-api /api/nlogin 换取充值站会话
 * 4) 拉取会员信息并落盘
 *
 * 说明：网易短信通道可能要求图形验证码/风控参数。
 * 若 sendCode 失败，可改用 cookie 导入（importCookies）完成登录态落盘。
 */
class LoginService {
  constructor(session) {
    this.client = session.client;
    this.jar = session.jar;
    this.deviceId = session.deviceId;
    this._smsCtx = null;
  }

  async sendCode(mobile) {
    if (!/^1\d{10}$/.test(String(mobile))) {
      throw new Error('手机号格式不正确');
    }

    // 注意：不要调用 pay-api /api/sms/send_sms_code
    // 那个接口要求已登录，未登录会返回 {code:410,msg:"用户未登录"}
    await ensureXsrf(this.client, this.jar);

    const attempts = [() => this._sendViaUrsYd(mobile), () => this._sendViaUrs(mobile)];

    const errors = [];
    for (const fn of attempts) {
      try {
        const result = await fn();
        if (result && result.ok) {
          this._smsCtx = { mobile, ...result.ctx };
          return {
            ok: true,
            channel: result.channel,
            message: result.message || '验证码已发送',
            ctx: result.ctx,
          };
        }
        errors.push(`${result.channel}: ${result.message}`);
      } catch (e) {
        errors.push(e.message || String(e));
      }
    }
    throw new Error(
      `短信发送失败（直连通道受限）。详情: ${errors.join(' | ')}。请使用浏览器登录流程（npm start）或 Cookie 导入。`
    );
  }

  async _sendViaUrsYd(mobile) {
    // 网易手机账号官方短信接口（需合法 product；直连可能被 IP 限制）
    const product = 'godlike_app';
    const res = await this.client.get('https://reg.163.com/interfaces/yd/getSmsCode.do', {
      params: { mobile, product },
      headers: { Referer: 'https://pay.ds.163.com/' },
    });
    const data = res.data || {};
    const ok = String(data.result) === '201' || data.code === 200;
    return {
      ok,
      channel: 'urs-yd',
      message: data.msg || data.message || JSON.stringify(data).slice(0, 200),
      ctx: { channel: 'urs-yd', product, raw: data },
    };
  }

  async _sendViaUrs(mobile) {
    // URS 手机号短信：先拉页面上下文，再发短信
    const pd = C.URS_PRODUCT;
    const initRes = await this.client.get(`${C.URS_HOST}/dl/zj/mail/getlogo`, {
      params: { pd, pkid: 'MpPsw', pkht: 'pay.ds.163.com' },
    });

    const sendRes = await this.client.post(
      `${C.URS_HOST}/dl/zj/sms/mt`,
      qs.stringify({
        mobile,
        pd,
        pkid: 'MpPsw',
        pkht: 'pay.ds.163.com',
        channel: 0,
      }),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Referer: 'https://dl.reg.163.com/',
        },
      }
    );

    const data = sendRes.data || {};
    const ok =
      sendRes.status === 200 &&
      (data.ret === '201' || data.code === 200 || data.result === '201' || data.retCode === 200);
    return {
      ok,
      channel: 'urs',
      message:
        data.desc ||
        data.msg ||
        data.message ||
        (typeof data === 'string' ? data : JSON.stringify(data).slice(0, 200)),
      ctx: { channel: 'urs', pd, init: initRes.data, raw: data },
    };
  }

  async _verifyUrsYd(mobile, code) {
    const product = 'godlike_app';
    const res = await this.client.get('https://reg.163.com/interfaces/yd/web/login.do', {
      params: {
        mobile,
        smsCode: String(code),
        product,
        unLogin: 'true',
      },
      headers: { Referer: 'https://pay.ds.163.com/' },
    });
    const data = res.data || {};
    const ok = String(data.result) === '201' || data.code === 200 || !!data.ticket;
    return {
      ok,
      message: data.msg || data.message || JSON.stringify(data).slice(0, 200),
      raw: data,
    };
  }

  async login(mobile, code) {
    if (!/^1\d{10}$/.test(String(mobile))) {
      throw new Error('手机号格式不正确');
    }
    if (!code) {
      throw new Error('请输入验证码');
    }

    await ensureXsrf(this.client, this.jar);

    let verifyOk = false;
    let verifyRaw = null;
    let lastErr = null;

    const verifiers = [
      () => this._verifyUrsYd(mobile, code),
      () => this._verifyUrs(mobile, code),
      () => this._verifyMkey(mobile, code),
    ];

    for (const fn of verifiers) {
      try {
        const r = await fn();
        verifyRaw = r.raw;
        if (r.ok) {
          verifyOk = true;
          break;
        }
        lastErr = new Error(r.message || '验证码校验失败');
      } catch (e) {
        lastErr = e;
      }
    }

    if (!verifyOk) {
      throw lastErr || new Error('验证码校验失败');
    }

    // 用 URS Cookie 换充值站登录态
    const nlogin = await this.client.get(`${C.PAY_API}/api/nlogin`, { params: {} });
    if (nlogin.status !== 200) {
      throw new Error(`nlogin HTTP ${nlogin.status}`);
    }

    const profile = await this.fetchProfile(mobile);
    return {
      ok: true,
      verifyRaw,
      nlogin: nlogin.data,
      user: profile,
    };
  }

  async _verifyMkey(mobile, code) {
    const res = await this.client.post(
      `${C.SERVICE_MKEY}/mpay/api/users/login/sms/verify`,
      {
        mobile,
        code: String(code),
        country: '86',
        appId: C.UNISDK_APPID,
        gameId: C.JF_GAMEID,
      },
      { headers: { 'Content-Type': 'application/json' } }
    );
    const data = res.data || {};
    const ok =
      res.status === 200 &&
      (data.code === 200 || data.code === 0 || data.retcode === 0 || data.success === true);

    // 若返回 sauth，走 ulogin 换票
    if (ok && (data.sauth || data.sauthJson || data.data)) {
      const sauth = data.sauth || data.sauthJson || data.data;
      await this._ulogin(sauth);
    }
    return {
      ok,
      message: data.message || data.errmsg || data.msg || JSON.stringify(data).slice(0, 200),
      raw: data,
    };
  }

  async _verifyUrs(mobile, code) {
    const pd = C.URS_PRODUCT;
    const res = await this.client.post(
      `${C.URS_HOST}/dl/zj/sms/login`,
      qs.stringify({
        mobile,
        smsCode: String(code),
        pd,
        pkid: 'MpPsw',
        pkht: 'pay.ds.163.com',
      }),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Referer: 'https://dl.reg.163.com/',
        },
      }
    );
    const data = res.data || {};
    const ok =
      res.status === 200 &&
      (data.ret === '201' || data.code === 200 || data.result === '201' || !!data.ticket);
    return {
      ok,
      message: data.desc || data.msg || data.message || JSON.stringify(data).slice(0, 200),
      raw: data,
    };
  }

  async _ulogin(sauth) {
    const body =
      typeof sauth === 'string'
        ? { sauth_json: sauth }
        : {
            deviceid: sauth.deviceid || sauth.device_id || this.deviceId,
            sdkuid: sauth.sdkuid || sauth.uid,
            sessionid: sauth.sessionid || sauth.session_id,
            udid: sauth.udid || sauth.fingerprint || this.deviceId,
            sdk_version: sauth.sdk_version || '4.2.22',
          };
    await ensureXsrf(this.client, this.jar);
    return this.client.post(`${C.PAY_API}/api/ulogin`, body, { params: {} });
  }

  /**
   * 使用已有 Cookie 完成登录态导入（抓包 / curl 导入）
   * @param {string} mobile
   * @param {Record<string,string>} cookieMap
   * @param {{ headers?: Record<string,string> }} [opts]
   */
  async importCookies(mobile, cookieMap, opts = {}) {
    applyCookieMap(this.jar, cookieMap);
    const headers = opts.headers || {};
    const glUid =
      headers['gl-uid'] ||
      headers['gl_uid'] ||
      cookieMap.GOD_UUID ||
      null;
    if (glUid) {
      this.client.defaults.headers.common['gl-uid'] = glUid;
      this.client.defaults.headers.common['GL-Uid'] = glUid;
    }
    const deviceFromHeader = headers['gl-deviceid'] || headers['gl-device-id'];
    if (deviceFromHeader) {
      this.deviceId = String(deviceFromHeader);
      this.client.defaults.headers.common['gl-deviceid'] = this.deviceId;
      this.client.defaults.headers.common['GL-DeviceId'] = this.deviceId;
    }
    await ensureXsrf(this.client, this.jar);
    const nlogin = await this.client.get(`${C.PAY_API}/api/nlogin`, { params: {} });
    try {
      await this.client.get(`${C.INF}/v1/web/cooperate/plutus/cookie-exchange`);
    } catch (_) {}
    await ensureXsrf(this.client, this.jar);
    const profile = await this.fetchProfile(mobile);
    return { ok: true, nlogin: nlogin.data, user: profile };
  }

  async fetchProfile(mobile) {
    await ensureXsrf(this.client, this.jar);

    // 会员等级
    const vipRes = await this.client.post(
      `${C.INF}/v1/web/exp/xy/user/get-info`,
      {},
      { headers: { 'Content-Type': 'application/json' } }
    );

    // 账号信息
    const selfRes = await this.client.post(`${C.PAY_API}/api/self`, {});

    // 活动账户名 actAccount（需登录态）
    let actAccount = null;
    let actRaw = null;
    try {
      await this.client.get(`${C.PAY_API}/api/nlogin`, { params: {} }).catch(() => {});
      try {
        await this.client.get(`${C.INF}/v1/web/cooperate/plutus/cookie-exchange`);
      } catch (_) {}
      await ensureXsrf(this.client, this.jar);
      const actRes = await this.client.post(`${C.INF_ACT}/v1/act-web/module/common/actInfo`, {
        actId: C.ACT_ID,
      });
      actRaw = actRes.data || {};
      const actResult = actRaw.result || actRaw.data || {};
      actAccount =
        actResult.actAccount ||
        actResult.account ||
        (actResult.user && actResult.user.actAccount) ||
        null;
      if (actAccount) {
        console.log(`[login] actInfo.actAccount=${actAccount}`);
      } else {
        console.warn('[login] actInfo 未返回 actAccount');
      }
    } catch (e) {
      console.warn(`[login] actInfo 失败: ${e.message || e}`);
    }

    const vipData = vipRes.data || {};
    const selfData = selfRes.data || {};
    const vipCode = vipData.code != null ? Number(vipData.code) : NaN;
    const vipOk = Number.isFinite(vipCode) ? vipCode === 200 || vipCode === 0 : true;
    const vipResult =
      vipOk && vipData && typeof vipData === 'object'
        ? vipData.result || vipData.data || {}
        : {};
    const selfResult = selfData.result || selfData.data || selfData || {};

    // 账号可抢的最大档位 = get-info.currentLv（官方等级接口）
    const rawLv =
      vipResult.currentLv ||
      vipResult.maxLv ||
      vipResult.level ||
      vipResult.vipLevel ||
      (vipResult.user && (vipResult.user.currentLv || vipResult.user.level)) ||
      null;
    const vipLevelTrusted = !!(rawLv && vipOk);
    const vipLevel = vipLevelTrusted ? normalizeVipLevel(rawLv) : null;

    const nickname =
      selfResult.nick ||
      selfResult.nickname ||
      selfResult.nickName ||
      selfResult.name ||
      (selfResult.user && (selfResult.user.nick || selfResult.user.nickname)) ||
      mobile;

    const uid =
      selfResult.uid ||
      selfResult.userId ||
      selfResult.urs_id ||
      (selfResult.user && selfResult.user.uid) ||
      null;

    const godCookie = this.jar
      .getCookiesSync('https://pay.ds.163.com/')
      .find((c) => c.key === 'GOD_UUID');

    if (godCookie) {
      this.client.defaults.headers.common['gl-uid'] = godCookie.value;
      this.client.defaults.headers.common['GL-Uid'] = godCookie.value;
    }

    if (!vipLevelTrusted) {
      console.warn(
        `[login] get-info 未拿到 currentLv（code=${vipData.code} ${
          vipData.errmsg || vipData.msg || ''
        }），不覆盖已有等级`
      );
    } else {
      console.log(`[login] 账号最大档位 currentLv=${vipLevel}`);
    }

    return {
      mobile: String(mobile),
      nickname: String(nickname),
      actAccount: actAccount ? String(actAccount) : null,
      vipLevel: vipLevel || 'V1',
      vipLevelTrusted,
      uid,
      godUuid: godCookie ? godCookie.value : null,
      deviceId: this.deviceId,
      cookies: jarToJSON(this.jar),
      cookieHeader: this.jar.getCookieStringSync('https://pay.ds.163.com/'),
      vipRaw: vipData,
      selfRaw: selfData,
      actRaw,
      loggedInAt: new Date().toISOString(),
    };
  }
}

function normalizeVipLevel(level) {
  if (level == null || level === '') return 'V1';
  const s = String(level).trim().toUpperCase();
  if (/^V\d+$/.test(s)) return s;
  const m = s.match(/(\d+)/);
  if (m) return `V${m[1]}`;
  return s.startsWith('V') ? s : `V${s}`;
}

module.exports = { LoginService, normalizeVipLevel };
