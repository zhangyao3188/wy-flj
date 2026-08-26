const path = require('path');
const fs = require('fs');
const express = require('express');

const localEnv = path.resolve(__dirname, '../.env');
if (fs.existsSync(localEnv)) require('dotenv').config({ path: localEnv });

const db = require('./db');
const accountRepo = require('./accountRepo');
const { SessionManager } = require('./sessionManager');
const { parseCurlOrCookies } = require('./parseCurl');
const { createSession } = require('./http');
const { LoginService } = require('./loginService');
const pointsMallClient = require('./pointsMallClient');
const pointsTaskRepo = require('./pointsTaskRepo');
const { loadConfig: loadPointsConfig, getActId, isSameAct, actIdAliases } = require('./pointsConfig');

const app = express();
const manager = new SessionManager();
const PORT = Number(process.env.PORTAL_PORT || process.env.LOGIN_PORT || 3200);
const PUBLIC_URL = (
  process.env.PORTAL_PUBLIC_URL ||
  process.env.LOGIN_PUBLIC_URL ||
  `http://127.0.0.1:${PORT}`
).replace(/\/$/, '');

app.use(express.json({ limit: '4mb' }));
app.use(express.static(path.join(__dirname, '../public')));

app.get('/health', async (_req, res) => {
  try {
    await db.ping();
    res.json({ ok: true, service: 'login', db: true });
  } catch (e) {
    res.status(500).json({ ok: false, db: false, message: e.message || String(e) });
  }
});

app.post('/api/login/session', async (req, res) => {
  try {
    const raw = req.body && req.body.targetCount;
    if (raw === undefined || raw === null || String(raw).trim() === '') {
      return res.status(400).json({ ok: false, message: '请填写抢购次数' });
    }
    const targetCount = accountRepo.normalizeTargetCount(raw);
    if (Number(raw) < 1 || !Number.isFinite(Number(raw))) {
      return res.status(400).json({ ok: false, message: '抢购次数须为大于等于 1 的整数' });
    }
    const buyerNickname = accountRepo.normalizeBuyerNickname(
      req.body && req.body.buyerNickname
    );
    const remote = await manager.create({ targetCount, buyerNickname });
    const url = `${PUBLIC_URL}/session.html?token=${remote.token}`;
    res.json({
      ok: true,
      token: remote.token,
      url,
      targetCount,
      buyerNickname,
      message: '请打开链接，在画面中完成网易登录',
    });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message || String(e) });
  }
});

app.get('/api/login/session/:token', async (req, res) => {
  const token = req.params.token;
  const remote = manager.get(token);
  const row = await accountRepo.findLoginSession(token);
  if (!remote && !row) {
    return res.status(404).json({ ok: false, message: '会话不存在' });
  }
  res.json({
    ok: true,
    token,
    status: remote ? remote.status : row.status,
    message: remote ? remote.message : row.message,
    mobile: remote ? remote.mobile : row.mobile,
    account: remote ? remote.account : null,
  });
});

app.get('/api/login/session/:token/frame', async (req, res) => {
  const remote = manager.get(req.params.token);
  if (!remote || remote.status === 'success' || remote.status === 'failed') {
    return res.status(404).end();
  }
  const buf = (await remote.refreshFrame()) || remote.lastFrame;
  if (!buf) return res.status(204).end();
  res.set('Content-Type', 'image/jpeg');
  res.set('Cache-Control', 'no-store');
  res.send(buf);
});

app.post('/api/login/session/:token/input', async (req, res) => {
  const remote = manager.get(req.params.token);
  if (!remote || remote.status !== 'running') {
    return res.status(400).json({ ok: false, message: '会话不可用' });
  }
  try {
    const { type, x, y, text, key } = req.body || {};
    if (type === 'click') await remote.click(Number(x), Number(y));
    else if (type === 'type') await remote.type(text || '', { replace: req.body.replace !== false });
    else if (type === 'clear') await remote.clear();
    else if (type === 'press') await remote.press(key || 'Enter');
    else if (type === 'open-login') {
      let ok = false;
      for (let i = 0; i < 3 && !ok; i++) {
        ok = await remote.openLoginDialog();
        if (!ok) await new Promise((r) => setTimeout(r, 500));
      }
      if (!ok) {
        return res.status(400).json({ ok: false, message: '未能打开登录弹窗，请稍后重试或刷新页面' });
      }
    }
    else return res.status(400).json({ ok: false, message: '未知操作' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message || String(e) });
  }
});

