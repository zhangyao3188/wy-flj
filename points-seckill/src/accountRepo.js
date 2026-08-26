const db = require('./db');

function formatDateTime(d) {
  if (!d) return null;
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return null;
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(
    date.getHours()
  )}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
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
    console.warn('[accountRepo] migrate unique key:', e.message || e);
  }
}

async function ensureTables() {
  await db.query(`
CREATE TABLE IF NOT EXISTS \`account_points_tasks\` (
  \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  \`account_id\` BIGINT UNSIGNED NOT NULL,
  \`mobile\` VARCHAR(32) NULL,
  \`act_id\` VARCHAR(64) NOT NULL,
  \`goods_id\` VARCHAR(128) NOT NULL,
  \`goods_name\` VARCHAR(256) NULL,
  \`goods_raw\` MEDIUMTEXT NULL,
  \`role_id\` VARCHAR(64) NULL,
  \`role_name\` VARCHAR(128) NULL,
  \`server\` VARCHAR(64) NULL,
  \`server_name\` VARCHAR(128) NULL,
  \`app_key\` VARCHAR(32) NULL,
  \`currency_type\` VARCHAR(64) NULL,
  \`currency_balance\` INT NULL,
  \`start_at\` DATETIME NOT NULL,
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

function rowToJob(row) {
  let cookies = [];
  try {
    cookies = row.cookies_json ? JSON.parse(row.cookies_json) : [];
  } catch (_) {}
  let goodsRaw = null;
  try {
    goodsRaw = row.goods_raw ? JSON.parse(row.goods_raw) : null;
  } catch (_) {}
  return {
    taskId: row.id,
    id: row.account_id,
    accountId: row.account_id,
    mobile: row.mobile || row.account_mobile,
    nickname: row.nickname,
    buyerNickname: row.buyer_nickname,
    actAccount: row.act_account,
    cookies,
    cookieHeader: row.cookie_header,
    godUuid: row.god_uuid,
    deviceId: row.device_id,
    uid: row.uid,
    goodsId: row.goods_id,
    goodsName: row.goods_name,
    goodsRaw,
    roleId: row.role_id,
    roleName: row.role_name,
    server: row.server,
    serverName: row.server_name,
    appKey: row.app_key,
    startAt: formatDateTime(row.start_at),
    targetCount: Number(row.target_count) || 1,
    successCount: Number(row.success_count) || 0,
  };
}

async function listIncompleteTasks(mobilesFilter) {
  await ensureTables();
  let sql = `
    SELECT t.*, a.mobile AS account_mobile, a.nickname, a.buyer_nickname, a.act_account,
           a.cookies_json, a.cookie_header, a.god_uuid, a.device_id, a.uid
    FROM account_points_tasks t
    INNER JOIN accounts a ON a.id = t.account_id
    WHERE t.status = 1
      AND COALESCE(t.success_count, 0) < COALESCE(t.target_count, 1)
      AND a.status = 1`;
  const params = [];
  if (mobilesFilter && mobilesFilter.length) {
    sql += ` AND a.mobile IN (${mobilesFilter.map(() => '?').join(',')})`;
    params.push(...mobilesFilter.map(String));
  }
  const rows = await db.query(sql, params);
  return rows.map(rowToJob);
}

async function incrementSuccessCount({ taskId, accountId, mobile, goodsId, goodsName }) {
  await ensureTables();
  const now = new Date();
  if (taskId) {
    await db.query(
      `UPDATE account_points_tasks
       SET success_count = COALESCE(success_count, 0) + 1, last_success_at = ?
       WHERE id = ?`,
      [now, Number(taskId)]
    );
  } else if (accountId && goodsId) {
    await db.query(
      `UPDATE account_points_tasks
       SET success_count = COALESCE(success_count, 0) + 1, last_success_at = ?
       WHERE account_id = ? AND goods_id = ?`,
      [now, Number(accountId), String(goodsId)]
    );
  } else {
    await db.query(
      `UPDATE account_points_tasks
       SET success_count = COALESCE(success_count, 0) + 1, last_success_at = ?
       WHERE account_id = ?`,
      [now, Number(accountId)]
    );
  }
  let rows;
  if (taskId) {
    rows = await db.query(`SELECT success_count FROM account_points_tasks WHERE id = ? LIMIT 1`, [
      Number(taskId),
    ]);
  } else if (accountId && goodsId) {
    rows = await db.query(
      `SELECT success_count FROM account_points_tasks WHERE account_id = ? AND goods_id = ? LIMIT 1`,
      [Number(accountId), String(goodsId)]
    );
  } else {
    rows = await db.query(
      `SELECT success_count FROM account_points_tasks WHERE account_id = ? LIMIT 1`,
      [Number(accountId)]
    );
  }
  await db.query(
    `INSERT INTO points_seckill_success_logs
      (account_id, mobile, goods_id, goods_name, kind, success_at)
     VALUES (?, ?, ?, ?, 'confirmed', ?)`,
    [
      Number(accountId) || null,
      mobile ? String(mobile) : null,
      goodsId ? String(goodsId).slice(0, 128) : null,
      goodsName ? String(goodsName).slice(0, 256) : null,
      now,
    ]
  );
  return Number(rows[0] && rows[0].success_count) || 0;
}

async function recordSuspectedSuccess({ accountId, mobile, goodsId, goodsName, note }) {
  await ensureTables();
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

module.exports = {
  ensureTables,
  listIncompleteTasks,
  incrementSuccessCount,
  recordSuspectedSuccess,
  formatDateTime,
};
