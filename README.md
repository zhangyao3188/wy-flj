# 福利金秒杀自动化（Node.js）

```
wy-flj/
  login/      # 登录服务（可单独部署，自带 DB 访问）
  seckill/    # 抢购服务（可单独部署，自带 DB 访问）
```

两个服务通过同一套 MySQL 共享账号数据，互不依赖对方的代码目录。

## 部署

| 用途 | 只部署 | 启动 |
|------|--------|------|
| **登录** | `login/` | `cd login && npm install && npm start` |
| **抢购** | `seckill/` | `cd seckill && npm install && npm run dev` |

各自目录下配置 `.env`（含 `DB_*`）。

## 1. 初始化数据库（在 login 侧执行一次即可）

在 `login/.env` 填好 MySQL 后：

```bash
cd login
npm install
npm run init-db
```

## 2. 登录服务

```bash
cd login
npm install
npx playwright install chromium   # 首次需要
npm start
```

访问：`http://127.0.0.1:3200/`（或 `.env` 里 `PORTAL_PUBLIC_URL`）

## 3. 抢购服务

```bash
cd seckill
npm install
npm run dev
```

立即测试（不等开抢）：`npm run test:now`