/** 手动提取当前浏览器登录态并写入数据库（账号密码登录兜底） */
app.post('/api/login/session/:token/extract', async (req, res) => {
  const remote = manager.get(req.params.token);
  if (!remote) {
    return res.status(404).json({ ok: false, message: '会话不存在或已结束' });
  }
  try {
    const result = await remote.extractAndSave({
      mobile: req.body && req.body.mobile,
    });
    res.json(result);
  } catch (e) {
    res.status(400).json({ ok: false, message: e.message || String(e) });
  }
});

/**
 * Curl / Cookie 抓包导入（其他设备登录后复制 curl）
 * body: { curl|raw, mobile?, targetCount, buyerNickname? }
 */
app.post('/api/login/curl', async (req, res) => {
  try {
    const body = req.body || {};
    const raw = String(body.curl || body.raw || body.text || '').trim();
    if (!raw) {
      return res.status(400).json({ ok: false, message: '请粘贴 curl 或 Cookie 原文' });
    }
    if (body.targetCount == null || String(body.targetCount).trim() === '') {
      return res.status(400).json({ ok: false, message: '请填写抢购次数' });
    }
    if (Number(body.targetCount) < 1 || !Number.isFinite(Number(body.targetCount))) {
      return res.status(400).json({ ok: false, message: '抢购次数须为大于等于 1 的整数' });
    }
    const targetCount = accountRepo.normalizeTargetCount(body.targetCount);
    const buyerNickname = accountRepo.normalizeBuyerNickname(body.buyerNickname);

    const parsed = parseCurlOrCookies(raw);
    if (!parsed.cookieCount) {
      return res.status(400).json({
        ok: false,
        message:
          '未解析到 Cookie。请粘贴完整 curl（含 -H \'Cookie: ...\' 或 -b），或直接粘贴 Cookie 头内容',
      });
    }

    const mobileHint = String(body.mobile || '').trim();
    if (mobileHint && !/^1\d{10}$/.test(mobileHint)) {
      return res.status(400).json({
        ok: false,
        message: '手机号格式不正确（选填；若填写须为 11 位）',
      });
    }

    const session = createSession();
    const svc = new LoginService(session);
    // 手机号选填：无真实号则入库时自动分配 mock-1xxxxxxxxxx
    const bootstrapMobile = mobileHint || parsed.mobile || '00000000000';
    const result = await svc.importCookies(bootstrapMobile, parsed.cookies, {
      headers: parsed.headers,
    });

    const resolvedMobile = resolveImportedMobile({
      hint: mobileHint || parsed.mobile,
      cookies: parsed.cookies,
      user: result.user,
    });

    const saved = await accountRepo.upsertAccount({
      ...result.user,
      mobile: resolvedMobile, // null → upsert 内部分配 mock 虚拟号
      targetCount,
      buyerNickname,
    });

    const isMock = accountRepo.isMockMobile(saved.mobile);
    res.json({
      ok: true,
      message: isMock
        ? `Curl 导入成功（无绑定手机号，已分配虚拟号 ${saved.mobile}）`
        : 'Curl 导入成功，账号已写入数据库',
      cookieCount: parsed.cookieCount,
      account: accountRepo.toPublicAccount(saved),
    });
  } catch (e) {
    console.error('[login] curl import failed:', e.message || e);
    res.status(400).json({ ok: false, message: e.message || String(e) });
  }
});

