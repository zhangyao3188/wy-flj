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
    const remote = await manager.create({ targetCount });
    const url = `${PUBLIC_URL}/session.html?token=${remote.token}`;
    res.json({
      ok: true,
      token: remote.token,
      url,
      targetCount,
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

app.get('/api/accounts', async (_req, res) => {
  try {
    const list = await accountRepo.listActiveAccounts();
    res.json({
      ok: true,
      accounts: list.map((a) => ({
        id: a.id,
        mobile: a.mobile,
        nickname: a.nickname,
        vipLevel: a.vipLevel,
        successCount: a.successCount || 0,
        targetCount: a.targetCount || 1,
        loggedInAt: a.loggedInAt,
        updatedAt: a.updatedAt,
      })),
    });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message || String(e) });
  }
});

app.listen(PORT, () => {
  console.log(`[login] 在线登录: ${PUBLIC_URL}`);
  console.log(`[login] 健康检查: ${PUBLIC_URL}/health`);
  console.log('[login] 登录成功后写入 MySQL accounts 表');
});
