<script setup>
import { ref, computed, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  listAccounts,
  listSuccessLogs,
  checkOnline,
  checkAccountOnline,
  syncAccount,
  deleteAccount,
  patchAccount,
  addLevel,
  patchLevel,
  deleteLevel,
} from '@/api/accounts'
import { fmtTime, levelRank, buildVipStats, vipStatEntries } from '@/utils/format'

const loading = ref(false)
const checkLoading = ref(false)
const actionLoading = ref(new Set())
const accountsCache = ref([])
const successLogsCache = ref([])
const onlineCheckMap = ref(new Map())
const filterMobile = ref('')
const filterStatus = ref('active')
const todayMeta = ref({ day: '', orders: 0, suspectedOrders: 0, welfareOrders: 0, accounts: 0 })

const editSaving = ref(false)
const addLevelSaving = ref(false)
const buyerSaving = ref(false)

function setOnlineResult(r) {
  if (!r || r.id == null) return
  const map = new Map(onlineCheckMap.value)
  map.set(Number(r.id), {
    online: !!r.online,
    message: r.message || (r.online ? '在线' : '离线'),
  })
  onlineCheckMap.value = map
}

function isBusy(key) {
  return actionLoading.value.has(String(key))
}

function setBusy(key, on) {
  const next = new Set(actionLoading.value)
  if (on) next.add(String(key))
  else next.delete(String(key))
  actionLoading.value = next
}

async function withBusy(key, fn) {
  if (isBusy(key)) return
  setBusy(key, true)
  try {
    return await fn()
  } finally {
    setBusy(key, false)
  }
}

const editVisible = ref(false)
const editForm = ref({ successCount: 0, targetCount: 1 })
const editing = ref(null)

const addLevelVisible = ref(false)
const addLevelForm = ref({ vipLevel: 'V1', targetCount: 1 })
const addLevelOptions = ref([])
const addingAccountId = ref(null)
const addLevelHint = ref('')

const buyerVisible = ref(false)
const buyerInput = ref('')
const editingBuyerId = ref(null)
const buyerHint = ref('')

const showSuccessPanel = computed(() => filterStatus.value === 'today_success')

const filteredAccounts = computed(() => {
  const mobileQ = filterMobile.value.trim().replace(/\s+/g, '')
  const status = filterStatus.value
  return accountsCache.value.filter((a) => {
    if (mobileQ) {
      const blob = `${a.mobile || ''} ${a.buyerNickname || ''} ${a.actAccount || ''}`
      if (!blob.includes(mobileQ)) return false
    }
    if (status === 'active' && a.completed) return false
    if (status === 'completed' && !a.completed) return false
    if (status === 'today_success' && !(a.todaySuccessCount > 0)) return false
    return true
  })
})

const filteredSuccessLogs = computed(() => {
  const mobileQ = filterMobile.value.trim().replace(/\s+/g, '')
  if (!mobileQ) return successLogsCache.value
  return successLogsCache.value.filter((l) => {
    const blob = `${l.mobile || ''} ${l.buyerNickname || ''} ${l.actAccount || ''}`
    return blob.includes(mobileQ)
  })
})

const statsChips = computed(() => {
  const total = accountsCache.value.length
  const filtered = filteredAccounts.value.length
  const vipStats = buildVipStats(filteredAccounts.value)
  const vipText = vipStatEntries(vipStats)
    .map(([lv, n]) => `${lv} ${n}`)
    .join(' · ') || '暂无'
  const chips = [
    { label: '共', value: total, suffix: '个账号' },
  ]
  if (filtered !== total) {
    chips.push({ label: '当前显示', value: filtered, suffix: '个账号' })
  }
  let todaySuffix = `笔 / ${todayMeta.value.accounts || 0} 账号`
  if (todayMeta.value.welfareOrders) todaySuffix = `（福 ${todayMeta.value.welfareOrders}）` + todaySuffix
  if (todayMeta.value.suspectedOrders) todaySuffix = `（疑 ${todayMeta.value.suspectedOrders}）` + todaySuffix
  chips.push({ label: '今日成功', value: todayMeta.value.orders || 0, suffix: todaySuffix })
  chips.push({ label: '抢购档位', text: vipText })
  return chips
})