/** 从抓包 / 资料里解析入库用手机号 */
function resolveImportedMobile({ hint, cookies, user }) {
  const tryPhone = (v) => {
    const m = String(v || '').match(/(1\d{10})/);
    return m ? m[1] : null;
  };
  if (hint && /^1\d{10}$/.test(hint)) return hint;
  const fromHint = tryPhone(hint);
  if (fromHint) return fromHint;
  if (user && user.mobile && /^1\d{10}$/.test(String(user.mobile))) {
    return String(user.mobile);
  }
  // 占位号不算有效手机号
  if (user && user.mobile && String(user.mobile) === '00000000000') {
    // fall through
  } else {
    const fromUserMobile = tryPhone(user && user.mobile);
    if (fromUserMobile) return fromUserMobile;
  }
  const fromUser = tryPhone(user && user.actAccount);
  if (fromUser) return fromUser;
  const selfRaw = user && user.selfRaw;
  if (selfRaw) {
    const result = selfRaw.result || selfRaw.data || selfRaw;
    for (const key of ['mobile', 'phone', 'account', 'loginName', 'ursAccount', 'actAccount']) {
      const hit = tryPhone(result && result[key]);
      if (hit) return hit;
    }
    const blobHit = tryPhone(JSON.stringify(result || {}));
    if (blobHit) return blobHit;
  }
  if (cookies && typeof cookies === 'object') {
    for (const key of ['P_INFO', 'S_INFO', 'THE_LAST_LOGIN_MOBILE', 'NTES_SESS_USER']) {
      const hit = tryPhone(cookies[key]);
      if (hit) return hit;
    }
    for (const v of Object.values(cookies)) {
      const hit = tryPhone(v);
      if (hit) return hit;
    }
  }
  return null;
}

/** 仅预览解析结果，不入库 */
app.post('/api/login/curl/preview', async (req, res) => {
  try {
    const raw = String((req.body && (req.body.curl || req.body.raw || req.body.text)) || '').trim();
    if (!raw) {
      return res.status(400).json({ ok: false, message: '请粘贴 curl 或 Cookie 原文' });
    }
    const parsed = parseCurlOrCookies(raw);
    const names = Object.keys(parsed.cookies);
    res.json({
      ok: true,
      cookieCount: parsed.cookieCount,
      mobile: parsed.mobile,
      cookieNames: names.slice(0, 40),
      hasGodUuid: !!(parsed.cookies.GOD_UUID || (parsed.headers && parsed.headers['gl-uid'])),
      hasPlutus: !!(
        parsed.cookies.NTES_plutus_online_front ||
        parsed.cookies.NTES_plutus_p_info_online
      ),
      hasUrs: !!(parsed.cookies.NTES_YD_SESS || parsed.cookies.NTES_SESS || parsed.cookies.P_INFO),
    });
  } catch (e) {
    res.status(400).json({ ok: false, message: e.message || String(e) });
  }
});

app.get('/api/accounts', async (req, res) => {
  try {
    const all = String(req.query.all || '') === '1' || String(req.query.all || '') === 'true';
    const list = all
      ? await accountRepo.listAllAccounts()
      : await accountRepo.listActiveAccounts();
    const accounts = list.map(accountRepo.toPublicAccount);
    const vipStats = {};
    for (const a of accounts) {
      const levels = a.levels && a.levels.length ? a.levels : [{ vipLevel: a.vipLevel }];
      for (const lv of levels) {
        const key = lv.vipLevel || a.vipLevel || '未知';
        vipStats[key] = (vipStats[key] || 0) + 1;
      }
    }
    const todaySuccessOrders = accounts.reduce(
      (sum, a) => sum + (Number(a.todaySuccessCount) || 0),
      0
    );
    const todaySuspectedOrders = accounts.reduce(
      (sum, a) => sum + (Number(a.todaySuspectedCount) || 0),
      0
    );
    const todayWelfareOrders = accounts.reduce(
      (sum, a) => sum + (Number(a.todayWelfareCount) || 0),
      0
    );
    const todaySuccessAccounts = accounts.filter((a) => (a.todaySuccessCount || 0) > 0).length;
    res.json({
      ok: true,
      total: accounts.length,
      vipStats,
      todaySuccessOrders,
      todaySuspectedOrders,
      todayWelfareOrders,
      todaySuccessAccounts,
      today: accountRepo.chinaDayRange().day,
      accounts,
    });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message || String(e) });
  }
});

