import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const apiTarget = env.VITE_API_PROXY || 'http://127.0.0.1:3200'
  const proxy = {
    '/api': {
      target: apiTarget,
      changeOrigin: true,
      // Windows 下避免偶发连不上 localhost IPv6
      configure: (proxyServer) => {
        proxyServer.on('error', (err, _req, res) => {
          console.error(`[vite proxy] → ${apiTarget} 失败: ${err.message}`)
          console.error('[vite proxy] 请先启动 login 后端: cd login && npm run dev')
          if (res && !res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' })
            res.end(
              JSON.stringify({
                ok: false,
                message: `无法连接 login 后端 (${apiTarget})，请先执行: cd login && npm run dev`,
              })
            )
          }
        })
      },
    },
    '/health': {
      target: apiTarget,
      changeOrigin: true,
    },
  }

  return {
    plugins: [vue()],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    server: {
      port: 5173,
      proxy,
    },
    // vite preview 同样需要代理，否则也会 502/连不上 API
    preview: {
      port: 4173,
      proxy,
    },
  }
})
