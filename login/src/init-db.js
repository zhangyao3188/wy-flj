/**
 * 初始化数据库表（在 login 目录执行: npm run init-db）
 */
const path = require('path');
const fs = require('fs');
const mysql = require('mysql2/promise');

const envPath = path.resolve(__dirname, '../.env');
if (fs.existsSync(envPath)) require('dotenv').config({ path: envPath });

async function main() {
  const host = process.env.DB_HOST;
  const port = Number(process.env.DB_PORT || 3306);
  const user = process.env.DB_USER;
  const password = process.env.DB_PASSWORD;
  const database = process.env.DB_NAME || 'wy-flj';

  console.log(`[init-db] connecting ${user}@${host}:${port} ...`);
  const conn = await mysql.createConnection({
    host,
    port,
    user,
    password,
    multipleStatements: true,
  });

  try {
    await conn.query(
      `CREATE DATABASE IF NOT EXISTS \`${database}\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci`
    );
  } catch (e) {
    console.warn(`[init-db] CREATE DATABASE 跳过/失败: ${e.message}`);
  }

  await conn.query(`USE \`${database}\``);
  await conn.query(`
CREATE TABLE IF NOT EXISTS \`accounts\` (
  \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  \`mobile\` VARCHAR(32) NULL COMMENT '手机号；无绑定时为 mock-1xxxxxxxxxx',
  \`nickname\` VARCHAR(128) NULL,
  \`buyer_nickname\` VARCHAR(128) NULL COMMENT '买家昵称（登录/管理页填写）',
  \`act_account\` VARCHAR(128) NULL COMMENT '账户名称 actInfo.actAccount',
  \`vip_level\` VARCHAR(16) NOT NULL DEFAULT 'V1',
  \`uid\` VARCHAR(64) NULL,
  \`god_uuid\` VARCHAR(64) NULL,
  \`device_id\` VARCHAR(64) NULL,
  \`cookies_json\` MEDIUMTEXT NULL,
  \`cookie_header\` MEDIUMTEXT NULL,
  \`vip_raw\` MEDIUMTEXT NULL,
  \`self_raw\` MEDIUMTEXT NULL,
  \`status\` TINYINT NOT NULL DEFAULT 1,
  \`success_count\` INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '真实抢购成功次数（不含已领取）',
  \`target_count\` INT UNSIGNED NOT NULL DEFAULT 1 COMMENT '设定的抢购次数',
  \`last_success_at\` DATETIME NULL COMMENT '最近一次真实抢购成功时间',
  \`logged_in_at\` DATETIME NULL,
  \`created_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  \`updated_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (\`id\`),
  UNIQUE KEY \`uk_mobile\` (\`mobile\`),
  KEY \`idx_status\` (\`status\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS \`login_sessions\` (
  \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  \`token\` VARCHAR(64) NOT NULL,
  \`status\` VARCHAR(32) NOT NULL DEFAULT 'pending',
  \`target_count\` INT UNSIGNED NOT NULL DEFAULT 1 COMMENT '本次登录设定的抢购次数',
  \`buyer_nickname\` VARCHAR(128) NULL COMMENT '本次登录填写的买家昵称',
  \`mobile\` VARCHAR(20) NULL,
  \`account_id\` BIGINT UNSIGNED NULL,
  \`message\` VARCHAR(512) NULL,
  \`created_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  \`updated_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  \`expires_at\` DATETIME NULL,
  PRIMARY KEY (\`id\`),
  UNIQUE KEY \`uk_token\` (\`token\`),
  KEY \`idx_status\` (\`status\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
`);

  // 已有库补列
  try {
    await conn.query(
      `ALTER TABLE \`accounts\` ADD COLUMN \`success_count\` INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '真实抢购成功次数（不含已领取）' AFTER \`status\``
    );
    console.log('[init-db] added accounts.success_count');
  } catch (e) {
    if (!/Duplicate column/i.test(e.message || '')) {
      console.warn(`[init-db] success_count 列: ${e.message}`);
    }
  }

  try {
    await conn.query(
      `ALTER TABLE \`accounts\` ADD COLUMN \`target_count\` INT UNSIGNED NOT NULL DEFAULT 1 COMMENT '设定的抢购次数' AFTER \`success_count\``
    );
    console.log('[init-db] added accounts.target_count (旧数据默认 1)');
  } catch (e) {
    if (!/Duplicate column/i.test(e.message || '')) {
      console.warn(`[init-db] target_count 列: ${e.message}`);
    }
  }

  try {
    await conn.query(
      `ALTER TABLE \`login_sessions\` ADD COLUMN \`target_count\` INT UNSIGNED NOT NULL DEFAULT 1 COMMENT '本次登录设定的抢购次数' AFTER \`status\``
    );
    console.log('[init-db] added login_sessions.target_count');
  } catch (e) {
    if (!/Duplicate column/i.test(e.message || '')) {
      console.warn(`[init-db] login_sessions.target_count 列: ${e.message}`);
    }
  }

  try {
    await conn.query(
      `ALTER TABLE \`accounts\` ADD COLUMN \`buyer_nickname\` VARCHAR(128) NULL COMMENT '买家昵称（登录/管理页填写）' AFTER \`nickname\``
    );
    console.log('[init-db] added accounts.buyer_nickname');
  } catch (e) {
    if (!/Duplicate column/i.test(e.message || '')) {
      console.warn(`[init-db] buyer_nickname 列: ${e.message}`);
    }
  }

  try {
    await conn.query(
      `ALTER TABLE \`accounts\` ADD COLUMN \`act_account\` VARCHAR(128) NULL COMMENT '账户名称 actInfo.actAccount' AFTER \`buyer_nickname\``
    );
    console.log('[init-db] added accounts.act_account');
  } catch (e) {
    if (!/Duplicate column/i.test(e.message || '')) {
      console.warn(`[init-db] act_account 列: ${e.message}`);
    }
  }

  try {
    await conn.query(
      `ALTER TABLE \`accounts\` MODIFY COLUMN \`mobile\` VARCHAR(32) NULL COMMENT '手机号；无绑定时为 mock-1xxxxxxxxxx'`
    );
    console.log('[init-db] accounts.mobile varchar(32) / mock-ready');
  } catch (e) {
    console.warn(`[init-db] mobile column: ${e.message}`);
  }

  try {
    await conn.query(
      `ALTER TABLE \`login_sessions\` ADD COLUMN \`buyer_nickname\` VARCHAR(128) NULL COMMENT '本次登录填写的买家昵称' AFTER \`target_count\``
    );
    console.log('[init-db] added login_sessions.buyer_nickname');
  } catch (e) {
    if (!/Duplicate column/i.test(e.message || '')) {
      console.warn(`[init-db] login_sessions.buyer_nickname 列: ${e.message}`);
    }
  }

  await conn.query(`
CREATE TABLE IF NOT EXISTS \`account_seckill_levels\` (
  \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  \`account_id\` BIGINT UNSIGNED NOT NULL,
  \`mobile\` VARCHAR(20) NOT NULL,
  \`vip_level\` VARCHAR(16) NOT NULL,
  \`target_count\` INT UNSIGNED NOT NULL DEFAULT 1 COMMENT '该等级设定抢购次数',
  \`success_count\` INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '该等级真实抢购成功次数',
  \`last_success_at\` DATETIME NULL COMMENT '该等级最近一次真实抢购成功时间',
  \`created_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  \`updated_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (\`id\`),
  UNIQUE KEY \`uk_mobile_level\` (\`mobile\`, \`vip_level\`),
  KEY \`idx_account_id\` (\`account_id\`),
  KEY \`idx_mobile\` (\`mobile\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
`);
  console.log('[init-db] ensure account_seckill_levels');

  try {
    await conn.query(
      `ALTER TABLE \`accounts\` ADD COLUMN \`last_success_at\` DATETIME NULL COMMENT '最近一次真实抢购成功时间' AFTER \`target_count\``
    );
    console.log('[init-db] added accounts.last_success_at');
  } catch (e) {
    if (!/Duplicate column/i.test(e.message || '')) {
      console.warn(`[init-db] accounts.last_success_at: ${e.message}`);
    }
  }

  try {
    await conn.query(
      `ALTER TABLE \`account_seckill_levels\` ADD COLUMN \`last_success_at\` DATETIME NULL COMMENT '该等级最近一次真实抢购成功时间' AFTER \`success_count\``
    );
    console.log('[init-db] added account_seckill_levels.last_success_at');
  } catch (e) {
    if (!/Duplicate column/i.test(e.message || '')) {
      console.warn(`[init-db] levels.last_success_at: ${e.message}`);
    }
  }

  await conn.query(`
CREATE TABLE IF NOT EXISTS \`seckill_success_logs\` (
  \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  \`account_id\` BIGINT UNSIGNED NULL,
  \`mobile\` VARCHAR(20) NULL,
  \`vip_level\` VARCHAR(16) NULL,
  \`coupon_id\` VARCHAR(128) NULL,
  \`stock_id\` VARCHAR(256) NULL,
  \`success_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  \`created_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (\`id\`),
  KEY \`idx_success_at\` (\`success_at\`),
  KEY \`idx_account_id\` (\`account_id\`),
  KEY \`idx_mobile\` (\`mobile\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
`);
  console.log('[init-db] ensure seckill_success_logs');

  // 旧账号迁移：无等级记录时，用 accounts 主等级 + 次数生成一条
  const [mig] = await conn.query(`
    INSERT INTO account_seckill_levels (account_id, mobile, vip_level, target_count, success_count)
    SELECT a.id,
           COALESCE(NULLIF(a.mobile, ''), CONCAT('#', a.id)),
           a.vip_level,
           COALESCE(NULLIF(a.target_count, 0), 1),
           COALESCE(a.success_count, 0)
    FROM accounts a
    WHERE NOT EXISTS (
      SELECT 1 FROM account_seckill_levels l WHERE l.account_id = a.id
    )
  `);
  if (mig && mig.affectedRows) {
    console.log(`[init-db] migrated ${mig.affectedRows} accounts → account_seckill_levels`);
  }

  await conn.end();
  console.log(`[init-db] ok, database=${database}`);
}

main().catch((e) => {
  console.error('[init-db] failed:', e.message || e);
  process.exit(1);
});