/** 当日（或指定日）抢购成功订单 */
app.get('/api/seckill-success', async (req, res) => {
  try {
    const day = req.query.day ? String(req.query.day).trim() : null;
    const data = await accountRepo.listSuccessLogs({ day });
    res.json({ ok: true, ...data });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message || String(e) });
  }
});

/** 批量验证可用账号在线（actInfo，跳过已全部完成）——须放在 /:id 路由之前 */
app.post('/api/accounts/check-online', async (_req, res) => {
  try {
    console.log('[login] check-online start…');
    const data = await accountRepo.checkAllAccountsOnline();
    console.log(
      `[login] check-online done total=${data.total} online=${data.online} offline=${data.offline} skipped=${data.skipped || 0}`
    );
    const skipHint =
      data.skipped > 0 ? `，跳过已完成 ${data.skipped}` : '';
    res.json({
      ok: true,
      message: `验证完成：在线 ${data.online}，离线 ${data.offline}，共验证 ${data.total}${skipHint}`,
      ...data,
    });
  } catch (e) {
    console.error('[login] check-online failed:', e.message || e);
    res.status(500).json({ ok: false, message: e.message || String(e) });
  }
});

/** 单个账号验证在线 */
app.post('/api/accounts/:id/check-online', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id < 1) {
      return res.status(400).json({ ok: false, message: '无效账号 id' });
    }
    const result = await accountRepo.checkAccountOnline(id);
    res.json({
      ok: true,
      message: result.message || (result.online ? '在线' : '离线'),
      result,
      results: [result],
      online: result.online ? 1 : 0,
      offline: result.online ? 0 : 1,
      total: 1,
    });
  } catch (e) {
    console.error('[login] check-online one failed:', e.message || e);
    res.status(500).json({ ok: false, message: e.message || String(e) });
  }
});

app.get('/api/accounts/:id', async (req, res) => {
  try {
    const user = await accountRepo.findById(req.params.id);
    if (!user) return res.status(404).json({ ok: false, message: '账号不存在' });
    res.json({ ok: true, account: accountRepo.toPublicAccount(user) });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message || String(e) });
  }
});

/** 用库内 Cookie 同步账号等级 / 账户名称等 */
app.post('/api/accounts/:id/sync', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id < 1) {
      return res.status(400).json({ ok: false, message: '无效账号 id' });
    }
    const fresh = await accountRepo.syncAccountProfile(id);
    res.json({
      ok: true,
      message: `已同步：最大档 ${fresh.vipLevel}${
        fresh.actAccount ? `，账户 ${fresh.actAccount}` : ''
      }`,
      account: accountRepo.toPublicAccount(fresh),
    });
  } catch (e) {
    console.error('[login] sync account failed:', e.message || e);
    res.status(400).json({ ok: false, message: e.message || String(e) });
  }
});

/** 为账号新增抢购等级 */
app.post('/api/accounts/:id/levels', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const body = req.body || {};
    const level = await accountRepo.addSeckillLevel(id, {
      vipLevel: body.vipLevel,
      targetCount: body.targetCount,
    });
    const account = await accountRepo.findById(id);
    res.json({
      ok: true,
      level,
      account: accountRepo.toPublicAccount(account),
      message: `已添加抢购等级 ${level.vipLevel}`,
    });
  } catch (e) {
    res.status(400).json({ ok: false, message: e.message || String(e) });
  }
});

