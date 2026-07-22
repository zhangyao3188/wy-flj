const path = require('path');
const fs = require('fs');
const mysql = require('mysql2/promise');

// 只加载本服务目录下的 .env，便于单独部署
const envPath = path.resolve(__dirname, '../.env');
if (fs.existsSync(envPath)) {
  require('dotenv').config({ path: envPath });
} else {
  require('dotenv').config();
}

let pool = null;

function getConfig() {
  return {
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'wy-flj',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'wy-flj',
    waitForConnections: true,
    connectionLimit: 10,
    charset: 'utf8mb4',
  };
}

function getPool() {
  if (!pool) pool = mysql.createPool(getConfig());
  return pool;
}

async function query(sql, params = []) {
  const [rows] = await getPool().execute(sql, params);
  return rows;
}

async function ping() {
  const rows = await query('SELECT 1 AS ok');
  return rows[0] && rows[0].ok === 1;
}

module.exports = { getPool, getConfig, query, ping };
