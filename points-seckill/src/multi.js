const path = require('path');
const fs = require('fs');

const localEnv = path.resolve(__dirname, '../.env');
if (fs.existsSync(localEnv)) require('dotenv').config({ path: localEnv });

const accountRepo = require('./accountRepo');
const {
  runPointsSeckill,
  formatFireOffsetLabel,
  resolveFireOffsetRange,
  resolveTestFireAt,
  resolveDevStartAt,
} = require('./runner');
const { nowMs } = require('./client');

function parseArgs(argv) {
  const out = { mobiles: [], immediate: false, testStartAt: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--now') out.immediate = true;
    else if (a === '--at' || a === '--at=') {
      out.immediate = true;
      if (a.startsWith('--at=') && a.length > 5) out.testStartAt = a.slice(5);
      else out.testStartAt = argv[++i];
    } else if (a.startsWith('--at=')) {
      out.immediate = true;
      out.testStartAt = a.slice(a.indexOf('=') + 1);
    } else if (!a.startsWith('-')) {
      out.mobiles.push(a);
    }
  }
  if (!out.testStartAt) {
    out.testStartAt =
      process.env.POINTS_SECKILL_TEST_START_AT || process.env.SECKILL_TEST_START_AT || null;
    if (out.testStartAt) out.immediate = true;
  }
  return out;
}

function formatClock(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(
    d.getMinutes()
  )}:${p(d.getSeconds())}`;
}

async function runMulti(options = {}) {
  const fireRange = resolveFireOffsetRange(options);
  const immediate = !!options.immediate;
  const jobs = await accountRepo.listIncompleteTasks(options.mobiles);
  if (!jobs.length) {
    throw new Error('无可用积分抢购任务（请先在 web /points-mall 提交）');
  }

  const baseAt = immediate
    ? resolveTestFireAt(options, nowMs())
    : resolveDevStartAt(options, nowMs());

  console.log('');
  console.log('==============================');
  console.log('   第五人格积分商城抢购');
  console.log('==============================');
  console.log(
    `任务 ${jobs.length} 个；开火偏移 ${formatFireOffsetLabel(fireRange.min)} ~ ${formatFireOffsetLabel(
      fireRange.max
    )}`
  );
  if (immediate) {
    const mode = options.testStartAt ? `--at ${options.testStartAt}` : '下一整分';
    console.log(`[test] 模式 ${mode} → ${formatClock(baseAt)}`);
  } else {
    console.log(`[dev] 开抢时间 POINTS_SECKILL_START_AT → ${formatClock(baseAt)}`);
  }
  for (const j of jobs) {
    console.log(`  - ${j.mobile} ${j.goodsName || j.goodsId}  ${j.successCount}/${j.targetCount}`);
  }

  const results = await Promise.all(
    jobs.map(async (job) => {
      const label = `${job.mobile}/${job.goodsName || job.goodsId}`;
      try {
        const r = await runPointsSeckill(job, options);
        console.log(
          `[done] ${label} success=${r.success} attempts=${r.attempts} reason=${r.stopReason}`
        );
        return { mobile: job.mobile, goodsId: job.goodsId, goodsName: job.goodsName, ...r };
      } catch (e) {
        console.error(`[done] ${label} 失败: ${e.message || e}`);
        return {
          mobile: job.mobile,
          goodsId: job.goodsId,
          goodsName: job.goodsName,
          success: false,
          error: e.message || String(e),
        };
      }
    })
  );

  const ok = results.filter((r) => r.success).length;
  console.log(`[${immediate ? 'test' : 'dev'}] 完成 ${ok}/${results.length}`);
  return results;
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  runMulti(args).catch((e) => {
    console.error('[points-seckill]', e.message || e);
    process.exit(1);
  });
}

module.exports = { runMulti, parseArgs };