/** 更新某抢购等级次数 / 重置成功 */
app.patch('/api/accounts/:id/levels/:levelId', async (req, res) => {
  try {
    const accountId = Number(req.params.id);
    const levelId = Number(req.params.levelId);
    const account = await accountRepo.findById(accountId);
    if (!account) return res.status(404).json({ ok: false, message: '账号不存在' });
    const body = req.body || {};
    const patch = {};
    if (body.targetCount !== undefined) {
      if (Number(body.targetCount) < 1 || !Number.isFinite(Number(body.targetCount))) {
        return res.status(400).json({ ok: false, message: '抢购次数须为大于等于 1 的整数' });
      }
      patch.targetCount = body.targetCount;
    }
    if (body.successCount !== undefined) {
      const n = Math.floor(Number(body.successCount));
      if (!Number.isFinite(n) || n < 0) {
        return res.status(400).json({ ok: false, message: '成功次数须为大于等于 0 的整数' });
      }
      patch.successCount = n;
    }
    if (body.resetSuccess) patch.resetSuccess = true;
    const level = await accountRepo.updateSeckillLevel(levelId, patch);
    if (!level || Number(level.accountId) !== accountId) {
      return res.status(404).json({ ok: false, message: '抢购等级不存在' });
    }
    const fresh = await accountRepo.findById(accountId);
    res.json({ ok: true, level, account: accountRepo.toPublicAccount(fresh) });
  } catch (e) {
    res.status(400).json({ ok: false, message: e.message || String(e) });
  }
});

app.post('/api/accounts/:id/levels/:levelId/delete', async (req, res) => {
  try {
    const accountId = Number(req.params.id);
    const levelId = Number(req.params.levelId);
    const account = await accountRepo.findById(accountId);
    if (!account) return res.status(404).json({ ok: false, message: '账号不存在' });
    const level = await accountRepo.deleteSeckillLevel(levelId);
    if (!level || Number(level.accountId) !== accountId) {
      return res.status(404).json({ ok: false, message: '抢购等级不存在' });
    }
    const fresh = await accountRepo.findById(accountId);
    res.json({
      ok: true,
      message: `已删除抢购等级 ${level.vipLevel}`,
      account: accountRepo.toPublicAccount(fresh),
    });
  } catch (e) {
    res.status(400).json({ ok: false, message: e.message || String(e) });
  }
});

/** 更新账号主信息（兼容旧入口；次数建议改走等级接口） */
app.patch('/api/accounts/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id < 1) {
      return res.status(400).json({ ok: false, message: '无效账号 id' });
    }
    const existing = await accountRepo.findById(id);
    if (!existing) return res.status(404).json({ ok: false, message: '账号不存在' });

    const body = req.body || {};
    const patch = {};
    if (body.targetCount !== undefined) {
      if (body.targetCount == null || String(body.targetCount).trim() === '') {
        return res.status(400).json({ ok: false, message: '请填写抢购次数' });
      }
      if (Number(body.targetCount) < 1 || !Number.isFinite(Number(body.targetCount))) {
        return res.status(400).json({ ok: false, message: '抢购次数须为大于等于 1 的整数' });
      }
      patch.targetCount = body.targetCount;
    }
    if (body.successCount !== undefined) patch.successCount = body.successCount;
    if (body.nickname !== undefined) patch.nickname = body.nickname;
    if (body.buyerNickname !== undefined) patch.buyerNickname = body.buyerNickname;
    if (body.resetSuccess) patch.successCount = 0;

    if (!Object.keys(patch).length) {
      return res.status(400).json({ ok: false, message: '无有效更新字段' });
    }

    const updated = await accountRepo.updateAccount(id, patch);
    // 若只改主表次数，同步到主等级记录
    if (patch.targetCount != null || patch.successCount != null) {
      const main = (updated.levels || []).find(
        (l) => String(l.vipLevel).toUpperCase() === String(updated.vipLevel).toUpperCase()
      );
      if (main && main.id) {
        await accountRepo.updateSeckillLevel(main.id, {
          ...(patch.targetCount != null ? { targetCount: patch.targetCount } : {}),
          ...(patch.successCount != null ? { successCount: patch.successCount } : {}),
        });
      }
    }
    const fresh = await accountRepo.findById(id);
    res.json({ ok: true, account: accountRepo.toPublicAccount(fresh) });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message || String(e) });
  }
});

async function handleDeleteAccount(req, res) {
  try {
    const deleted = await accountRepo.deleteAccount(req.params.id);
    if (!deleted) return res.status(404).json({ ok: false, message: '账号不存在' });
    res.json({
      ok: true,
      message: `已删除账号 ${deleted.mobile}`,
      account: accountRepo.toPublicAccount(deleted),
    });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message || String(e) });
  }
}

