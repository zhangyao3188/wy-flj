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
    const targetCount = accountRepo.normalizeTargetCount(req.body.targetCount);
    if (req.body.targetCount == null || String(req.body.targetCount).trim() === '') {
      throw new Error('请填写抢购次数 targetCount');
    }
    if (Number(req.body.targetCount) < 1 || !Number.isFinite(Number(req.body.targetCount))) {
      throw new Error('抢购次数须为大于等于 1 的整数');
    }
    const svc = getOrCreateService(mobile);
    const result = await svc.login(mobile, code);
    const saved = await accountRepo.upsertAccount({ ...result.user, targetCount });
    res.json({
      ok: true,
      message: '登录成功，用户信息已保存',
      user: {
        mobile: saved.mobile,
        nickname: saved.nickname,
        vipLevel: saved.vipLevel,
        uid: saved.uid,
        targetCount: saved.targetCount,
        successCount: saved.successCount,
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
    if (req.body.targetCount == null || String(req.body.targetCount).trim() === '') {
      throw new Error('请填写抢购次数 targetCount');
    }
    if (Number(req.body.targetCount) < 1 || !Number.isFinite(Number(req.body.targetCount))) {
      throw new Error('抢购次数须为大于等于 1 的整数');
    }
    const targetCount = accountRepo.normalizeTargetCount(req.body.targetCount);

    const session = createSession();
    const svc = new LoginService(session);
    sessions.set(mobile, svc);
    const result = await svc.importCookies(mobile, cookies);
    const saved = await accountRepo.upsertAccount({ ...result.user, targetCount });
    res.json({
      ok: true,
      message: 'Cookie 登录成功，用户信息已保存',
      user: {
        mobile: saved.mobile,
        nickname: saved.nickname,
        vipLevel: saved.vipLevel,
        uid: saved.uid,
        targetCount: saved.targetCount,
        successCount: saved.successCount,
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
      targetCount: u.targetCount,
      successCount: u.successCount,
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
        targetCount: user.targetCount,
        successCount: user.successCount,
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