const successSub = computed(() => {
  const suspectedN = successLogsCache.value.filter((l) => l.kind === 'suspected').length
  const welfareN = successLogsCache.value.filter((l) => l.kind === 'welfare').length
  const extraParts = []
  if (welfareN > 0) extraParts.push(`福利 ${welfareN}`)
  if (suspectedN > 0) extraParts.push(`疑似 ${suspectedN}`)
  const base = `共 ${successLogsCache.value.length} 笔 · ${todayMeta.value.accounts || 0} 个账号`
  return extraParts.length
    ? `共 ${successLogsCache.value.length} 笔（含${extraParts.join('、')}）· ${todayMeta.value.accounts || 0} 个账号`
    : base
})

function accountLevels(a) {
  return a.levels?.length
    ? a.levels
    : [{
        id: null,
        vipLevel: a.vipLevel,
        successCount: a.successCount || 0,
        targetCount: a.targetCount || 1,
        completed: a.completed,
      }]
}

function successKindType(kind) {
  if (kind === 'welfare') return 'primary'
  if (kind === 'suspected') return 'warning'
  return 'success'
}

function successKindLabel(l) {
  if (l.kind === 'welfare') return `福利${l.vipLevel || '?'}`
  if (l.kind === 'suspected') return '疑似成功'
  return '成功'
}

function todaySuccessDisplay(a) {
  const total = a.todaySuccessCount || 0
  if (!total) return '0'
  const suspected = a.todaySuspectedCount || 0
  const welfare = a.todayWelfareCount || 0
  const confirmed = total - suspected - welfare
  const extras = []
  if (welfare > 0) extras.push(`福${welfare}`)
  if (suspected > 0) extras.push(`疑${suspected}`)
  return { main: confirmed > 0 ? confirmed : total, extras, warn: confirmed <= 0 && extras.length > 0 }
}

async function loadSuccessLogs() {
  try {
    const data = await listSuccessLogs()
    successLogsCache.value = data.logs || []
    if (data.day) todayMeta.value.day = data.day
  } catch {
    successLogsCache.value = []
  }
}

async function loadAccounts() {
  loading.value = true
  try {
    const [accRes] = await Promise.all([listAccounts(true), loadSuccessLogs()])
    accountsCache.value = accRes.accounts || []
    todayMeta.value = {
      day: accRes.today || todayMeta.value.day || '',
      orders: accRes.todaySuccessOrders || 0,
      suspectedOrders: accRes.todaySuspectedOrders || 0,
      welfareOrders: accRes.todayWelfareOrders || 0,
      accounts: accRes.todaySuccessAccounts || 0,
    }
  } catch (e) {
    ElMessage.error(e.message || String(e))
  } finally {
    loading.value = false
  }
}

function clearFilter() {
  filterMobile.value = ''
  filterStatus.value = 'active'
}

async function onCheckOnline() {
  checkLoading.value = true
  ElMessage.info('正在验证可用账号在线情况（跳过已完成）…')
  try {
    const data = await checkOnline()
    const map = new Map()
    for (const r of data.results || []) {
      map.set(Number(r.id), { online: !!r.online, message: r.message || (r.online ? '在线' : '离线') })
    }
    onlineCheckMap.value = map
    let msg = data.message || `在线 ${data.online}，离线 ${data.offline}`
    const offlineSample = (data.results || [])
      .filter((r) => !r.online)
      .slice(0, 5)
      .map((r) => r.mobile || r.id)
      .join('、')
    if (data.offline > 0 && offlineSample) {
      msg += `；离线示例：${offlineSample}${data.offline > 5 ? '…' : ''}`
    }
    ElMessage.success(msg)
    await loadAccounts()
  } catch (e) {
    ElMessage.error(e.message || String(e))
  } finally {
    checkLoading.value = false
  }
}

async function onCheckOne(row) {
  const id = Number(row.id)
  if (!id) return
  await withBusy(`online:${id}`, async () => {
    const data = await checkAccountOnline(id)
    setOnlineResult(data.result || data)
    ElMessage.success(
      `${row.mobile || id}：${data.message || (data.result?.online ? '在线' : '离线')}`
    )
  }).catch((e) => ElMessage.error(e.message || String(e)))
}

