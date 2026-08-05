const path = require('path');
const fs = require('fs');
const express = require('express');

const localEnv = path.resolve(__dirname, '../.env');
if (fs.existsSync(localEnv)) require('dotenv').config({ path: localEnv });

const db = require('./db');
const accountRepo = require('./accountRepo');
const { SessionManager } = require('./sessionManager');

const app = express();
const manager = new SessionManager();
const PORT = Number(process.env.PORTAL_PORT || process.env.LOGIN_PORT || 3200);
const PUBLIC_URL = (
  process.env.PORTAL_PUBLIC_URL ||
  process.env.LOGIN_PUBLIC_URL ||
  `http://127.0.0.1:${PORT}`
).replace(/\/$/, '');

app.use(express.json({ limit: '1mb' }));
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
    res.json({
      ok: true,
      total: accounts.length,
      vipStats,
      accounts,
    });
  } catch (e) {
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
    if (body.successCount !== undefined) patch.successCount = body.successCount;
    if (body.resetSuccess) patch.resetSuccess = true;
    const level = await accountRepo.updateSeckillLevel(levelId, patch);
    if (!level || String(level.mobile) !== String(account.mobile)) {
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
    if (!level || String(level.mobile) !== String(account.mobile)) {
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

app.listen(PORT, () => {
  console.log(`[login] 在线登录: ${PUBLIC_URL}`);
  console.log(`[login] 账号管理: ${PUBLIC_URL}/accounts.html`);
  console.log(`[login] 健康检查: ${PUBLIC_URL}/health`);
  console.log('[login] 登录成功后写入 MySQL accounts 表');
});
