const db = require('./db');

function normalizeTargetCount(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(Math.floor(n), 9999);
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
    loggedInAt: row.logged_in_at,
    updatedAt: row.updated_at,
  };
}

async function upsertAccount(user) {
  const mobile = String(user.mobile);
  const targetCount = normalizeTargetCount(user.targetCount);
  const sql = `
    INSERT INTO accounts (
      mobile, nickname, vip_level, uid, god_uuid, device_id,
      cookies_json, cookie_header, vip_raw, self_raw, status, target_count, logged_in_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    ON DUPLICATE KEY UPDATE
      nickname = VALUES(nickname),
      vip_level = VALUES(vip_level),
      uid = VALUES(uid),
      god_uuid = VALUES(god_uuid),
      device_id = VALUES(device_id),
      cookies_json = VALUES(cookies_json),
      cookie_header = VALUES(cookie_header),
      vip_raw = VALUES(vip_raw),
      self_raw = VALUES(self_raw),
      status = 1,
      target_count = VALUES(target_count),
      logged_in_at = VALUES(logged_in_at)
  `;
  await db.query(sql, [
    mobile,
    user.nickname || null,
    user.vipLevel || 'V1',
    user.uid || null,
    user.godUuid || null,
    user.deviceId || null,
    JSON.stringify(user.cookies || []),
    user.cookieHeader || null,
    user.vipRaw ? JSON.stringify(user.vipRaw) : null,
    user.selfRaw ? JSON.stringify(user.selfRaw) : null,
    targetCount,
    user.loggedInAt ? new Date(user.loggedInAt) : new Date(),
  ]);
  return findByMobile(mobile);
}

async function findByMobile(mobile) {
  const rows = await db.query('SELECT * FROM accounts WHERE mobile = ? LIMIT 1', [
    String(mobile),
  ]);
  return rowToUser(rows[0]);
}

async function listActiveAccounts() {
  const rows = await db.query(
    'SELECT * FROM accounts WHERE status = 1 ORDER BY updated_at DESC'
  );
  return rows.map(rowToUser);
}

/** 全部账号（含停用） */
async function listAllAccounts() {
  const rows = await db.query('SELECT * FROM accounts ORDER BY updated_at DESC');
  return rows.map(rowToUser);
}

async function findById(id) {
  const rows = await db.query('SELECT * FROM accounts WHERE id = ? LIMIT 1', [Number(id)]);
  return rowToUser(rows[0]);
}

/**
 * 更新管理字段：targetCount / status / successCount / nickname
 */
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
  if (!fields.length) return findById(id);
  params.push(Number(id));
  await db.query(`UPDATE accounts SET ${fields.join(', ')} WHERE id = ?`, params);
  return findById(id);
}

async function deleteAccount(id) {
  const existing = await findById(id);
  if (!existing) return null;
  await db.query('DELETE FROM accounts WHERE id = ?', [Number(id)]);
  return existing;
}

async function deleteAccountByMobile(mobile) {
  const existing = await findByMobile(mobile);
  if (!existing) return null;
  await db.query('DELETE FROM accounts WHERE mobile = ?', [String(mobile)]);
  return existing;
}

/** API 列表用：不含 cookie 等敏感字段 */
function toPublicAccount(user) {
  if (!user) return null;
  return {
    id: user.id,
    mobile: user.mobile,
    nickname: user.nickname,
    vipLevel: user.vipLevel,
    uid: user.uid,
    status: user.status,
    successCount: user.successCount || 0,
    targetCount: user.targetCount || 1,
    completed: (user.successCount || 0) >= (user.targetCount || 1),
    loggedInAt: user.loggedInAt,
    updatedAt: user.updatedAt,
  };
}

async function createLoginSession({ token, expiresAt, targetCount }) {
  await db.query(
    `INSERT INTO login_sessions (token, status, target_count, expires_at) VALUES (?, 'pending', ?, ?)`,
    [token, normalizeTargetCount(targetCount), expiresAt]
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
};
