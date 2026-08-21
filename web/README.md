# 福利金 Web 前端

Vue 3 + Vite + Element Plus，对接 `login` 后端 API。

## 开发

1. 启动 login 后端（默认 `http://127.0.0.1:3200`）：

```bash
cd ../login
npm run dev
```

2. 启动前端：

```bash
npm run dev
```

浏览器打开 http://localhost:5173

## 页面

| 路由 | 功能 |
|------|------|
| `/` | 在线登录 + Curl 导入 |
| `/session?token=...` | 远程浏览器登录会话 |
| `/accounts` | 账号管理 |

## 构建

```bash
npm run build
```

产物在 `dist/`。生产环境需配置反向代理，将 `/api` 转发至 login 服务。

可选环境变量（`.env.development`）：

```
VITE_API_PROXY=http://127.0.0.1:3200
```
