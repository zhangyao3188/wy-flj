<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage } from 'element-plus'
import {
  getLoginSession,
  sendSessionInput,
  extractSession,
  sessionFrameUrl,
} from '@/api/login'

const route = useRoute()
const token = ref(String(route.query.token || ''))
const statusText = ref('正在准备登录画面…')
const statusType = ref('')
const typeBox = ref('')
const mobileHint = ref('')
const frameSrc = ref('')
const frameReady = ref(false)
const clickBusy = ref(false)
const extractLoading = ref(false)
const done = ref(false)

let refreshTimer = null
let pollTimer = null
let lastPointer = 0

function canInteract() {
  const img = document.getElementById('session-frame')
  if (img?.naturalWidth > 0 && img?.naturalHeight > 0) return true
  statusText.value = '画面加载中，请稍候再点击…'
  statusType.value = ''
  return false
}

function refreshFrame() {
  if (!token.value || clickBusy.value || done.value) return
  const url = sessionFrameUrl(token.value)
  // 用 fetch 探测，避免 204 把 img 打成裂图
  fetch(url, { cache: 'no-store' })
    .then(async (res) => {
      if (!res.ok || res.status === 204) return
      const blob = await res.blob()
      if (!blob || !blob.size) return
      const prev = frameSrc.value
      frameSrc.value = URL.createObjectURL(blob)
      frameReady.value = true
      if (prev && prev.startsWith('blob:')) URL.revokeObjectURL(prev)
    })
    .catch(() => {})
}

function onFrameLoad() {
  const img = document.getElementById('session-frame')
  if (img?.naturalWidth > 0) frameReady.value = true
}

function mapPoint(ev, frame) {
  const rect = frame.getBoundingClientRect()
  const clientX = ev.clientX
  const clientY = ev.clientY
  const nw = frame.naturalWidth || rect.width
  const nh = frame.naturalHeight || rect.height
  const scale = Math.min(rect.width / nw, rect.height / nh)
  const dispW = nw * scale
  const dispH = nh * scale
  const offsetX = (rect.width - dispW) / 2
  const offsetY = (rect.height - dispH) / 2
  const x = Math.round((clientX - rect.left - offsetX) / scale)
  const y = Math.round((clientY - rect.top - offsetY) / scale)
  return {
    x: Math.max(0, Math.min(nw - 1, x)),
    y: Math.max(0, Math.min(nh - 1, y)),
  }
}

async function sendClick(ev) {
  if (clickBusy.value || !token.value) return
  const frame = document.getElementById('session-frame')
  if (!frame || !canInteract()) return
  ev.preventDefault()
  ev.stopPropagation()
  const { x, y } = mapPoint(ev, frame)
  clickBusy.value = true
  statusText.value = `点击中… (${x}, ${y})`
  statusType.value = ''
  try {
    await sendSessionInput(token.value, { type: 'click', x, y })
    statusText.value = '已点击输入区域，可在上方输入后点「输入」'
  } catch (e) {
    statusText.value = e.message || String(e)
    statusType.value = 'err'
  } finally {
    clickBusy.value = false
    refreshFrame()
  }
}

function onPointerUp(ev) {
  if (ev.button != null && ev.button !== 0) return
  const now = Date.now()
  if (now - lastPointer < 350) return
  lastPointer = now
  sendClick(ev)
}

async function openLoginDialog() {
  if (clickBusy.value || !token.value) return
  clickBusy.value = true
  statusText.value = '正在打开登录框…'
  statusType.value = ''
  try {
    await sendSessionInput(token.value, { type: 'open-login' })
    statusText.value = '登录框已打开，请在画面中完成登录'
  } catch (e) {
    statusText.value = e.message || String(e)
    statusType.value = 'err'
  } finally {
    clickBusy.value = false
    refreshFrame()
  }
}

async function sendType() {
  if (!typeBox.value || !token.value) return
  await sendSessionInput(token.value, { type: 'type', text: typeBox.value, replace: true })
  typeBox.value = ''
  statusText.value = '已写入（覆盖）当前输入框'
  refreshFrame()
}

async function sendClear() {
  if (!token.value) return
  await sendSessionInput(token.value, { type: 'clear' })
  statusText.value = '已清空当前输入框，可重新输入'
  refreshFrame()
}

async function sendEnter() {
  if (!token.value) return
  await sendSessionInput(token.value, { type: 'press', key: 'Enter' })
  refreshFrame()
}

