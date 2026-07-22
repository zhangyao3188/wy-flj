const express = require('express');
const path = require('path');
const fs = require('fs');

const localEnv = path.resolve(__dirname, '../.env');
if (fs.existsSync(localEnv)) require('dotenv').config({ path: localEnv });

const accountRepo = require('./accountRepo');
const { runSeckill } = require('./runner');

const app = express();
app.use(express.json({ limit: '1mb' }));

/** mobile -> { running, promise, result, error, startedAt } */
const jobs = new Map();

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'seckill' });
});

app.get('/api/users', async (_req, res) => {
  try {
    const list = await accountRepo.listActiveAccounts();
    const users = list.map((u) => ({
      mobile: u.mobile,
      nickname: u.nickname,
      vipLevel: u.vipLevel,
      updatedAt: u.updatedAt,
    }));
    res.json({ ok: true, users });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message || String(e) });
  }
});

/**
 * 启动抢购（无间隔轮询）
 * POST /api/seckill/start { "mobile": "13800138000" }
 */
app.post('/api/seckill/start', async (req, res) => {
  try {
    const mobile = String(req.body.mobile || '').trim();
    if (!mobile) throw new Error('mobile 必填');
    if (!(await accountRepo.findByMobile(mobile))) {
      throw new Error('用户未登录，请先调用 login 服务');
    }
    if (jobs.get(mobile)?.running) {
      return res.status(409).json({ ok: false, message: '该用户抢购任务已在运行' });
    }

    const job = {
      running: true,
      startedAt: new Date().toISOString(),
      result: null,
      error: null,
    };
    jobs.set(mobile, job);

    const immediate = !!req.body.immediate || !!req.body.now;
    job.promise = runSeckill(mobile, {
      vipLevel: req.body.vipLevel,
      immediate,
      maxAttempts: req.body.maxAttempts != null ? req.body.maxAttempts : Infinity,
      stopOnSuccess: req.body.stopOnSuccess !== false,
    })
      .then((result) => {
        job.running = false;
        job.result = result;
        return result;
      })
      .catch((err) => {
        job.running = false;
        job.error = err.message || String(err);
        throw err;
      });

    res.json({
      ok: true,
      message: immediate
        ? '测试抢购已启动（不等待开抢时间）'
        : '抢购已启动（完成后立刻下一发，无间隔）',
      mobile,
      immediate,
      startedAt: job.startedAt,
    });
  } catch (e) {
    res.status(400).json({ ok: false, message: e.message || String(e) });
  }
});

app.get('/api/seckill/status/:mobile', (req, res) => {
  const mobile = req.params.mobile;
  const job = jobs.get(mobile);
  if (!job) {
    return res.json({ ok: true, running: false, message: '无任务' });
  }
  res.json({
    ok: true,
    running: job.running,
    startedAt: job.startedAt,
    result: job.result,
    error: job.error,
  });
});

const PORT = Number(process.env.SECKILL_PORT || 3102);
app.listen(PORT, () => {
  console.log(`[seckill] listening on http://127.0.0.1:${PORT}`);
  console.log(`[seckill] accounts from MySQL`);
});
