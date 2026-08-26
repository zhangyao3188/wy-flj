const db = require('./db');

function normalizeTargetCount(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(Math.floor(n), 9999);
}

function parseStartAt(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  const s = String(value).trim().replace('T', ' ');
  const m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  const d = new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6] || 0),
    0
  );
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatDateTime(d) {
  if (!d) return null;
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return null;
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(
    date.getHours()
  )}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
}

function chinaDayRange(date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const day = fmt.format(date);
  const start = new Date(`${day}T00:00:00+08:00`);
  const end = new Date(`${day}T00:00:00+08:00`);
  end.setDate(end.getDate() + 1);
  return { day, start, end };
}

async function ensureTables() {
  await db.query(`
CREATE TABLE IF NOT EXISTS \`account_points_tasks\` (
  \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  \`account_id\` BIGINT UNSIGNED NOT NULL,
  \`mobile\` VARCHAR(32) NULL,
  \`act_id\` VARCHAR(64) NOT NULL,
  \`goods_id\` VARCHAR(128) NOT NULL COMMENT 'exchangeId',
  \`goods_name\` VARCHAR(256) NULL,
  \`goods_raw\` MEDIUMTEXT NULL,
  \`role_id\` VARCHAR(64) NULL,
  \`role_name\` VARCHAR(128) NULL,
  \`server\` VARCHAR(64) NULL,
  \`server_name\` VARCHAR(128) NULL,
  \`app_key\` VARCHAR(32) NULL,
  \`currency_type\` VARCHAR(64) NULL,
  \`currency_balance\` INT NULL,
  \`start_at\` DATETIME NOT NULL COMMENT 'yyyy-mm-dd hh:mm:ss',
  \`target_count\` INT UNSIGNED NOT NULL DEFAULT 1,
  \`success_count\` INT UNSIGNED NOT NULL DEFAULT 0,
  \`last_success_at\` DATETIME NULL,
  \`status\` TINYINT NOT NULL DEFAULT 1,
  \`created_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  \`updated_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (\`id\`),
  UNIQUE KEY \`uk_account_act_goods\` (\`account_id\`, \`act_id\`, \`goods_id\`),
  KEY \`idx_mobile\` (\`mobile\`),
  KEY \`idx_status\` (\`status\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
`);
  await migrateAccountPointsUniqueKey();
  await db.query(`
CREATE TABLE IF NOT EXISTS \`points_seckill_success_logs\` (
  \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  \`account_id\` BIGINT UNSIGNED NULL,
  \`mobile\` VARCHAR(32) NULL,
  \`goods_id\` VARCHAR(128) NULL,
  \`goods_name\` VARCHAR(256) NULL,
  \`kind\` VARCHAR(16) NOT NULL DEFAULT 'confirmed',
  \`note\` VARCHAR(256) NULL,
  \`success_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  \`created_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (\`id\`),
  KEY \`idx_success_at\` (\`success_at\`),
  KEY \`idx_account_id\` (\`account_id\`),
  KEY \`idx_mobile\` (\`mobile\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
`);
}

async function migrateAccountPointsUniqueKey() {
  try {
    const rows = await db.query(`SHOW INDEX FROM account_points_tasks WHERE Key_name = 'uk_account_act'`);
    if (rows && rows.length) {
      await db.query(`ALTER TABLE account_points_tasks DROP INDEX uk_account_act`);
    }
  } catch (_) {}
  try {
    const rows = await db.query(
      `SHOW INDEX FROM account_points_tasks WHERE Key_name = 'uk_account_act_goods'`
    );
    if (!rows || !rows.length) {
      await db.query(
        `ALTER TABLE account_points_tasks ADD UNIQUE KEY uk_account_act_goods (account_id, act_id, goods_id)`
      );
    }
  } catch (e) {
    console.warn('[pointsTaskRepo] migrate unique key:', e.message || e);
  }
}