async function onSync(row) {
  await withBusy(`sync:${row.id}`, async () => {
    const data = await syncAccount(row.id)
    ElMessage.success(data.message || '同步成功')
    await loadAccounts()
  }).catch((e) => ElMessage.error(e.message || String(e)))
}

function onEditBuyer(row) {
  editingBuyerId.value = row.id
  buyerHint.value = `账号 ${row.mobile}`
  buyerInput.value = row.buyerNickname || ''
  buyerVisible.value = true
}

async function saveBuyer() {
  if (buyerSaving.value) return
  buyerSaving.value = true
  try {
    await patchAccount(editingBuyerId.value, { buyerNickname: buyerInput.value || '' })
    buyerVisible.value = false
    ElMessage.success('买家昵称已更新')
    await loadAccounts()
  } catch (e) {
    ElMessage.error(e.message || String(e))
  } finally {
    buyerSaving.value = false
  }
}

function onAddLevel(row) {
  addingAccountId.value = row.id
  const max = levelRank(row.vipLevel)
  const used = new Set(accountLevels(row).map((l) => String(l.vipLevel).toUpperCase()))
  const options = []
  for (let i = 1; i <= Math.max(max, 1); i++) {
    const lv = `V${i}`
    if (!used.has(lv)) options.push(lv)
  }
  if (!options.length) {
    ElMessage.warning(`已无可添加等级（最大 ${row.vipLevel}）`)
    return
  }
  addLevelOptions.value = options
  addLevelForm.value = { vipLevel: options[0], targetCount: 1 }
  addLevelHint.value = `账号 ${row.mobile}，最大档 ${row.vipLevel}`
  addLevelVisible.value = true
}

async function saveAddLevel() {
  if (addLevelSaving.value) return
  addLevelSaving.value = true
  try {
    await addLevel(addingAccountId.value, {
      vipLevel: addLevelForm.value.vipLevel,
      targetCount: Number(addLevelForm.value.targetCount) || 1,
    })
    addLevelVisible.value = false
    ElMessage.success('已添加抢购等级')
    await loadAccounts()
  } catch (e) {
    ElMessage.error(e.message || String(e))
  } finally {
    addLevelSaving.value = false
  }
}

function onEditLevel(account, level) {
  if (!level.id) {
    ElMessage.warning('该等级尚未入库，请先重新登录同步')
    return
  }
  editing.value = { accountId: account.id, levelId: level.id }
  editForm.value = {
    successCount: level.successCount || 0,
    targetCount: level.targetCount || 1,
  }
  editVisible.value = true
}

async function saveEditLevel() {
  if (editSaving.value) return
  const sc = Number(editForm.value.successCount)
  const tc = Number(editForm.value.targetCount)
  if (!Number.isFinite(sc) || sc < 0 || !Number.isInteger(sc)) {
    ElMessage.warning('成功次数须为大于等于 0 的整数')
    return
  }
  if (!Number.isFinite(tc) || tc < 1 || !Number.isInteger(tc)) {
    ElMessage.warning('抢购次数须为大于等于 1 的整数')
    return
  }
  editSaving.value = true
  try {
    await patchLevel(editing.value.accountId, editing.value.levelId, {
      successCount: sc,
      targetCount: tc,
    })
    editVisible.value = false
    ElMessage.success('等级次数已更新')
    await loadAccounts()
  } catch (e) {
    ElMessage.error(e.message || String(e))
  } finally {
    editSaving.value = false
  }
}

async function onDelLevel(account, level) {
  if (!level.id) return ElMessage.warning('该等级尚未入库')
  const key = `level-del:${level.id}`
  if (isBusy(key)) return
  try {
    await ElMessageBox.confirm('确认删除该抢购等级？', '提示', { type: 'warning' })
  } catch {
    return
  }
  await withBusy(key, async () => {
    await deleteLevel(account.id, level.id)
    ElMessage.success('已删除等级')
    await loadAccounts()
  }).catch((e) => ElMessage.error(e.message || String(e)))
}