async function onExtract() {
  if (!token.value) return
  extractLoading.value = true
  statusText.value = '正在提取账号信息…'
  statusType.value = ''
  try {
    const body = {}
    const m = mobileHint.value.trim()
    if (m) body.mobile = m
    const data = await extractSession(token.value, body)
    statusText.value = `提取成功：${data.mobile || ''}（${data.account?.vipLevel || ''}）已写入数据库，可关闭本页`
    statusType.value = 'ok'
    done.value = true
  } catch (e) {
    statusText.value = e.message || String(e)
    statusType.value = 'err'
    extractLoading.value = false
    refreshFrame()
  }
}

async function pollStatus() {
  if (!token.value || done.value) return true
  try {
    const data = await getLoginSession(token.value)
    if (data.status === 'success') {
      statusText.value = `登录成功：${data.mobile || ''}（${data.account?.vipLevel || ''}）已写入数据库，可关闭本页`
      statusType.value = 'ok'
      done.value = true
      return true
    }
    if (data.status === 'failed' || data.status === 'expired') {
      statusText.value = data.message || data.status
      statusType.value = 'err'
      done.value = true
      return true
    }
    statusText.value = data.message || data.status || '请在画面中操作'
    statusType.value = ''
  } catch (e) {
    statusText.value = e.message || String(e)
    statusType.value = 'err'
  }
  return false
}

onMounted(async () => {
  if (!token.value) {
    statusText.value = '缺少 token'
    statusType.value = 'err'
    return
  }
  refreshFrame()
  refreshTimer = setInterval(refreshFrame, 700)
  while (!done.value) {
    const finished = await pollStatus()
    if (finished) break
    await new Promise((r) => {
      pollTimer = setTimeout(r, 1500)
    })
  }
})

onUnmounted(() => {
  if (refreshTimer) clearInterval(refreshTimer)
  if (pollTimer) clearTimeout(pollTimer)
  if (frameSrc.value && frameSrc.value.startsWith('blob:')) {
    URL.revokeObjectURL(frameSrc.value)
  }
})
</script>

<template>
  <div class="session-page">
    <el-card shadow="never" class="toolbar">
      <el-alert
        :title="statusText"
        :type="statusType === 'ok' ? 'success' : statusType === 'err' ? 'error' : 'info'"
        :closable="false"
        show-icon
      />
      <div class="row">
        <el-input v-model="typeBox" placeholder="先点画面输入框，再在此输入文字" @keyup.enter="sendType" />
        <el-button plain type="danger" @click="openLoginDialog">打开登录框</el-button>
        <el-button type="danger" @click="sendType">输入</el-button>
        <el-button @click="sendClear">清空</el-button>
        <el-button @click="sendEnter">回车</el-button>
      </div>
      <div class="row">
        <el-input v-model="mobileHint" placeholder="选填手机号（账号密码登录识别不到时可填）" maxlength="11" />
        <el-button type="success" :loading="extractLoading" :disabled="done" class="extract-btn" @click="onExtract">
          提取并入库
        </el-button>
      </div>
    </el-card>

    <div class="screen-wrap" v-loading="!frameReady && !done" element-loading-text="正在启动浏览器与登录页…">
      <img
        v-show="frameReady"
        id="session-frame"
        :src="frameSrc"
        alt="登录画面"
        draggable="false"
        @load="onFrameLoad"
        @pointerup="onPointerUp"
      />
      <div v-if="!frameReady && !done" class="frame-placeholder" aria-hidden="true" />
    </div>
    <p class="tip">若画面只有「请先登录」、点登录无反应，请点「打开登录框」。账号密码登录后点「提取并入库」。</p>
  </div>
</template>

<style scoped>
.session-page {
  max-width: 1100px;
  margin: 0 auto;
  padding: 12px 12px 24px;
}
.toolbar :deep(.el-card__body) {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.row {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  align-items: stretch;
}
.row .el-input { flex: 1; min-width: 160px; }
.extract-btn { min-width: 140px; }
.screen-wrap {
  position: relative;
  min-height: min(52vh, 420px);
  border: 1px solid var(--el-border-color);
  border-radius: 12px;
  overflow: hidden;
  background: #fff;
  display: flex;
  justify-content: center;
}
.frame-placeholder {
  width: 100%;
  min-height: min(52vh, 420px);
  background: linear-gradient(180deg, #f5f7fa 0%, #eef1f6 100%);
}
#session-frame {
  width: 100%;
  max-height: min(82vh, 800px);
  object-fit: contain;
  object-position: center top;
  cursor: pointer;
  user-select: none;
  touch-action: manipulation;
  background: #f0f2f5;
}
.tip {
  margin-top: 10px;
  text-align: center;
  color: var(--el-text-color-secondary);
  font-size: 0.82rem;
  line-height: 1.5;
}
</style>
