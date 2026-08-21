const db = require('./db');

function normalizeTargetCount(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(Math.floor(n), 9999);
}

function normalizeBuyerNickname(value) {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s) return null;
  return s.slice(0, 128);
}

/** 真实 11 位手机号 */
function isRealMobile(value) {
  return /^1\d{10}$/.test(String(value || '').trim());
}

/** 虚拟号：mock-1xxxxxxxxxx */
function isMockMobile(value) {
  return /^mock-1\d{10}$/i.test(String(value || '').trim());
}

function isUsableMobile(value) {
  return isRealMobile(value) || isMockMobile(value);
}

function buildMockMobileFromSeed(seed) {
  const crypto = require('crypto');
  const h = crypto.createHash('sha1').update(String(seed || `t${Date.now()}`)).digest('hex');
  let digits = '';
  for (let i = 0; i < h.length && digits.length < 10; i++) {
    const n = parseInt(h[i], 16);
    if (n < 10) digits += String(n);
  }
  while (digits.length < 10) digits += '0';
  return `mock-1${digits.slice(0, 10)}`;
}

/** 生成不冲突的虚拟手机号（格式 mock-1xxxxxxxxxx） */
async function allocateMockMobile(seed) {
  const baseSeed = seed || `auto-${Date.now()}-${Math.random()}`;
  for (let i = 0; i < 64; i++) {
    const candidate = buildMockMobileFromSeed(i === 0 ? baseSeed : `${baseSeed}#${i}`);
    const rows = await db.query('SELECT id FROM accounts WHERE mobile = ? LIMIT 1', [
      candidate,
    ]);
    if (!rows.length) return candidate;
  }
  return `mock-1${String(Date.now()).slice(-10)}`;
}

/**
 * 解析入库手机号：优先真实号；否则保留已有 mock；否则新分配 mock
 */
async function resolveAccountMobile(user, existingRow = null) {
  const raw = user && user.mobile != null ? String(user.mobile).trim() : '';
  if (raw && raw !== '00000000000' && isRealMobile(raw)) return raw;
  if (raw && isMockMobile(raw)) return raw;

  if (existingRow && isUsableMobile(existingRow.mobile)) {
    return String(existingRow.mobile).trim();
  }

  const seed =
    (user && (user.godUuid || user.uid || user.actAccount)) ||
    (existingRow && (existingRow.god_uuid || existingRow.uid || existingRow.act_account)) ||
    `new-${Date.now()}`;
  return allocateMockMobile(seed);
}

function normalizeVipLevel(value) {
  const s = String(value || '')
    .trim()
    .toUpperCase();
  const m = s.match(/^V?(\d{1,2})$/);
  if (m) return `V${Number(m[1])}`;
  if (/^V\d+$/.test(s)) return s;
  return null;
}

function levelRank(lv) {
  const m = String(lv || '').match(/(\d+)/);
  return m ? Number(m[1]) : 0;
}