app.delete('/api/accounts/:id', handleDeleteAccount);
/** 兼容部分环境拦截 DELETE：前端优先走此接口 */
app.post('/api/accounts/:id/delete', handleDeleteAccount);

function publicPointsAccount(account, tasks) {
  const base = accountRepo.toPublicAccount(account);
  const list = Array.isArray(tasks) ? tasks.filter(Boolean) : tasks ? [tasks] : [];
  return {
    ...base,
    pointsTasks: list,
    /** 兼容旧前端：取最近一条 */
    pointsTask: list[0] || null,
  };
}

function publicPointsProfile(profile) {
  if (!profile) return null;
  const currency = profile.currency || null;
  return {
    actAccount: profile.actAccount || null,
    currentTime: profile.currentTime || null,
    appKey: profile.appKey || null,
    role: profile.role || null,
    roles: profile.roles || [],
    actRoleInfo: profile.role
      ? {
          roleId: profile.role.roleId,
          roleName: profile.role.roleName,
          nick: profile.role.roleName,
          server: profile.role.server,
          serverName: profile.role.serverName,
          appKey: profile.role.appKey,
        }
      : null,
    currency: currency
      ? {
          ok: !!currency.ok,
          balance: currency.balance != null ? currency.balance : null,
          currencyType: currency.currencyType || null,
          currencyName: currency.currencyName || null,
          message: currency.message || null,
        }
      : null,
  };
}

app.get('/api/points/identity-v/accounts', async (_req, res) => {
  try {
    await pointsTaskRepo.ensureTables();
    const cfg = loadPointsConfig();
    const list = await accountRepo.listAllAccounts();
    const tasks = await pointsTaskRepo.listTasks();
    const byAccount = new Map();
    for (const t of tasks.filter((t) => isSameAct(t.actId, cfg))) {
      const aid = Number(t.accountId);
      if (!byAccount.has(aid)) byAccount.set(aid, []);
      byAccount.get(aid).push(t);
    }
    const accounts = list.map((a) => publicPointsAccount(a, byAccount.get(Number(a.id)) || []));
    res.json({
      ok: true,
      game: cfg.gameName,
      actId: getActId(cfg),
      currencyName: cfg.currencyName || '积分',
      total: accounts.length,
      accounts,
    });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message || String(e) });
  }
});

app.get('/api/points/identity-v/accounts/:id/profile', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id < 1) {
      return res.status(400).json({ ok: false, message: '无效账号 id' });
    }
    const account = await accountRepo.findById(id);
    if (!account) return res.status(404).json({ ok: false, message: '账号不存在' });
    const profile = publicPointsProfile(await pointsMallClient.fetchProfile(account));
    const cfg = loadPointsConfig();
    const tasks = await pointsTaskRepo.listTasksByAccountId(id, actIdAliases(cfg));
    res.json({
      ok: true,
      account: publicPointsAccount(account, tasks),
      profile,
    });
  } catch (e) {
    res.status(400).json({ ok: false, message: e.message || String(e) });
  }
});

app.get('/api/points/identity-v/accounts/:id/goods', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id < 1) {
      return res.status(400).json({ ok: false, message: '无效账号 id' });
    }
    const account = await accountRepo.findById(id);
    if (!account) return res.status(404).json({ ok: false, message: '账号不存在' });
    const listed = await pointsMallClient.fetchGoods(account);
    res.json({
      ok: true,
      goods: listed.goods || [],
      message: listed.message || null,
      currentTime: listed.currentTime || null,
    });
  } catch (e) {
    res.status(400).json({ ok: false, message: e.message || String(e) });
  }
});

