<script setup>
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { createLoginSession, previewCurl, importCurl } from '@/api/login'

const router = useRouter()
const mode = ref('online')
const loading = ref(false)
const previewLoading = ref(false)

const buyerNickname = ref('')
const targetCount = ref(1)

const curlBuyer = ref('')
const curlTarget = ref(1)
const curlMobile = ref('')
const curlText = ref('')
const curlPreview = ref('')

const DESCS = {
  online: '先填写买家昵称与抢购次数，再开始登录。成功次数达到设定值后，该账号对应等级将不再参与抢购。',
  curl: '在其他设备登录并抓包后，把接口 curl（含登录 Cookie）粘贴到下方，即可导入本系统，无需本机再登录。',
}

function readTarget(raw) {
  const s = String(raw ?? '').trim()
  if (!s) throw new Error('请填写抢购次数')
  const n = Number(s)
  if (!Number.isFinite(n) || n < 1 || !Number.isInteger(n)) {
    throw new Error('抢购次数须为大于等于 1 的整数')
  }
  return n
}

async function startLogin() {
  loading.value = true
  try {
    const data = await createLoginSession({
      targetCount: readTarget(targetCount.value),
      buyerNickname: buyerNickname.value.trim(),
    })
    await router.push({ name: 'session', query: { token: data.token } })
  } catch (e) {
    ElMessage.error(e.message || String(e))
  } finally {
    loading.value = false
  }
}

async function onPreviewCurl() {
  previewLoading.value = true
  curlPreview.value = ''
  try {
    const curl = curlText.value.trim()
    if (!curl) throw new Error('请粘贴 curl 或 Cookie 原文')
    const data = await previewCurl(curl)
    if (data.mobile && !curlMobile.value) curlMobile.value = data.mobile
    curlPreview.value =
      `解析到 ${data.cookieCount} 个 Cookie` +
      (data.mobile ? `，识别手机号 ${data.mobile}` : '，手机号待导入时识别') +
      `\nGOD_UUID=${data.hasGodUuid ? '有' : '无'} · Plutus=${data.hasPlutus ? '有' : '无'} · URS=${data.hasUrs ? '有' : '无'}` +
      (data.cookieNames?.length ? `\n示例: ${data.cookieNames.slice(0, 12).join(', ')}` : '')
  } catch (e) {
    ElMessage.error(e.message || String(e))
  } finally {
    previewLoading.value = false
  }
}

async function onImportCurl() {
  loading.value = true
  try {
    const target = readTarget(curlTarget.value)
    const mobile = curlMobile.value.trim()
    if (mobile && !/^1\d{10}$/.test(mobile)) {
      throw new Error('手机号格式不正确（选填；若填写须为 11 位）')
    }
    const curl = curlText.value.trim()
    if (!curl) throw new Error('请粘贴 curl 或 Cookie 原文')
    const payload = { curl, targetCount: target, buyerNickname: curlBuyer.value.trim() }
    if (mobile) payload.mobile = mobile
    const data = await importCurl(payload)
    const a = data.account || {}
    ElMessage.success(
      `导入成功：${a.mobile || '（手机号留空）'}${a.actAccount ? ` / ${a.actAccount}` : ''}${a.vipLevel ? ` / ${a.vipLevel}` : ''}（Cookie ${data.cookieCount || '?'} 个）`
    )
  } catch (e) {
    ElMessage.error(e.message || String(e))
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="page-center">
    <el-card class="login-card" :class="{ wide: mode === 'curl' }" shadow="hover">
      <el-tag type="danger" effect="light" round class="brand">福利金账号</el-tag>
      <h1>登录网易账号</h1>
      <p class="desc">{{ DESCS[mode] }}</p>

      <el-segmented v-model="mode" :options="[
        { label: '在线登录', value: 'online' },
        { label: 'Curl 导入', value: 'curl' },
      ]" block class="mode-tabs" />

      <div v-show="mode === 'online'">
        <el-form label-position="top" @submit.prevent="startLogin">
          <el-form-item label="买家昵称">
            <el-input v-model="buyerNickname" maxlength="128" placeholder="例如：张三店铺" clearable />
            <div class="hint">选填，用于管理识别；旧账号默认为空，可在管理页修改。</div>
          </el-form-item>
          <el-form-item label="抢购次数" required>
            <el-input-number v-model="targetCount" :min="1" :max="9999" :step="1" controls-position="right" class="full-width" />
            <div class="hint">必填，整数，至少为 1。旧账号未填写时默认为 1 次。</div>
          </el-form-item>
          <el-button type="danger" native-type="submit" :loading="loading" class="full-width">开始登录</el-button>
        </el-form>
      </div>

      <div v-show="mode === 'curl'">
        <el-form label-position="top">
          <el-form-item label="买家昵称">
            <el-input v-model="curlBuyer" maxlength="128" placeholder="例如：张三店铺" clearable />
          </el-form-item>
          <el-form-item label="抢购次数" required>
            <el-input-number v-model="curlTarget" :min="1" :max="9999" :step="1" controls-position="right" class="full-width" />
          </el-form-item>
          <el-form-item label="手机号（选填）">
            <el-input v-model="curlMobile" maxlength="11" placeholder="可不填；无绑定则自动分配虚拟号" />
            <div class="hint">选填。识别不到会自动分配 mock-1xxxxxxxxxx 虚拟号。</div>
          </el-form-item>
          <el-form-item label="Curl / Cookie 原文" required>
            <el-input v-model="curlText" type="textarea" :rows="8" placeholder="粘贴 curl 或 Cookie 原文" />
            <div class="hint">支持 Chrome「复制为 cURL」、Charles、Fiddler；也可只贴 Cookie 头。</div>
            <el-alert v-if="curlPreview" :title="curlPreview" type="info" show-icon :closable="false" class="preview-box" />
          </el-form-item>
          <div class="btn-row">
            <el-button :loading="previewLoading" @click="onPreviewCurl">预览解析</el-button>
            <el-button type="danger" :loading="loading" @click="onImportCurl">导入并入库</el-button>
          </div>
        </el-form>
      </div>

      <div class="nav-link">
        <router-link to="/accounts">查看 / 管理全部账号</router-link>
      </div>
    </el-card>
  </div>
</template>

<style scoped>
.page-center {
  min-height: calc(100vh - 56px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px 16px;
}
.login-card {
  width: min(520px, 100%);
}
.login-card.wide {
  width: min(720px, 100%);
}
.brand { margin-bottom: 12px; }
h1 { margin: 0 0 8px; font-size: 1.5rem; }
.desc { color: var(--el-text-color-secondary); line-height: 1.6; margin: 0 0 16px; font-size: 0.95rem; }
.mode-tabs { margin-bottom: 20px; }
.hint { margin-top: 6px; font-size: 0.82rem; color: var(--el-text-color-secondary); line-height: 1.45; }
.full-width { width: 100%; }
.btn-row { display: flex; gap: 10px; flex-wrap: wrap; }
.preview-box { margin-top: 10px; white-space: pre-wrap; }
.nav-link { margin-top: 20px; text-align: center; }
.nav-link a { color: var(--el-color-danger); font-weight: 600; text-decoration: none; }
.nav-link a:hover { text-decoration: underline; }
</style>