function rowToLevel(row) {
  if (!row) return null;
  const successCount = Number(row.success_count) || 0;
  const targetCount = normalizeTargetCount(row.target_count);
  return {
    id: row.id,
    accountId: row.account_id,
    mobile: row.mobile,
    vipLevel: row.vip_level,
    successCount,
    targetCount,
    completed: successCount >= targetCount,
    lastSuccessAt: row.last_success_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToUser(row) {
  if (!row) return null;
  let cookies = [];
  try {
    cookies = row.cookies_json ? JSON.parse(row.cookies_json) : [];
  } catch (_) {
    cookies = [];
  }
  let vipRaw = null;
  let selfRaw = null;
  try {
    vipRaw = row.vip_raw ? JSON.parse(row.vip_raw) : null;
  } catch (_) {}
  try {
    selfRaw = row.self_raw ? JSON.parse(row.self_raw) : null;
  } catch (_) {}

  return {
    id: row.id,
    mobile: row.mobile,
    nickname: row.nickname,
    buyerNickname: row.buyer_nickname || null,
    actAccount: row.act_account || null,
    vipLevel: row.vip_level,
    uid: row.uid,
    godUuid: row.god_uuid,
    deviceId: row.device_id,
    cookies,
    cookieHeader: row.cookie_header,
    vipRaw,
    selfRaw,
    status: row.status,
    successCount: Number(row.success_count) || 0,
    targetCount: normalizeTargetCount(row.target_count),
    levels: row._levels || [],
    lastSuccessAt: row.last_success_at || null,
    todaySuccessCount: Number(row._todaySuccessCount) || 0,
    loggedInAt: row.logged_in_at,
    updatedAt: row.updated_at,
  };
}

/** 上海时区当日 [start, end) */
function chinaDayRange(date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const day = fmt.format(date); // YYYY-MM-DD
  const start = new Date(`${day}T00:00:00+08:00`);
  const end = new Date(`${day}T00:00:00+08:00`);
  end.setDate(end.getDate() + 1);
  return { day, start, end };
}

async function ensureSuccessLogSchema() {
  try {
    await db.query(
      `ALTER TABLE accounts ADD COLUMN last_success_at DATETIME NULL COMMENT '最近一次真实抢购成功时间' AFTER target_count`
    );
  } catch (_) {}
  try {
    await db.query(
      `ALTER TABLE account_seckill_levels ADD COLUMN last_success_at DATETIME NULL COMMENT '该等级最近一次真实抢购成功时间' AFTER success_count`
    );
  } catch (_) {}
  try {
    await db.query(`
CREATE TABLE IF NOT EXISTS seckill_success_logs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  account_id BIGINT UNSIGNED NULL,
  mobile VARCHAR(20) NULL,
  vip_level VARCHAR(16) NULL,
  coupon_id VARCHAR(128) NULL,
  stock_id VARCHAR(256) NULL,
  success_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  kind VARCHAR(16) NOT NULL DEFAULT 'confirmed' COMMENT 'confirmed=真实成功 suspected=疑似成功(809)',
  note VARCHAR(256) NULL COMMENT '疑似成功说明',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_success_at (success_at),
  KEY idx_account_id (account_id),
  KEY idx_mobile (mobile),
  KEY idx_kind (kind)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  } catch (_) {}
  try {
    await db.query(
      `ALTER TABLE seckill_success_logs ADD COLUMN kind VARCHAR(16) NOT NULL DEFAULT 'confirmed' COMMENT 'confirmed=真实成功 suspected=疑似成功(809)' AFTER success_at`
    );
  } catch (_) {}
  try {
    await db.query(
      `ALTER TABLE seckill_success_logs ADD COLUMN note VARCHAR(256) NULL COMMENT '疑似成功说明' AFTER kind`
    );
  } catch (_) {}
}

async function attachTodaySuccessCounts(users) {
  if (!users || !users.length) return users;
  await ensureSuccessLogSchema();
  const { start, end } = chinaDayRange();
  const ids = users.map((u) => u.id).filter(Boolean);
  if (!ids.length) return users;
  const placeholders = ids.map(() => '?').join(',');
  let rows = [];
  try {
    rows = await db.query(
      `SELECT account_id,
              COUNT(*) AS cnt,
              SUM(CASE WHEN kind = 'suspected' THEN 1 ELSE 0 END) AS suspected_cnt,
              SUM(CASE WHEN kind = 'welfare' THEN 1 ELSE 0 END) AS welfare_cnt
       FROM seckill_success_logs
       WHERE account_id IN (${placeholders})
         AND success_at >= ? AND success_at < ?
       GROUP BY account_id`,
      [...ids, start, end]
    );
  } catch (_) {
    rows = [];
  }
  const countMap = new Map();
  const suspectedMap = new Map();
  const welfareMap = new Map();
  for (const r of rows) {
    countMap.set(Number(r.account_id), Number(r.cnt) || 0);
    suspectedMap.set(Number(r.account_id), Number(r.suspected_cnt) || 0);
    welfareMap.set(Number(r.account_id), Number(r.welfare_cnt) || 0);
  }
  for (const u of users) {
    u.todaySuccessCount = countMap.get(Number(u.id)) || 0;
    u.todaySuspectedCount = suspectedMap.get(Number(u.id)) || 0;
    u.todayWelfareCount = welfareMap.get(Number(u.id)) || 0;
  }
  return users;
}

/**
 * 当日抢购成功订单列表
 */
async function listSuccessLogs({ day = null, limit = 500 } = {}) {
  await ensureSuccessLogSchema();
  const { day: d, start, end } = chinaDayRange(
    day ? new Date(`${day}T12:00:00+08:00`) : new Date()
  );
  const lim = Math.min(Math.max(Number(limit) || 500, 1), 2000);
  const rows = await db.query(
    `SELECT l.*,
            a.buyer_nickname,
            a.act_account,
            a.nickname,
            a.vip_level AS account_vip_level,
            lv.success_count AS level_success_count,
            lv.target_count AS level_target_count
     FROM seckill_success_logs l
     LEFT JOIN accounts a ON a.id = l.account_id
     LEFT JOIN account_seckill_levels lv
       ON lv.vip_level <=> l.vip_level
       AND (
         (l.account_id IS NOT NULL AND lv.account_id = l.account_id)
         OR (l.account_id IS NULL AND l.mobile IS NOT NULL AND lv.mobile = l.mobile)
       )
     WHERE l.success_at >= ? AND l.success_at < ?
     ORDER BY l.success_at DESC
     LIMIT ${lim}`,
    [start, end]
  );
  return {
    day: d,
    total: rows.length,
    logs: rows.map((r) => ({
      id: r.id,
      accountId: r.account_id,
      mobile: r.mobile,
      vipLevel: r.vip_level,
      couponId: r.coupon_id,
      stockId: r.stock_id,
      successAt: r.success_at,
      kind: r.kind || 'confirmed',
      note: r.note || null,
      buyerNickname: r.buyer_nickname || null,
      actAccount: r.act_account || null,
      nickname: r.nickname || null,
      accountVipLevel: r.account_vip_level || null,
      successCount:
        r.level_success_count != null ? Number(r.level_success_count) : null,
      targetCount:
        r.level_target_count != null ? Number(r.level_target_count) : null,
    })),
  };
}

async function listLevelsByMobile(mobile) {
  if (mobile == null || String(mobile).trim() === '') return [];
  const rows = await db.query(
    `SELECT * FROM account_seckill_levels WHERE mobile = ? ORDER BY vip_level ASC`,
    [String(mobile)]
  );
  return rows.map(rowToLevel).sort((a, b) => levelRank(a.vipLevel) - levelRank(b.vipLevel));
}

async function listLevelsByAccountId(accountId) {
  const rows = await db.query(
    `SELECT * FROM account_seckill_levels WHERE account_id = ? ORDER BY vip_level ASC`,
    [Number(accountId)]
  );
  return rows.map(rowToLevel).sort((a, b) => levelRank(a.vipLevel) - levelRank(b.vipLevel));
}

/**
 * 合并同账号下相同 vip_level 的重复行（手机号变更时易出现：唯一键是 mobile+level）
 * 保留 success_count 更高 / id 更大的一条，并同步 mobile
 */
async function dedupeLevelsForAccount(accountId, preferredMobile) {
  const id = Number(accountId);
  if (!Number.isFinite(id) || id < 1) return 0;
  const rows = await db.query(
    `SELECT * FROM account_seckill_levels WHERE account_id = ? ORDER BY id ASC`,
    [id]
  );
  if (!rows.length) return 0;

  const mobile =
    preferredMobile != null && String(preferredMobile).trim()
      ? String(preferredMobile).trim()
      : null;

  const keepByLevel = new Map();
  const deleteIds = [];
  for (const row of rows) {
    const key = normalizeVipLevel(row.vip_level) || String(row.vip_level);
    const prev = keepByLevel.get(key);
    if (!prev) {
      keepByLevel.set(key, {
        id: row.id,
        successCount: Number(row.success_count) || 0,
        targetCount: normalizeTargetCount(row.target_count),
        lastSuccessAt: row.last_success_at || null,
      });
      continue;
    }
    const curScore = Number(row.success_count) || 0;
    const preferCur =
      curScore > prev.successCount ||
      (curScore === prev.successCount && Number(row.id) > Number(prev.id));
    if (preferCur) {
      deleteIds.push(prev.id);
      keepByLevel.set(key, {
        id: row.id,
        successCount: Math.max(curScore, prev.successCount),
        targetCount: Math.max(normalizeTargetCount(row.target_count), prev.targetCount),
        lastSuccessAt: row.last_success_at || prev.lastSuccessAt,
      });
    } else {
      deleteIds.push(row.id);
      prev.successCount = Math.max(prev.successCount, curScore);
      prev.targetCount = Math.max(prev.targetCount, normalizeTargetCount(row.target_count));
      if (!prev.lastSuccessAt && row.last_success_at) prev.lastSuccessAt = row.last_success_at;
    }
  }

  for (const delId of deleteIds) {
    await db.query(`DELETE FROM account_seckill_levels WHERE id = ?`, [delId]);
  }

  for (const keep of keepByLevel.values()) {
    const orig = rows.find((r) => r.id === keep.id);
    if (!orig) continue;
    const fields = [];
    const params = [];
    if (mobile && String(orig.mobile) !== mobile) {
      fields.push('mobile = ?');
      params.push(mobile);
    }
    if ((Number(orig.success_count) || 0) !== keep.successCount) {
      fields.push('success_count = ?');
      params.push(keep.successCount);
    }
    if (normalizeTargetCount(orig.target_count) !== keep.targetCount) {
      fields.push('target_count = ?');
      params.push(keep.targetCount);
    }
    if (fields.length) {
      params.push(keep.id);
      await db
        .query(`UPDATE account_seckill_levels SET ${fields.join(', ')} WHERE id = ?`, params)
        .catch(() => {});
    }
  }

  return deleteIds.length;
}

async function attachLevels(user) {
  if (!user) return null;
  try {
    let levels = [];
    if (user.id) levels = await listLevelsByAccountId(user.id);
    // 同账号同等级多行时自动合并（手机号变更遗留）
    if (user.id && levels.length > 1) {
      const keys = levels.map((l) => normalizeVipLevel(l.vipLevel) || l.vipLevel);
      if (new Set(keys).size < keys.length) {
        const preferred = levelMobileKey(user.mobile, user.id);
        await dedupeLevelsForAccount(user.id, preferred).catch(() => {});
        levels = await listLevelsByAccountId(user.id);
      }
    }
    if (!levels.length && user.mobile) levels = await listLevelsByMobile(user.mobile);
    // 无手机号时等级表可能用 #id 占位
    if (!levels.length && user.id) {
      levels = await listLevelsByMobile(`#${user.id}`);
    }
    user.levels = levels;
  } catch (e) {
    user.levels = [];
  }
  if (!user.levels.length) {
    user.levels = [
      {
        id: null,
        accountId: user.id,
        mobile: user.mobile,
        vipLevel: user.vipLevel || 'V1',
        successCount: user.successCount || 0,
        targetCount: user.targetCount || 1,
        completed: (user.successCount || 0) >= (user.targetCount || 1),
      },
    ];
  }
  return user;
}

async function upsertAccount(user) {
  await ensureMobileNullable();

  // 先按 god_uuid / uid 找已有账号，便于保留原 mock 号
  let existing = null;
  if (user.godUuid) {
    const rows = await db.query(
      'SELECT * FROM accounts WHERE god_uuid = ? ORDER BY id DESC LIMIT 1',
      [user.godUuid]
    );
    existing = rows[0] || null;
  }
  if (!existing && user.uid) {
    const rows = await db.query(
      'SELECT * FROM accounts WHERE uid = ? ORDER BY id DESC LIMIT 1',
      [user.uid]
    );
    existing = rows[0] || null;
  }
  if (!existing && isRealMobile(user.mobile)) {
    const rows = await db.query('SELECT * FROM accounts WHERE mobile = ? LIMIT 1', [
      String(user.mobile).trim(),
    ]);
    existing = rows[0] || null;
  }

  const mobileValue = await resolveAccountMobile(user, existing);

  const targetCount = normalizeTargetCount(user.targetCount);
  const vipTrusted = user.vipLevelTrusted === true;
  const vipLevel = vipTrusted
    ? normalizeVipLevel(user.vipLevel) || 'V1'
    : normalizeVipLevel(user.vipLevel) || 'V1';
  const buyerNickname = normalizeBuyerNickname(user.buyerNickname);
  const actAccount =
    user.actAccount != null && String(user.actAccount).trim()
      ? String(user.actAccount).trim().slice(0, 128)
      : null;

  const payload = {
    nickname: user.nickname || null,
    buyerNickname,
    actAccount,
    vipLevel,
    vipTrusted,
    uid: user.uid || null,
    godUuid: user.godUuid || null,
    deviceId: user.deviceId || null,
    cookiesJson: JSON.stringify(user.cookies || []),
    cookieHeader: user.cookieHeader || null,
    vipRaw: user.vipRaw ? JSON.stringify(user.vipRaw) : null,
    selfRaw: user.selfRaw ? JSON.stringify(user.selfRaw) : null,
    targetCount,
    loggedInAt: user.loggedInAt ? new Date(user.loggedInAt) : new Date(),
  };

  // 已有行但主键手机号不同（例如原先 NULL/旧号 → mock）：按 id 更新并改写 mobile
  if (existing && String(existing.mobile || '') !== String(mobileValue)) {
    await db.query(
      `UPDATE accounts SET
        mobile = ?,
        nickname = ?,
        buyer_nickname = COALESCE(?, buyer_nickname),
        act_account = COALESCE(?, act_account),
        vip_level = IF(?, ?, vip_level),
        uid = COALESCE(?, uid),
        god_uuid = COALESCE(?, god_uuid),
        device_id = COALESCE(?, device_id),
        cookies_json = ?,
        cookie_header = ?,
        vip_raw = IF(?, ?, vip_raw),
        self_raw = ?,
        status = 1,
        target_count = ?,
        logged_in_at = ?
      WHERE id = ?`,
      [
        mobileValue,
        payload.nickname,
        payload.buyerNickname,
        payload.actAccount,
        payload.vipTrusted ? 1 : 0,
        payload.vipLevel,
        payload.uid,
        payload.godUuid,
        payload.deviceId,
        payload.cookiesJson,
        payload.cookieHeader,
        payload.vipTrusted ? 1 : 0,
        payload.vipRaw,
        payload.selfRaw,
        payload.targetCount,
        payload.loggedInAt,
        existing.id,
      ]
    );
    // 同步等级表 mobile 占位
    await db
      .query(`UPDATE account_seckill_levels SET mobile = ? WHERE account_id = ?`, [
        mobileValue,
        existing.id,
      ])
      .catch(() => {});
  } else {
    const sql = `
      INSERT INTO accounts (
        mobile, nickname, buyer_nickname, act_account, vip_level, uid, god_uuid, device_id,
        cookies_json, cookie_header, vip_raw, self_raw, status, target_count, logged_in_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      ON DUPLICATE KEY UPDATE
        nickname = VALUES(nickname),
        buyer_nickname = COALESCE(VALUES(buyer_nickname), buyer_nickname),
        act_account = COALESCE(VALUES(act_account), act_account),
        vip_level = IF(?, VALUES(vip_level), vip_level),
        uid = VALUES(uid),
        god_uuid = VALUES(god_uuid),
        device_id = VALUES(device_id),
        cookies_json = VALUES(cookies_json),
        cookie_header = VALUES(cookie_header),
        vip_raw = IF(?, VALUES(vip_raw), vip_raw),
        self_raw = VALUES(self_raw),
        status = 1,
        target_count = VALUES(target_count),
        logged_in_at = VALUES(logged_in_at)
    `;
    await db.query(sql, [
      mobileValue,
      payload.nickname,
      payload.buyerNickname,
      payload.actAccount,
      payload.vipLevel,
      payload.uid,
      payload.godUuid,
      payload.deviceId,
      payload.cookiesJson,
      payload.cookieHeader,
      payload.vipRaw,
      payload.selfRaw,
      payload.targetCount,
      payload.loggedInAt,
      payload.vipTrusted ? 1 : 0,
      payload.vipTrusted ? 1 : 0,
    ]);
  }

  const saved = await findByMobileRaw(mobileValue);
  if (saved) {
    const levelMobile = levelMobileKey(saved.mobile, saved.id);
    const existingLevels = await listLevelsByAccountId(saved.id);
    if (payload.vipTrusted || !existingLevels.length) {
      await ensureSeckillLevel({
        accountId: saved.id,
        mobile: levelMobile,
        vipLevel: saved.vipLevel || payload.vipLevel,
        targetCount,
        syncTarget: !!payload.vipTrusted,
      });
    }
  }
  return attachLevels(saved);
}

/** 等级表 mobile 非空：优先用账号手机号（含 mock-）；否则 #accountId */
function levelMobileKey(mobile, accountId) {
  if (isUsableMobile(mobile)) return String(mobile).trim();
  if (mobile != null && String(mobile).trim()) return String(mobile).trim();
  return `#${accountId}`;
}

async function findByIdRaw(id) {
  const rows = await db.query('SELECT * FROM accounts WHERE id = ? LIMIT 1', [Number(id)]);
  return rowToUser(rows[0]);
}

async function findByMobileRaw(mobile) {
  const rows = await db.query('SELECT * FROM accounts WHERE mobile = ? LIMIT 1', [
    String(mobile),
  ]);
  return rowToUser(rows[0]);
}

let mobileNullableEnsured = false;
async function ensureMobileNullable() {
  if (mobileNullableEnsured) return;
  try {
    await db.query(
      `ALTER TABLE accounts MODIFY COLUMN mobile VARCHAR(32) NULL COMMENT '手机号；无绑定时为 mock-1xxxxxxxxxx'`
    );
  } catch (e) {
    // ignore
  }
  await backfillMockMobiles().catch(() => {});
  mobileNullableEnsured = true;
}

/** 将历史空手机号补成 mock 虚拟号 */
async function backfillMockMobiles() {
  const rows = await db.query(
    `SELECT id, god_uuid, uid, act_account FROM accounts WHERE mobile IS NULL OR mobile = ''`
  );
  for (const row of rows) {
    const mock = await allocateMockMobile(
      row.god_uuid || row.uid || row.act_account || `id-${row.id}`
    );
    await db.query(`UPDATE accounts SET mobile = ? WHERE id = ?`, [mock, row.id]);
    await db
      .query(`UPDATE account_seckill_levels SET mobile = ? WHERE account_id = ?`, [
        mock,
        row.id,
      ])
      .catch(() => {});
    console.log(`[accountRepo] 空手机号补虚拟号 id=${row.id} → ${mock}`);
  }
}

async function ensureSeckillLevel({
  accountId,
  mobile,
  vipLevel,
  targetCount = 1,
  syncTarget = false,
}) {
  const level = normalizeVipLevel(vipLevel);
  if (!level) throw new Error('无效的会员等级');
  const target = normalizeTargetCount(targetCount);
  const aid = Number(accountId);
  const mob = String(mobile);

  // 先按账号去重，避免同账号同等级多行（不同 mobile）
  await dedupeLevelsForAccount(aid, mob).catch(() => {});

  const byAccount = await db.query(
    `SELECT * FROM account_seckill_levels WHERE account_id = ? AND vip_level = ? ORDER BY id DESC`,
    [aid, level]
  );
  if (byAccount.length) {
    const keep = byAccount[0];
    for (const extra of byAccount.slice(1)) {
      await db.query(`DELETE FROM account_seckill_levels WHERE id = ?`, [extra.id]);
    }
    const fields = ['mobile = ?', 'account_id = ?'];
    const params = [mob, aid];
    if (syncTarget) {
      fields.push('target_count = ?');
      params.push(target);
    }
    params.push(keep.id);
    await db.query(
      `UPDATE account_seckill_levels SET ${fields.join(', ')} WHERE id = ?`,
      params
    );
    const rows = await db.query(`SELECT * FROM account_seckill_levels WHERE id = ? LIMIT 1`, [
      keep.id,
    ]);
    return rowToLevel(rows[0]);
  }

  if (syncTarget) {
    await db.query(
      `INSERT INTO account_seckill_levels (account_id, mobile, vip_level, target_count, success_count)
       VALUES (?, ?, ?, ?, 0)
       ON DUPLICATE KEY UPDATE
         account_id = VALUES(account_id),
         target_count = VALUES(target_count)`,
      [aid, mob, level, target]
    );
  } else {
    await db.query(
      `INSERT INTO account_seckill_levels (account_id, mobile, vip_level, target_count, success_count)
       VALUES (?, ?, ?, ?, 0)
       ON DUPLICATE KEY UPDATE account_id = VALUES(account_id)`,
      [aid, mob, level, target]
    );
  }
  const rows = await db.query(
    `SELECT * FROM account_seckill_levels WHERE (account_id = ? OR mobile = ?) AND vip_level = ?
     ORDER BY account_id = ? DESC, id DESC LIMIT 1`,
    [aid, mob, level, aid]
  );
  return rowToLevel(rows[0]);
}

async function addSeckillLevel(accountId, { vipLevel, targetCount } = {}) {
  const account = await findById(accountId);
  if (!account) throw new Error('账号不存在');
  const level = normalizeVipLevel(vipLevel);
  if (!level) throw new Error('请填写有效等级，如 V5');
  const maxRank = levelRank(account.vipLevel);
  if (maxRank > 0 && levelRank(level) > maxRank) {
    throw new Error(`不能超过账号最大档位 ${account.vipLevel}`);
  }
  await dedupeLevelsForAccount(account.id, levelMobileKey(account.mobile, account.id)).catch(
    () => {}
  );
  const existing = await db.query(
    `SELECT id FROM account_seckill_levels WHERE account_id = ? AND vip_level = ? LIMIT 1`,
    [account.id, level]
  );
  if (existing.length) throw new Error(`该账号已存在抢购等级 ${level}`);
  return ensureSeckillLevel({
    accountId: account.id,
    mobile: levelMobileKey(account.mobile, account.id),
    vipLevel: level,
    targetCount: targetCount != null ? targetCount : 1,
    syncTarget: true,
  });
}

async function updateSeckillLevel(levelId, patch = {}) {
  const rows = await db.query(`SELECT * FROM account_seckill_levels WHERE id = ? LIMIT 1`, [
    Number(levelId),
  ]);
  const row = rows[0];
  if (!row) return null;
  const fields = [];
  const params = [];
  if (patch.targetCount != null) {
    fields.push('target_count = ?');
    params.push(normalizeTargetCount(patch.targetCount));
  }
  if (patch.successCount != null) {
    fields.push('success_count = ?');
    params.push(Math.max(0, Math.floor(Number(patch.successCount) || 0)));
  }
  if (patch.resetSuccess) {
    fields.push('success_count = ?');
    params.push(0);
  }
  if (!fields.length) return rowToLevel(row);
  params.push(Number(levelId));
  await db.query(`UPDATE account_seckill_levels SET ${fields.join(', ')} WHERE id = ?`, params);
  const updated = await db.query(`SELECT * FROM account_seckill_levels WHERE id = ? LIMIT 1`, [
    Number(levelId),
  ]);
  return rowToLevel(updated[0]);
}

async function deleteSeckillLevel(levelId) {
  const rows = await db.query(`SELECT * FROM account_seckill_levels WHERE id = ? LIMIT 1`, [
    Number(levelId),
  ]);
  const row = rows[0];
  if (!row) return null;

  // 按账号统计（不要只按 mobile：同账号可能有不同 mobile 的重复等级行）
  let levels = [];
  if (row.account_id) {
    levels = await listLevelsByAccountId(row.account_id);
  }
  if (!levels.length) {
    levels = await listLevelsByMobile(row.mobile);
  }

  const sameVip = levels.filter(
    (l) => normalizeVipLevel(l.vipLevel) === normalizeVipLevel(row.vip_level)
  );
  // 同等级重复行：允许直接删多余的
  if (sameVip.length > 1) {
    await db.query(`DELETE FROM account_seckill_levels WHERE id = ?`, [Number(levelId)]);
    return rowToLevel(row);
  }
  if (levels.length <= 1) {
    throw new Error('至少保留一个抢购等级');
  }
  await db.query(`DELETE FROM account_seckill_levels WHERE id = ?`, [Number(levelId)]);
  return rowToLevel(row);
}

async function findByMobile(mobile) {
  return attachLevels(await findByMobileRaw(mobile));
}

async function listActiveAccounts() {
  await ensureMobileNullable();
  await ensureSuccessLogSchema();
  const rows = await db.query(
    'SELECT * FROM accounts WHERE status = 1 ORDER BY updated_at DESC'
  );
  const users = rows.map(rowToUser);
  for (const u of users) await attachLevels(u);
  await attachTodaySuccessCounts(users);
  return users;
}

async function listAllAccounts() {
  await ensureMobileNullable();
  await ensureSuccessLogSchema();
  const rows = await db.query('SELECT * FROM accounts ORDER BY updated_at DESC');
  const users = rows.map(rowToUser);
  for (const u of users) await attachLevels(u);
  await attachTodaySuccessCounts(users);
  return users;
}

async function findById(id) {
  const rows = await db.query('SELECT * FROM accounts WHERE id = ? LIMIT 1', [Number(id)]);
  return attachLevels(rowToUser(rows[0]));
}

async function updateAccount(id, patch = {}) {
  const fields = [];
  const params = [];
  if (patch.targetCount != null) {
    fields.push('target_count = ?');
    params.push(normalizeTargetCount(patch.targetCount));
  }
  if (patch.status != null) {
    fields.push('status = ?');
    params.push(Number(patch.status) ? 1 : 0);
  }
  if (patch.successCount != null) {
    const n = Math.max(0, Math.floor(Number(patch.successCount) || 0));
    fields.push('success_count = ?');
    params.push(n);
  }
  if (patch.nickname !== undefined) {
    fields.push('nickname = ?');
    params.push(patch.nickname ? String(patch.nickname) : null);
  }
  if (patch.buyerNickname !== undefined) {
    fields.push('buyer_nickname = ?');
    params.push(normalizeBuyerNickname(patch.buyerNickname));
  }
  if (!fields.length) return findById(id);
  params.push(Number(id));
  await db.query(`UPDATE accounts SET ${fields.join(', ')} WHERE id = ?`, params);
  return findById(id);
}

async function deleteAccount(id) {
  const existing = await findById(id);
  if (!existing) return null;
  await db.query('DELETE FROM account_seckill_levels WHERE account_id = ? OR mobile = ?', [
    Number(id),
    existing.mobile,
  ]);
  await db.query('DELETE FROM accounts WHERE id = ?', [Number(id)]);
  return existing;
}

async function deleteAccountByMobile(mobile) {
  const existing = await findByMobile(mobile);
  if (!existing) return null;
  await db.query('DELETE FROM account_seckill_levels WHERE mobile = ?', [String(mobile)]);
  await db.query('DELETE FROM accounts WHERE mobile = ?', [String(mobile)]);
  return existing;
}

function toPublicAccount(user) {
  if (!user) return null;
  const levels = (user.levels || []).map((l) => ({
    id: l.id,
    vipLevel: l.vipLevel,
    successCount: l.successCount || 0,
    targetCount: l.targetCount || 1,
    completed: !!l.completed,
    lastSuccessAt: l.lastSuccessAt || null,
  }));
  const activeLevels = levels.filter((l) => !l.completed);
  return {
    id: user.id,
    mobile: user.mobile,
    isMockMobile: isMockMobile(user.mobile),
    nickname: user.nickname,
    buyerNickname: user.buyerNickname || null,
    actAccount: user.actAccount || null,
    vipLevel: user.vipLevel,
    uid: user.uid,
    status: user.status,
    successCount: user.successCount || 0,
    targetCount: user.targetCount || 1,
    todaySuccessCount: Number(user.todaySuccessCount) || 0,
    todaySuspectedCount: Number(user.todaySuspectedCount) || 0,
    todayWelfareCount: Number(user.todayWelfareCount) || 0,
    lastSuccessAt: user.lastSuccessAt || null,
    completed:
      levels.length > 0
        ? activeLevels.length === 0
        : (user.successCount || 0) >= (user.targetCount || 1),
    levels,
    loggedInAt: user.loggedInAt,
    updatedAt: user.updatedAt,
  };
}

async function createLoginSession({ token, expiresAt, targetCount, buyerNickname }) {
  await db.query(
    `INSERT INTO login_sessions (token, status, target_count, buyer_nickname, expires_at) VALUES (?, 'pending', ?, ?, ?)`,
    [
      token,
      normalizeTargetCount(targetCount),
      normalizeBuyerNickname(buyerNickname),
      expiresAt,
    ]
  );
  return findLoginSession(token);
}

async function findLoginSession(token) {
  const rows = await db.query('SELECT * FROM login_sessions WHERE token = ? LIMIT 1', [
    token,
  ]);
  return rows[0] || null;
}

async function updateLoginSession(token, patch) {
  const fields = [];
  const params = [];
  for (const [k, v] of Object.entries(patch)) {
    fields.push(`${k} = ?`);
    params.push(v);
  }
  if (!fields.length) return findLoginSession(token);
  params.push(token);
  await db.query(`UPDATE login_sessions SET ${fields.join(', ')} WHERE token = ?`, params);
  return findLoginSession(token);
}

function cookiesToMap(cookies, cookieHeader) {
  const map = {};
  for (const c of cookies || []) {
    if (!c || !c.name || c.value == null || c.value === '') continue;
    map[c.name] = String(c.value);
  }
  if (cookieHeader) {
    for (const part of String(cookieHeader).split(';')) {
      const idx = part.indexOf('=');
      if (idx <= 0) continue;
      const name = part.slice(0, idx).trim();
      const value = part.slice(idx + 1).trim();
      if (!name || map[name]) continue;
      map[name] = value;
    }
  }
  return map;
}

/**
 * 用库内 Cookie 重新拉取 get-info / actInfo，同步最大档位、账户名称等
 */
async function syncAccountProfile(accountId) {
  const existing = await findById(accountId);
  if (!existing) throw new Error('账号不存在');

  const cookieMap = cookiesToMap(existing.cookies, existing.cookieHeader);
  if (!Object.keys(cookieMap).length) {
    throw new Error('账号无可用 Cookie，请重新登录或 Curl 导入');
  }

  const { createSession } = require('./http');
  const { LoginService } = require('./loginService');
  const session = createSession();
  const svc = new LoginService(session);
  if (existing.deviceId) {
    svc.deviceId = existing.deviceId;
    session.client.defaults.headers.common['GL-DeviceId'] = existing.deviceId;
  }
  const bootstrapMobile =
    isRealMobile(existing.mobile) || isMockMobile(existing.mobile)
      ? String(existing.mobile)
      : '00000000000';

  const result = await svc.importCookies(bootstrapMobile, cookieMap, {
    headers: existing.godUuid ? { 'gl-uid': existing.godUuid } : {},
  });
  const profile = result.user || {};
  if (!profile.vipLevelTrusted) {
    throw new Error(
      `等级同步失败：get-info 未返回 currentLv（会话可能失效，请重新登录）`
    );
  }

  const vipLevel = normalizeVipLevel(profile.vipLevel) || existing.vipLevel || 'V1';
  const actAccount =
    profile.actAccount != null && String(profile.actAccount).trim()
      ? String(profile.actAccount).trim().slice(0, 128)
      : null;

  await db.query(
    `UPDATE accounts SET
      nickname = COALESCE(?, nickname),
      act_account = COALESCE(?, act_account),
      vip_level = ?,
      uid = COALESCE(?, uid),
      god_uuid = COALESCE(?, god_uuid),
      device_id = COALESCE(?, device_id),
      cookies_json = ?,
      cookie_header = ?,
      vip_raw = ?,
      self_raw = ?,
      status = 1
    WHERE id = ?`,
    [
      profile.nickname || null,
      actAccount,
      vipLevel,
      profile.uid || null,
      profile.godUuid || existing.godUuid || null,
      profile.deviceId || existing.deviceId || null,
      JSON.stringify(profile.cookies || existing.cookies || []),
      profile.cookieHeader || existing.cookieHeader || null,
      profile.vipRaw ? JSON.stringify(profile.vipRaw) : null,
      profile.selfRaw ? JSON.stringify(profile.selfRaw) : null,
      Number(accountId),
    ]
  );

  // 确保最大档对应抢购等级存在（不改已有 target/success）
  const after = await findByIdRaw(accountId);
  let mobileForLevel = after && after.mobile;
  if (!isUsableMobile(mobileForLevel)) {
    mobileForLevel = await allocateMockMobile(
      (after && (after.godUuid || after.uid)) || `id-${accountId}`
    );
    await db.query(`UPDATE accounts SET mobile = ? WHERE id = ?`, [
      mobileForLevel,
      Number(accountId),
    ]);
  }
  const levelMobile = levelMobileKey(mobileForLevel, existing.id);
  await ensureSeckillLevel({
    accountId: existing.id,
    mobile: levelMobile,
    vipLevel,
    targetCount: existing.targetCount || 1,
    syncTarget: false,
  });

  return attachLevels(await findByIdRaw(accountId));
}

/**
 * 用库内 Cookie 调 actInfo，判断账号是否在线
 * 在线依据：result 含 actAccount 或 uid
 */
async function checkAccountOnline(accountId) {
  const existing = await findById(accountId);
  if (!existing) {
    return {
      id: Number(accountId),
      mobile: null,
      online: false,
      actAccount: null,
      message: '账号不存在',
    };
  }

  const base = {
    id: existing.id,
    mobile: existing.mobile,
    buyerNickname: existing.buyerNickname || null,
    actAccount: existing.actAccount || null,
  };

  const cookieMap = cookiesToMap(existing.cookies, existing.cookieHeader);
  if (!Object.keys(cookieMap).length) {
    return { ...base, online: false, message: '无 Cookie' };
  }

  const C = require('./constants');
  const { createSession, applyCookieMap, ensureXsrf } = require('./http');
  const session = createSession();
  if (existing.deviceId) {
    session.deviceId = existing.deviceId;
    session.client.defaults.headers.common['GL-DeviceId'] = existing.deviceId;
  }
  applyCookieMap(session.jar, cookieMap);
  if (existing.godUuid) {
    session.client.defaults.headers.common['gl-uid'] = existing.godUuid;
    session.client.defaults.headers.common['GL-Uid'] = existing.godUuid;
  }

  try {
    await ensureXsrf(session.client, session.jar);
    await session.client.get(`${C.PAY_API}/api/nlogin`, { params: {} }).catch(() => {});
    try {
      await session.client.get(`${C.INF}/v1/web/cooperate/plutus/cookie-exchange`);
    } catch (_) {}
    await ensureXsrf(session.client, session.jar);

    const actRes = await session.client.post(`${C.INF_ACT}/v1/act-web/module/common/actInfo`, {
      actId: C.ACT_ID,
    });
    const data = actRes.data || {};
    const code = data.code != null ? Number(data.code) : NaN;
    if (Number.isFinite(code) && code !== 200 && code !== 0) {
      return {
        ...base,
        online: false,
        message: `actInfo code=${code} ${data.errmsg || data.msg || ''}`.trim(),
      };
    }
    const result = data.result || data.data || {};
    const actAccount =
      result.actAccount ||
      result.account ||
      (result.user && result.user.actAccount) ||
      null;
    const uid = result.uid || (result.user && result.user.uid) || null;
    const online = !!(actAccount || uid);

    if (online && actAccount && String(actAccount).trim()) {
      await db
        .query(`UPDATE accounts SET act_account = COALESCE(?, act_account) WHERE id = ?`, [
          String(actAccount).trim().slice(0, 128),
          existing.id,
        ])
        .catch(() => {});
    }

    return {
      ...base,
      online,
      actAccount: actAccount ? String(actAccount) : base.actAccount,
      message: online ? '在线' : '离线（actInfo 未返回登录身份）',
    };
  } catch (e) {
    return {
      ...base,
      online: false,
      message: e.message || String(e),
    };
  }
}

/** 是否「全部完成」（与管理页「可用」筛选一致：有未完成抢购档位才需验证） */
function isAccountCompleted(user) {
  if (!user) return true;
  const levels = user.levels || [];
  if (levels.length > 0) {
    return levels.every((l) => l.completed);
  }
  return (user.successCount || 0) >= (user.targetCount || 1);
}

/** 批量验证可用账号在线情况（跳过已全部完成，顺序请求） */
async function checkAllAccountsOnline({ onProgress } = {}) {
  const all = await listAllAccounts();
  const list = all.filter((acc) => !isAccountCompleted(acc));
  const skipped = all.length - list.length;
  const results = [];
  let online = 0;
  let offline = 0;
  for (let i = 0; i < list.length; i++) {
    const acc = list[i];
    const r = await checkAccountOnline(acc.id);
    if (r.online) online += 1;
    else offline += 1;
    results.push(r);
    if (typeof onProgress === 'function') {
      try {
        onProgress({ index: i + 1, total: list.length, result: r });
      } catch (_) {}
    }
  }
  return {
    total: list.length,
    skipped,
    online,
    offline,
    results,
  };
}

module.exports = {
  upsertAccount,
  findByMobile,
  findById,
  listActiveAccounts,
  listAllAccounts,
  listSuccessLogs,
  chinaDayRange,
  ensureSuccessLogSchema,
  updateAccount,
  deleteAccount,
  deleteAccountByMobile,
  syncAccountProfile,
  checkAccountOnline,
  checkAllAccountsOnline,
  allocateMockMobile,
  buildMockMobileFromSeed,
  isRealMobile,
  isMockMobile,
  isUsableMobile,
  toPublicAccount,
  createLoginSession,
  findLoginSession,
  updateLoginSession,
  rowToUser,
  normalizeTargetCount,
  normalizeBuyerNickname,
  normalizeVipLevel,
  levelRank,
  listLevelsByMobile,
  ensureSeckillLevel,
  addSeckillLevel,
  updateSeckillLevel,
  deleteSeckillLevel,
  attachLevels,
};