function rowToTask(row) {
  if (!row) return null;
  let goodsRaw = null;
  try {
    goodsRaw = row.goods_raw ? JSON.parse(row.goods_raw) : null;
  } catch (_) {}
  const successCount = Number(row.success_count) || 0;
  const targetCount = normalizeTargetCount(row.target_count);
  return {
    id: row.id,
    accountId: row.account_id,
    mobile: row.mobile,
    actId: row.act_id,
    goodsId: row.goods_id,
    goodsName: row.goods_name,
    goodsRaw,
    roleId: row.role_id,
    roleName: row.role_name,
    server: row.server,
    serverName: row.server_name,
    appKey: row.app_key,
    currencyType: row.currency_type,
    currencyBalance: row.currency_balance != null ? Number(row.currency_balance) : null,
    startAt: formatDateTime(row.start_at),
    targetCount,
    successCount,
    lastSuccessAt: formatDateTime(row.last_success_at),
    status: Number(row.status) === 0 ? 0 : 1,
    completed: successCount >= targetCount,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    buyerNickname: row.buyer_nickname || null,
    actAccount: row.act_account || null,
    nickname: row.nickname || null,
  };
}

async function getTaskByAccountId(accountId, actId) {
  await ensureTables();
  const params = [Number(accountId)];
  let sql = `SELECT * FROM account_points_tasks WHERE account_id = ?`;
  if (Array.isArray(actId) && actId.length) {
    sql += ` AND act_id IN (${actId.map(() => '?').join(',')})`;
    params.push(...actId.map(String));
  } else if (actId) {
    sql += ' AND act_id = ?';
    params.push(String(actId));
  }
  sql += ' ORDER BY id DESC LIMIT 1';
  const rows = await db.query(sql, params);
  return rowToTask(rows[0]);
}

async function listTasksByAccountId(accountId, actId) {
  await ensureTables();
  const params = [Number(accountId)];
  let sql = `SELECT * FROM account_points_tasks WHERE account_id = ?`;
  if (Array.isArray(actId) && actId.length) {
    sql += ` AND act_id IN (${actId.map(() => '?').join(',')})`;
    params.push(...actId.map(String));
  } else if (actId) {
    sql += ' AND act_id = ?';
    params.push(String(actId));
  }
  sql += ' ORDER BY id DESC';
  const rows = await db.query(sql, params);
  return rows.map(rowToTask);
}

async function getTaskByAccountGoods(accountId, actId, goodsId) {
  await ensureTables();
  const params = [Number(accountId), String(goodsId)];
  let sql = `SELECT * FROM account_points_tasks WHERE account_id = ? AND goods_id = ?`;
  if (Array.isArray(actId) && actId.length) {
    sql += ` AND act_id IN (${actId.map(() => '?').join(',')})`;
    params.push(...actId.map(String));
  } else if (actId) {
    sql += ' AND act_id = ?';
    params.push(String(actId));
  }
  sql += ' ORDER BY id DESC LIMIT 1';
  const rows = await db.query(sql, params);
  return rowToTask(rows[0]);
}

async function listTasks() {
  await ensureTables();
  const rows = await db.query(
    `SELECT t.*, a.buyer_nickname, a.act_account, a.nickname, a.mobile AS account_mobile
     FROM account_points_tasks t
     LEFT JOIN accounts a ON a.id = t.account_id
     ORDER BY t.updated_at DESC`
  );
  return rows.map((r) =>
    rowToTask({
      ...r,
      mobile: r.mobile || r.account_mobile,
    })
  );
}

async function listIncompleteTasks() {
  await ensureTables();
  const rows = await db.query(
    `SELECT t.*, a.mobile AS account_mobile, a.nickname, a.buyer_nickname, a.act_account,
            a.cookies_json, a.cookie_header, a.god_uuid, a.device_id, a.uid, a.status AS account_status
     FROM account_points_tasks t
     INNER JOIN accounts a ON a.id = t.account_id
     WHERE t.status = 1
       AND COALESCE(t.success_count, 0) < COALESCE(t.target_count, 1)
       AND a.status = 1`
  );
  return rows.map((r) => {
    const task = rowToTask({ ...r, mobile: r.mobile || r.account_mobile });
    let cookies = [];
    try {
      cookies = r.cookies_json ? JSON.parse(r.cookies_json) : [];
    } catch (_) {}
    return {
      ...task,
      cookies,
      cookieHeader: r.cookie_header,
      godUuid: r.god_uuid,
      deviceId: r.device_id,
      uid: r.uid,
    };
  });
}

