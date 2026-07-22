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
  \`mobile\` VARCHAR(20) NOT NULL,
  \`nickname\` VARCHAR(128) NULL,
  \`vip_level\` VARCHAR(16) NOT NULL DEFAULT 'V1',
  \`uid\` VARCHAR(64) NULL,
  \`god_uuid\` VARCHAR(64) NULL,
  \`device_id\` VARCHAR(64) NULL,
  \`cookies_json\` MEDIUMTEXT NULL,
  \`cookie_header\` MEDIUMTEXT NULL,
  \`vip_raw\` MEDIUMTEXT NULL,
  \`self_raw\` MEDIUMTEXT NULL,
  \`status\` TINYINT NOT NULL DEFAULT 1,
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
  await conn.end();
  console.log(`[init-db] ok, database=${database}`);
}

main().catch((e) => {
  console.error('[init-db] failed:', e.message || e);
  process.exit(1);
});
