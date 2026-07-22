const express = require('express');
const path = require('path');
const fs = require('fs');

const localEnv = path.resolve(__dirname, '../.env');
if (fs.existsSync(localEnv)) require('dotenv').config({ path: localEnv });

const { createSession } = require('./http');
const { LoginService } = require('./loginService');
const accountRepo = require('./accountRepo');

const app = express();
app.use(express.json({ limit: '2mb' }));

/** 进行中的会话：mobile -> LoginService */
const sessions = new Map();

function getOrCreateService(mobile) {
  const key = String(mobile);
  if (!sessions.has(key)) {
    const session = createSession();
    sessions.set(key, new LoginService(session));
  }
  return sessions.get(key);
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'login' });
});

app.post('/api/send-code', async (req, res) => {
  try {
    const mobile = String(req.body.mobile || '').trim();
    const svc = getOrCreateService(mobile);
    const result = await svc.sendCode(mobile);
    res.json(result);
  } catch (e) {
    res.status(400).json({ ok: false, message: e.message || String(e) });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const mobile = String(req.body.mobile || '').trim();
    const code = String(req.body.code || '').trim();
    const svc = getOrCreateService(mobile);
    const result = await svc.login(mobile, code);
    const saved = await accountRepo.upsertAccount(result.user);
    res.json({
      ok: true,
      message: '登录成功，用户信息已保存',
      user: {
        mobile: saved.mobile,
        nickname: saved.nickname,
        vipLevel: saved.vipLevel,
        uid: saved.uid,
        updatedAt: saved.updatedAt,
      },
    });
  } catch (e) {
    res.status(400).json({ ok: false, message: e.message || String(e) });
  }
});

app.post('/api/login/cookie', async (req, res) => {
  try {
    const mobile = String(req.body.mobile || '').trim();
    const cookies = req.body.cookies || {};
    if (!mobile) throw new Error('mobile 必填');
    if (!cookies || typeof cookies !== 'object') throw new Error('cookies 必填');

    const session = createSession();
    const svc = new LoginService(session);
    sessions.set(mobile, svc);
    const result = await svc.importCookies(mobile, cookies);
    const saved = await accountRepo.upsertAccount(result.user);
    res.json({
      ok: true,
      message: 'Cookie 登录成功，用户信息已保存',
      user: {
        mobile: saved.mobile,
        nickname: saved.nickname,
        vipLevel: saved.vipLevel,
        uid: saved.uid,
        updatedAt: saved.updatedAt,
      },
    });
  } catch (e) {
    res.status(400).json({ ok: false, message: e.message || String(e) });
  }
});

app.get('/api/users', async (_req, res) => {
  try {
    const list = await accountRepo.listActiveAccounts();
    const users = list.map((u) => ({
      mobile: u.mobile,
      nickname: u.nickname,
      vipLevel: u.vipLevel,
      uid: u.uid,
      updatedAt: u.updatedAt,
    }));
    res.json({ ok: true, users });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message || String(e) });
  }
});

app.get('/api/users/:mobile', async (req, res) => {
  try {
    const user = await accountRepo.findByMobile(req.params.mobile);
    if (!user) return res.status(404).json({ ok: false, message: '用户不存在' });
    res.json({
      ok: true,
      user: {
        mobile: user.mobile,
        nickname: user.nickname,
        vipLevel: user.vipLevel,
        uid: user.uid,
        updatedAt: user.updatedAt,
      },
    });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message || String(e) });
  }
});

const PORT = Number(process.env.LOGIN_PORT || 3101);
app.listen(PORT, () => {
  console.log(`[login-server] listening on http://127.0.0.1:${PORT}`);
  console.log(`[login-server] accounts from MySQL`);
});