async function upsertTask({
  accountId,
  mobile,
  actId,
  goodsId,
  goodsName,
  goodsRaw,
  roleId,
  roleName,
  server,
  serverName,
  appKey,
  currencyType,
  currencyBalance,
  startAt,
  targetCount,
}) {
  await ensureTables();
  // start_at 仅作库字段占位；真实开火时间由 points-seckill 的 .env / test:now 决定
  const start = parseStartAt(startAt) || new Date();
  if (!goodsId) throw new Error('请选择商品');
  const count = normalizeTargetCount(targetCount);
  const goodsJson =
    goodsRaw == null ? null : typeof goodsRaw === 'string' ? goodsRaw : JSON.stringify(goodsRaw);

  await db.query(
    `INSERT INTO account_points_tasks
      (account_id, mobile, act_id, goods_id, goods_name, goods_raw,
       role_id, role_name, server, server_name, app_key,
       currency_type, currency_balance, start_at, target_count, success_count, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1)
     ON DUPLICATE KEY UPDATE
       mobile = VALUES(mobile),
       goods_id = VALUES(goods_id),
       goods_name = VALUES(goods_name),
       goods_raw = VALUES(goods_raw),
       role_id = VALUES(role_id),
       role_name = VALUES(role_name),
       server = VALUES(server),
       server_name = VALUES(server_name),
       app_key = VALUES(app_key),
       currency_type = VALUES(currency_type),
       currency_balance = VALUES(currency_balance),
       start_at = VALUES(start_at),
       target_count = VALUES(target_count),
       status = 1`,
    [
      Number(accountId),
      mobile ? String(mobile).slice(0, 32) : null,
      String(actId),
      String(goodsId).slice(0, 128),
      goodsName ? String(goodsName).slice(0, 256) : null,
      goodsJson,
      roleId ? String(roleId).slice(0, 64) : null,
      roleName ? String(roleName).slice(0, 128) : null,
      server != null ? String(server).slice(0, 64) : null,
      serverName ? String(serverName).slice(0, 128) : null,
      appKey ? String(appKey).slice(0, 32) : null,
      currencyType ? String(currencyType).slice(0, 64) : null,
      currencyBalance != null && Number.isFinite(Number(currencyBalance))
        ? Number(currencyBalance)
        : null,
      formatDateTime(start),
      count,
    ]
  );
  return getTaskByAccountGoods(accountId, actId, goodsId);
}

async function deleteTask({ id, accountId, actId, goodsId } = {}) {
  await ensureTables();
  if (id) {
    await db.query('DELETE FROM account_points_tasks WHERE id = ?', [Number(id)]);
    return true;
  }
  if (!accountId) return false;
  const params = [Number(accountId)];
  let sql = 'DELETE FROM account_points_tasks WHERE account_id = ?';
  if (Array.isArray(actId) && actId.length) {
    sql += ` AND act_id IN (${actId.map(() => '?').join(',')})`;
    params.push(...actId.map(String));
  } else if (actId) {
    sql += ' AND act_id = ?';
    params.push(String(actId));
  }
  if (goodsId) {
    sql += ' AND goods_id = ?';
    params.push(String(goodsId));
  }
  await db.query(sql, params);
  return true;
}