app.put('/api/points/identity-v/accounts/:id/task', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id < 1) {
      return res.status(400).json({ ok: false, message: '无效账号 id' });
    }
    const account = await accountRepo.findById(id);
    if (!account) return res.status(404).json({ ok: false, message: '账号不存在' });
    const body = req.body || {};
    const goodsId = String(body.goodsId || body.exchangeId || '').trim();
    if (!goodsId) return res.status(400).json({ ok: false, message: '请选择商品' });
    // 开抢时间由 points-seckill/.env 的 POINTS_SECKILL_START_AT 或 test:now 决定，web 不再配置
    const startAt =
      body.startAt ||
      body.start_at ||
      pointsTaskRepo.formatDateTime(new Date());
    if (body.targetCount != null && (Number(body.targetCount) < 1 || !Number.isFinite(Number(body.targetCount)))) {
      return res.status(400).json({ ok: false, message: '抢购次数须为大于等于 1 的整数' });
    }
    const cfg = loadPointsConfig();
    const role = body.role && typeof body.role === 'object' ? body.role : {
      roleId: body.roleId,
      roleName: body.roleName,
      server: body.server,
      serverName: body.serverName,
      appKey: body.appKey,
    };
    if (role && role.roleId) {
      await pointsMallClient.bindRole(account, role).catch(() => {});
    }
    const task = await pointsTaskRepo.upsertTask({
      accountId: id,
      mobile: account.mobile,
      actId: getActId(cfg),
      goodsId,
      goodsName: body.goodsName || null,
      goodsRaw: body.goods || body.goodsRaw || null,
      roleId: role && role.roleId,
      roleName: role && role.roleName,
      server: role && role.server,
      serverName: role && role.serverName,
      appKey: (role && role.appKey) || cfg.appKey,
      currencyType: body.currencyType || cfg.currencyType,
      currencyBalance: body.currencyBalance,
      startAt,
      targetCount: body.targetCount,
    });
    const tasks = await pointsTaskRepo.listTasksByAccountId(id, actIdAliases(cfg));
    res.json({
      ok: true,
      message: '已提交积分抢购任务',
      task,
      account: publicPointsAccount(account, tasks),
    });
  } catch (e) {
    res.status(400).json({ ok: false, message: e.message || String(e) });
  }
});

async function handleDeletePointsTask(req, res) {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id < 1) {
      return res.status(400).json({ ok: false, message: '无效账号 id' });
    }
    const account = await accountRepo.findById(id);
    if (!account) return res.status(404).json({ ok: false, message: '账号不存在' });
    const cfg = loadPointsConfig();
    const body = req.body || {};
    const taskId = body.taskId != null ? Number(body.taskId) : null;
    const goodsId = body.goodsId ? String(body.goodsId).trim() : null;
    await pointsTaskRepo.deleteTask({
      id: Number.isFinite(taskId) && taskId > 0 ? taskId : null,
      accountId: id,
      actId: actIdAliases(cfg),
      goodsId: goodsId || null,
    });
    const tasks = await pointsTaskRepo.listTasksByAccountId(id, actIdAliases(cfg));
    res.json({
      ok: true,
      message: '已删除抢购任务',
      account: publicPointsAccount(account, tasks),
    });
  } catch (e) {
    res.status(400).json({ ok: false, message: e.message || String(e) });
  }
}

app.delete('/api/points/identity-v/accounts/:id/task', handleDeletePointsTask);
app.post('/api/points/identity-v/accounts/:id/task/delete', handleDeletePointsTask);

app.get('/api/points/identity-v/tasks', async (_req, res) => {
  try {
    const cfg = loadPointsConfig();
    const tasks = (await pointsTaskRepo.listTasks()).filter((t) => isSameAct(t.actId, cfg));
    res.json({ ok: true, tasks });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message || String(e) });
  }
});

app.get('/api/points-seckill-success', async (req, res) => {
  try {
    const day = req.query.day ? String(req.query.day).trim() : null;
    const data = await pointsTaskRepo.listSuccessLogs({ day });
    res.json({ ok: true, ...data });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message || String(e) });
  }
});

app.listen(PORT, () => {
  console.log(`[login] 在线登录: ${PUBLIC_URL}`);
  console.log(`[login] 账号管理: ${PUBLIC_URL}/accounts.html`);
  console.log(`[login] 健康检查: ${PUBLIC_URL}/health`);
  console.log('[login] 登录成功后写入 MySQL accounts 表');
});
