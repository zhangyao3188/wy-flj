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
    loggedInAt: row.logged_in_at,
    updatedAt: row.updated_at,
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

async function attachLevels(user) {
  if (!user) return null;
  try {
    let levels = [];
    if (user.id) levels = await listLevelsByAccountId(user.id);
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
  const rawMobile =
    user.mobile != null && String(user.mobile).trim() && String(user.mobile).trim() !== '00000000000'
      ? String(user.mobile).trim()
      : null;
  // 仅写入合法手机号；解析不到则留空（NULL）
  const mobileValue = rawMobile && /^1\d{10}$/.test(rawMobile) ? rawMobile : null;

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

  let saved = null;
  if (mobileValue) {
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
    saved = await findByMobileRaw(mobileValue);
  } else {
    // 手机号留空：按 god_uuid / uid 更新已有行，否则新建（mobile=NULL）
    let existing = null;
    if (payload.godUuid) {
      const rows = await db.query(
        'SELECT * FROM accounts WHERE god_uuid = ? ORDER BY id DESC LIMIT 1',
        [payload.godUuid]
      );
      existing = rows[0] || null;
    }
    if (!existing && payload.uid) {
      const rows = await db.query(
        'SELECT * FROM accounts WHERE uid = ? ORDER BY id DESC LIMIT 1',
        [payload.uid]
      );
      existing = rows[0] || null;
    }
    if (existing) {
      await db.query(
        `UPDATE accounts SET
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
      saved = await findByIdRaw(existing.id);
    } else {
      await db.query(
        `INSERT INTO accounts (
          mobile, nickname, buyer_nickname, act_account, vip_level, uid, god_uuid, device_id,
          cookies_json, cookie_header, vip_raw, self_raw, status, target_count, logged_in_at
        ) VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        [
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
        ]
      );
      if (payload.godUuid) {
        const rows = await db.query(
          'SELECT * FROM accounts WHERE god_uuid = ? ORDER BY id DESC LIMIT 1',
          [payload.godUuid]
        );
        saved = rowToUser(rows[0]);
      } else if (payload.uid) {
        const rows = await db.query(
          'SELECT * FROM accounts WHERE uid = ? ORDER BY id DESC LIMIT 1',
          [payload.uid]
        );
        saved = rowToUser(rows[0]);
      }
    }
  }

  if (saved) {
    const levelMobile = levelMobileKey(saved.mobile, saved.id);
    // 等级不可信时：若已有抢购等级则不写入假 V1；仅新建账号无等级时才建一条
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

/** 等级表 mobile 非空：无手机号时用 #accountId 占位，保证唯一 */
function levelMobileKey(mobile, accountId) {
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
      `ALTER TABLE accounts MODIFY COLUMN mobile VARCHAR(20) NULL COMMENT '手机号（可空，curl 导入解析不到时留空）'`
    );
  } catch (e) {
    // ignore
  }
  mobileNullableEnsured = true;
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
  if (syncTarget) {
    await db.query(
      `INSERT INTO account_seckill_levels (account_id, mobile, vip_level, target_count, success_count)
       VALUES (?, ?, ?, ?, 0)
       ON DUPLICATE KEY UPDATE
         account_id = VALUES(account_id),
         target_count = VALUES(target_count)`,
      [Number(accountId), String(mobile), level, target]
    );
  } else {
    await db.query(
      `INSERT INTO account_seckill_levels (account_id, mobile, vip_level, target_count, success_count)
       VALUES (?, ?, ?, ?, 0)
       ON DUPLICATE KEY UPDATE account_id = VALUES(account_id)`,
      [Number(accountId), String(mobile), level, target]
    );
  }
  const rows = await db.query(
    `SELECT * FROM account_seckill_levels WHERE mobile = ? AND vip_level = ? LIMIT 1`,
    [String(mobile), level]
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
  const existing = await db.query(
    `SELECT id FROM account_seckill_levels WHERE mobile = ? AND vip_level = ? LIMIT 1`,
    [account.mobile, level]
  );
  if (existing.length) throw new Error(`该账号已存在抢购等级 ${level}`);
  return ensureSeckillLevel({
    accountId: account.id,
    mobile: account.mobile,
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
  const levels = await listLevelsByMobile(row.mobile);
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
  const rows = await db.query(
    'SELECT * FROM accounts WHERE status = 1 ORDER BY updated_at DESC'
  );
  const users = rows.map(rowToUser);
  for (const u of users) await attachLevels(u);
  return users;
}

async function listAllAccounts() {
  const rows = await db.query('SELECT * FROM accounts ORDER BY updated_at DESC');
  const users = rows.map(rowToUser);
  for (const u of users) await attachLevels(u);
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
  }));
  const activeLevels = levels.filter((l) => !l.completed);
  return {
    id: user.id,
    mobile: user.mobile,
    nickname: user.nickname,
    buyerNickname: user.buyerNickname || null,
    actAccount: user.actAccount || null,
    vipLevel: user.vipLevel,
    uid: user.uid,
    status: user.status,
    successCount: user.successCount || 0,
    targetCount: user.targetCount || 1,
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

module.exports = {
  upsertAccount,
  findByMobile,
  findById,
  listActiveAccounts,
  listAllAccounts,
  updateAccount,
  deleteAccount,
  deleteAccountByMobile,
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