async function incrementSuccessCount({ taskId, accountId, mobile, goodsId, goodsName }) {
  await ensureTables();
  const now = new Date();
  if (taskId) {
    await db.query(
      `UPDATE account_points_tasks
       SET success_count = COALESCE(success_count, 0) + 1,
           last_success_at = ?
       WHERE id = ?`,
      [now, Number(taskId)]
    );
  } else if (accountId && goodsId) {
    await db.query(
      `UPDATE account_points_tasks
       SET success_count = COALESCE(success_count, 0) + 1,
           last_success_at = ?
       WHERE account_id = ? AND goods_id = ?`,
      [now, Number(accountId), String(goodsId)]
    );
  } else if (accountId) {
    await db.query(
      `UPDATE account_points_tasks
       SET success_count = COALESCE(success_count, 0) + 1,
           last_success_at = ?
       WHERE account_id = ?`,
      [now, Number(accountId)]
    );
  }
  let task = null;
  if (taskId) {
    const rows = await db.query(`SELECT * FROM account_points_tasks WHERE id = ? LIMIT 1`, [
      Number(taskId),
    ]);
    task = rowToTask(rows[0]);
  } else if (accountId && goodsId) {
    task = await getTaskByAccountGoods(accountId, null, goodsId);
  } else {
    task = await getTaskByAccountId(accountId);
  }
  await db.query(
    `INSERT INTO points_seckill_success_logs
      (account_id, mobile, goods_id, goods_name, kind, success_at)
     VALUES (?, ?, ?, ?, 'confirmed', ?)`,
    [
      Number(accountId) || (task && task.accountId) || null,
      mobile ? String(mobile) : null,
      goodsId ? String(goodsId).slice(0, 128) : null,
      goodsName ? String(goodsName).slice(0, 256) : null,
      now,
    ]
  );
  return task ? task.successCount : 0;
}

async function recordSuspectedSuccess({ accountId, mobile, goodsId, goodsName, note }) {
  await ensureTables();
  const { start, end } = chinaDayRange();
  if (accountId && goodsId) {
    const existed = await db.query(
      `SELECT id FROM points_seckill_success_logs
       WHERE account_id = ? AND goods_id = ? AND kind IN ('confirmed', 'suspected')
         AND success_at >= ? AND success_at < ? LIMIT 1`,
      [Number(accountId), String(goodsId), start, end]
    );
    if (existed.length) return false;
  } else if (accountId) {
    const existed = await db.query(
      `SELECT id FROM points_seckill_success_logs
       WHERE account_id = ? AND kind IN ('confirmed', 'suspected')
         AND success_at >= ? AND success_at < ? LIMIT 1`,
      [Number(accountId), start, end]
    );
    if (existed.length) return false;
  }
  await db.query(
    `INSERT INTO points_seckill_success_logs
      (account_id, mobile, goods_id, goods_name, kind, note, success_at)
     VALUES (?, ?, ?, ?, 'suspected', ?, ?)`,
    [
      accountId != null ? Number(accountId) : null,
      mobile ? String(mobile) : null,
      goodsId ? String(goodsId).slice(0, 128) : null,
      goodsName ? String(goodsName).slice(0, 256) : null,
      note ? String(note).slice(0, 256) : null,
      new Date(),
    ]
  );
  return true;
}

async function listSuccessLogs({ day } = {}) {
  await ensureTables();
  const range = day
    ? chinaDayRange(new Date(`${day}T12:00:00+08:00`))
    : chinaDayRange();
  const rows = await db.query(
    `SELECT l.*, a.buyer_nickname, a.act_account, t.target_count, t.success_count
     FROM points_seckill_success_logs l
     LEFT JOIN accounts a ON a.id = l.account_id
     LEFT JOIN account_points_tasks t
       ON t.account_id = l.account_id
      AND (l.goods_id IS NULL OR t.goods_id = l.goods_id)
     WHERE l.success_at >= ? AND l.success_at < ?
     ORDER BY l.success_at DESC`,
    [range.start, range.end]
  );
  return {
    day: range.day,
    total: rows.length,
    logs: rows.map((r) => ({
      id: r.id,
      accountId: r.account_id,
      mobile: r.mobile,
      buyerNickname: r.buyer_nickname || null,
      actAccount: r.act_account || null,
      goodsId: r.goods_id,
      goodsName: r.goods_name,
      kind: r.kind,
      note: r.note,
      successAt: formatDateTime(r.success_at),
      successCount: r.success_count != null ? Number(r.success_count) : null,
      targetCount: r.target_count != null ? Number(r.target_count) : null,
    })),
  };
}

module.exports = {
  ensureTables,
  normalizeTargetCount,
  parseStartAt,
  formatDateTime,
  chinaDayRange,
  getTaskByAccountId,
  listTasksByAccountId,
  getTaskByAccountGoods,
  listTasks,
  listIncompleteTasks,
  upsertTask,
  deleteTask,
  incrementSuccessCount,
  recordSuspectedSuccess,
  listSuccessLogs,
  rowToTask,
};