function accountDisplayName(row) {
  const name = String(row?.buyerNickname || '').trim()
  return name || row?.mobile || '该账号'
}

async function onDelAccount(row) {
  const key = `del:${row.id}`
  if (isBusy(key)) return
  const label = accountDisplayName(row)
  try {
    await ElMessageBox.confirm(`确认删除账号「${label}」？此操作不可恢复。`, '危险操作', {
      type: 'warning',
      confirmButtonClass: 'el-button--danger',
    })
  } catch {
    return
  }
  await withBusy(key, async () => {
    await deleteAccount(row.id)
    ElMessage.success(`已删除 ${label}`)
    await loadAccounts()
  }).catch((e) => ElMessage.error(e.message || String(e)))
}

onMounted(loadAccounts)
</script>

<template>
  <div class="accounts-page">
    <div class="page-header">
      <div>
        <el-tag type="danger" effect="light" round>福利金账号</el-tag>
        <h1>账号管理</h1>
        <p class="sub">支持同账号配置多个抢购等级（如最大 V6，同时抢 V6/V5/V4）。</p>
      </div>
      <div class="header-actions">
        <router-link to="/">
          <el-button>去登录</el-button>
        </router-link>
        <el-button :loading="checkLoading" @click="onCheckOnline">验证在线</el-button>
        <el-button type="danger" :loading="loading" @click="loadAccounts">刷新</el-button>
      </div>
    </div>

    <div class="stats-row">
      <el-tag v-for="(chip, i) in statsChips" :key="i" effect="plain" size="large" class="stat-chip">
        <template v-if="chip.text">{{ chip.label }} {{ chip.text }}</template>
        <template v-else>{{ chip.label }} <strong>{{ chip.value }}</strong> {{ chip.suffix }}</template>
      </el-tag>
    </div>

    <el-card shadow="never" class="filter-card">
      <el-form inline @submit.prevent>
        <el-form-item label="手机号">
          <el-input v-model="filterMobile" placeholder="模糊搜索" clearable maxlength="20" style="width: 180px" />
        </el-form-item>
        <el-form-item label="状态">
          <el-select v-model="filterStatus" style="width: 160px">
            <el-option label="全部" value="all" />
            <el-option label="可用" value="active" />
            <el-option label="全部完成" value="completed" />
            <el-option label="当日抢购成功" value="today_success" />
          </el-select>
        </el-form-item>
        <el-form-item>
          <el-button @click="clearFilter">清空筛选</el-button>
        </el-form-item>
      </el-form>
    </el-card>

    <el-card v-if="showSuccessPanel" shadow="never" class="success-panel table-card">
      <template #header>
        <div class="panel-head">
          <span>当日抢购成功订单（{{ todayMeta.day || '今日' }}）</span>
          <span class="muted">{{ successSub }}</span>
        </div>
      </template>
      <el-table
        :data="filteredSuccessLogs"
        border
        stripe
        size="small"
        empty-text="当日暂无抢购成功订单"
        class="dense-table"
        style="width: 100%"
      >
        <el-table-column label="成功时间" width="140">
          <template #default="{ row }">{{ fmtTime(row.successAt) }}</template>
        </el-table-column>
        <el-table-column label="类型" width="90">
          <template #default="{ row }">
            <el-tag :type="successKindType(row.kind)" size="small" :title="row.note || ''">
              {{ successKindLabel(row) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="mobile" label="手机号" min-width="110" />
        <el-table-column prop="buyerNickname" label="买家昵称" min-width="90" show-overflow-tooltip />
        <el-table-column prop="actAccount" label="账户名称" min-width="110" show-overflow-tooltip />
        <el-table-column prop="vipLevel" label="等级" width="64" />
        <el-table-column label="次数" width="72">
          <template #default="{ row }">
            <span v-if="row.successCount != null && row.targetCount != null" class="mono" :class="{ done: row.successCount >= row.targetCount }">
              <strong>{{ row.successCount }}</strong>/{{ row.targetCount }}
            </span>
            <span v-else class="muted">—</span>
          </template>
        </el-table-column>
        <el-table-column prop="couponId" label="couponId" min-width="120" show-overflow-tooltip />
        <el-table-column prop="stockId" label="stockId" min-width="140" show-overflow-tooltip />
      </el-table>
    </el-card>

    <el-card shadow="never" class="table-card" v-loading="loading">
      <el-table
        :data="filteredAccounts"
        border
        stripe
        size="small"
        empty-text="没有符合条件的账号"
        class="dense-table"
        style="width: 100%"
      >
        <el-table-column label="手机号" width="150">
          <template #default="{ row }">
            <div class="mono">{{ row.mobile || '—' }}</div>
            <div v-if="row.isMockMobile || String(row.mobile || '').startsWith('mock-')" class="cell-sub">虚拟号</div>
          </template>
        </el-table-column>
        <el-table-column label="买家昵称" min-width="100">
          <template #default="{ row }">
            <div>{{ row.buyerNickname || '—' }}</div>
            <div v-if="row.nickname" class="cell-sub">网易: {{ row.nickname }}</div>
          </template>
        </el-table-column>
        <el-table-column prop="actAccount" label="账户名称" min-width="110" show-overflow-tooltip />
        <el-table-column prop="vipLevel" label="最大档" width="70" />
        <el-table-column label="抢购等级" min-width="140">
          <template #default="{ row }">
            <div class="levels">
              <div v-for="lv in accountLevels(row)" :key="lv.id || lv.vipLevel" class="level-row">
                <strong>{{ lv.vipLevel }}</strong>
                <span class="mono">{{ lv.successCount || 0 }}/{{ lv.targetCount || 1 }}</span>
                <el-tag :type="lv.completed ? 'warning' : 'success'" size="small">
                  {{ lv.completed ? '完成' : '抢购中' }}
                </el-tag>
                <el-button size="small" plain type="primary" @click="onEditLevel(row, lv)">编辑</el-button>
                <el-button
                  size="small"
                  plain
                  type="danger"
                  :loading="isBusy(`level-del:${lv.id}`)"
                  @click="onDelLevel(row, lv)"
                >删</el-button>
              </div>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="120">
          <template #default="{ row }">
            <div class="tag-row">
              <el-tag :type="row.completed ? 'warning' : 'success'" size="small">
                {{ row.completed ? '全部完成' : '可用' }}
              </el-tag>
              <el-tag
                v-if="onlineCheckMap.get(Number(row.id))"
                :type="onlineCheckMap.get(Number(row.id)).online ? 'success' : 'danger'"
                size="small"
                :title="onlineCheckMap.get(Number(row.id)).message"
              >
                {{ onlineCheckMap.get(Number(row.id)).online ? '在线' : '离线' }}
              </el-tag>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="今日成功" width="88">
          <template #default="{ row }">
            <template v-if="(row.todaySuccessCount || 0) > 0">
              <strong :class="todaySuccessDisplay(row).warn ? 'warn' : 'ok'">{{ todaySuccessDisplay(row).main }}</strong>
              <div v-if="todaySuccessDisplay(row).extras.length" class="cell-sub">+{{ todaySuccessDisplay(row).extras.join(' +') }}</div>
            </template>
            <span v-else>0</span>
          </template>
        </el-table-column>
        <el-table-column label="最近成功" width="140">
          <template #default="{ row }"><span class="muted">{{ fmtTime(row.lastSuccessAt) }}</span></template>
        </el-table-column>
        <el-table-column label="登录时间" width="140">
          <template #default="{ row }"><span class="muted">{{ fmtTime(row.loggedInAt || row.updatedAt) }}</span></template>
        </el-table-column>
        <el-table-column label="操作" width="300" fixed="right">
          <template #default="{ row }">
            <div class="row-ops">
              <el-button size="small" :loading="isBusy(`online:${row.id}`)" @click="onCheckOne(row)">在线</el-button>
              <el-button size="small" :loading="isBusy(`sync:${row.id}`)" @click="onSync(row)">同步</el-button>
              <el-button size="small" @click="onEditBuyer(row)">昵称</el-button>
              <el-button size="small" type="danger" plain @click="onAddLevel(row)">加等级</el-button>
              <el-button size="small" type="danger" :loading="isBusy(`del:${row.id}`)" @click="onDelAccount(row)">删</el-button>
            </div>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-dialog v-model="editVisible" title="编辑等级次数" width="420px">
      <p class="dlg-hint">修改后立即生效。成功次数可手动校正（不含疑似成功）。</p>
      <el-form label-position="top">
        <el-form-item label="成功次数">
          <el-input-number v-model="editForm.successCount" :min="0" :max="9999" class="full-width" />
        </el-form-item>
        <el-form-item label="抢购次数">
          <el-input-number v-model="editForm.targetCount" :min="1" :max="9999" class="full-width" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button :disabled="editSaving" @click="editVisible = false">取消</el-button>
        <el-button type="primary" :loading="editSaving" @click="saveEditLevel">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="addLevelVisible" title="新增抢购等级" width="420px">
      <p class="dlg-hint">{{ addLevelHint }}</p>
      <el-form label-position="top">
        <el-form-item label="等级">
          <el-select v-model="addLevelForm.vipLevel" class="full-width">
            <el-option v-for="lv in addLevelOptions" :key="lv" :label="lv" :value="lv" />
          </el-select>
        </el-form-item>
        <el-form-item label="抢购次数">
          <el-input-number v-model="addLevelForm.targetCount" :min="1" :max="9999" class="full-width" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button :disabled="addLevelSaving" @click="addLevelVisible = false">取消</el-button>
        <el-button type="primary" :loading="addLevelSaving" @click="saveAddLevel">添加</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="buyerVisible" title="编辑买家昵称" width="420px">
      <p class="dlg-hint">{{ buyerHint }} · 用于管理识别，可留空。</p>
      <el-form label-position="top">
        <el-form-item label="买家昵称">
          <el-input v-model="buyerInput" maxlength="128" placeholder="例如：张三店铺" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button :disabled="buyerSaving" @click="buyerVisible = false">取消</el-button>
        <el-button type="primary" :loading="buyerSaving" @click="saveBuyer">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.accounts-page {
  max-width: 1680px;
  margin: 0 auto;
  padding: 20px 16px 40px;
}
.page-header {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: flex-end;
  gap: 12px;
  margin-bottom: 16px;
}
h1 { margin: 8px 0 4px; font-size: 1.5rem; }
.sub { margin: 0; color: var(--el-text-color-secondary); font-size: 0.92rem; }
.header-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.stats-row { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 14px; }
.stat-chip strong { font-weight: 700; }
.filter-card { margin-bottom: 14px; }
.success-panel { margin-bottom: 14px; }
.panel-head { display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; align-items: center; }
.mono { font-family: ui-monospace, Consolas, monospace; font-variant-numeric: tabular-nums; }
.muted { color: var(--el-text-color-secondary); }
.levels { display: flex; flex-direction: column; gap: 4px; }
.level-row {
  display: flex;
  flex-wrap: nowrap;
  align-items: center;
  gap: 4px;
  padding: 2px 6px;
  background: var(--el-fill-color-light);
  border-radius: 6px;
  width: fit-content;
  max-width: 100%;
}
.level-row :deep(.el-button) {
  margin: 0;
  padding: 2px 8px;
}
.tag-row { display: flex; flex-wrap: wrap; gap: 4px; }
.row-ops {
  display: flex;
  flex-wrap: nowrap;
  align-items: center;
  gap: 4px;
  white-space: nowrap;
}
.row-ops :deep(.el-button) {
  margin: 0;
  padding: 4px 8px;
}
.ok { color: var(--el-color-success); }
.warn { color: var(--el-color-warning); }
.done { color: var(--el-color-success); }
.dlg-hint { margin: 0 0 12px; color: var(--el-text-color-secondary); font-size: 0.9rem; }
.full-width { width: 100%; }
.table-card :deep(.el-card__body) { padding: 8px; }
.dense-table :deep(.el-table__cell) {
  padding: 4px 8px;
}
.dense-table :deep(.el-table__header .el-table__cell) {
  padding: 6px 8px;
}
.cell-sub { font-size: 0.7rem; color: var(--el-text-color-secondary); margin-top: 1px; line-height: 1.2; }
</style>
