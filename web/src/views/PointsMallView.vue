<script setup>
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  deletePointsTask,
  fetchPointsGoods,
  fetchPointsProfile,
  listPointsAccounts,
  listPointsSuccessLogs,
  submitPointsTask,
} from '@/api/pointsMall'
import { fmtTime } from '@/utils/format'

const loading = ref(false)
const profileLoading = ref(false)
const goodsLoading = ref(false)
const submitSaving = ref(false)
const deleteSaving = ref(new Set())
const accounts = ref([])
const selectedId = ref(null)
const profile = ref(null)
const profileError = ref('')
const goods = ref([])
const successLogs = ref([])
const selectedRoleId = ref('')
const selectedGoodsId = ref('')
const targetCount = ref(1)
const filterMobile = ref('')
const currencyName = ref('积分')
const gameName = ref('第五人格')

const filteredAccounts = computed(() => {
  const q = filterMobile.value.trim()
  if (!q) return accounts.value
  return accounts.value.filter((a) => {
    const blob = `${a.mobile || ''} ${a.buyerNickname || ''} ${a.actAccount || ''} ${a.boundRoleName || ''}`
    return blob.includes(q)
  })
})

const selectedAccount = computed(
  () => accounts.value.find((a) => Number(a.id) === Number(selectedId.value)) || null
)

const configuredTasks = computed(() =>
  accounts.value.flatMap((a) => {
    const tasks = Array.isArray(a.pointsTasks) && a.pointsTasks.length
      ? a.pointsTasks
      : a.pointsTask
        ? [a.pointsTask]
        : []
    return tasks.map((t) => ({
      ...t,
      mobile: a.mobile,
      buyerNickname: a.buyerNickname,
      actAccount: a.actAccount,
      boundRoleName: a.boundRoleName,
      boundServerName: a.boundServerName,
    }))
  })
)

const selectedAccountTasks = computed(() => {
  const a = selectedAccount.value
  if (!a) return []
  if (Array.isArray(a.pointsTasks) && a.pointsTasks.length) return a.pointsTasks
  return a.pointsTask ? [a.pointsTask] : []
})

const selectedGoodsTask = computed(() => {
  const gid = selectedGoodsId.value
  if (!gid) return null
  return selectedAccountTasks.value.find((t) => String(t.goodsId) === String(gid)) || null
})

const roles = computed(() => profile.value?.roles || [])
const selectedRole = computed(
  () => roles.value.find((r) => String(r.roleId) === String(selectedRoleId.value)) || profile.value?.role || selectedAccount.value?.boundRole || null
)
const selectedGoods = computed(
  () => goods.value.find((g) => String(g.exchangeId || g.id) === String(selectedGoodsId.value)) || null
)

const boundRole = computed(() => selectedRole.value || profile.value?.role || selectedAccount.value?.boundRole || null)
const pointsBalance = computed(() => {
  const c = profile.value?.currency
  if (c && c.balance != null) return c.balance
  if (selectedAccount.value?.pointsBalance != null) return selectedAccount.value.pointsBalance
  return null
})

function isDeleting(key) {
  return deleteSaving.value.has(String(key))
}

function setDeleting(key, on) {
  const next = new Set(deleteSaving.value)
  if (on) next.add(String(key))
  else next.delete(String(key))
  deleteSaving.value = next
}

function accountTaskCount(row) {
  if (Array.isArray(row.pointsTasks) && row.pointsTasks.length) return row.pointsTasks.length
  return row.pointsTask ? 1 : 0
}

function stockLabel(g) {
  // 与线上一致：售罄优先；已兑换看个人限兑
  if (g.soldOut || g.stockStatus === 'sold_out') {
    return g.prizeInventoryStatus === 'PERIOD_STOCK_ZERO' ? '暂无库存' : '已售罄'
  }
  if (g.alreadyExchanged || g.stockStatus === 'exchanged') return '已兑换'
  if (g.notStarted || g.stockStatus === 'not_started') return '未开始'
  return '可兑换'
}

function stockType(g) {
  if (g.soldOut || g.stockStatus === 'sold_out') return 'danger'
  if (g.alreadyExchanged || g.stockStatus === 'exchanged') return 'info'
  if (g.notStarted || g.stockStatus === 'not_started') return 'warning'
  return 'success'
}

function patchAccountRow(id, patch) {
  accounts.value = accounts.value.map((a) =>
    Number(a.id) === Number(id) ? { ...a, ...patch } : a
  )
}

function applyProfileToAccount(id, p) {
  if (!p) return
  const role = p.role || (p.roles || [])[0] || null
  patchAccountRow(id, {
    actAccount: p.actAccount || undefined,
    boundRole: role,
    boundRoleName: role?.roleName || '',
    boundServerName: role?.serverName || role?.server || '',
    pointsBalance: p.currency && p.currency.balance != null ? p.currency.balance : null,
    profileError: p.currency && p.currency.ok === false ? p.currency.message : '',
  })
}

async function loadAccounts() {
  loading.value = true
  try {
    const [accRes, logRes] = await Promise.all([
      listPointsAccounts(),
      listPointsSuccessLogs().catch(() => ({ logs: [] })),
    ])
    const prevById = new Map(accounts.value.map((a) => [Number(a.id), a]))
    accounts.value = (accRes.accounts || []).map((a) => {
      const prev = prevById.get(Number(a.id))
      if (!prev) return a
      return {
        ...a,
        boundRole: prev.boundRole,
        boundRoleName: prev.boundRoleName,
        boundServerName: prev.boundServerName,
        pointsBalance: prev.pointsBalance,
        profileError: prev.profileError,
      }
    })
    currencyName.value = accRes.currencyName || '积分'
    gameName.value = accRes.game || '第五人格'
    successLogs.value = logRes.logs || []
    if (!selectedId.value && accounts.value.length) {
      selectedId.value = accounts.value[0].id
    }
  } catch (e) {
    ElMessage.error(e.message || String(e))
  } finally {
    loading.value = false
  }
}

async function loadAccountDetail(id) {
  if (!id) return
  profileLoading.value = true
  goodsLoading.value = true
  profile.value = null
  profileError.value = ''
  goods.value = []
  selectedGoodsId.value = ''
  try {
    const [pSettled, gSettled] = await Promise.allSettled([
      fetchPointsProfile(id),
      fetchPointsGoods(id),
    ])
    if (pSettled.status === 'fulfilled') {
      const pRes = pSettled.value
      profile.value = pRes.profile || null
      applyProfileToAccount(id, pRes.profile)
      const role = pRes.profile?.role || (pRes.profile?.roles || [])[0]
      selectedRoleId.value = role?.roleId ? String(role.roleId) : ''
      const tasks =
        pRes.account?.pointsTasks ||
        (pRes.account?.pointsTask ? [pRes.account.pointsTask] : null) ||
        selectedAccountTasks.value
      if (Array.isArray(tasks) && tasks.length) {
        const hit = selectedGoodsId.value
          ? tasks.find((t) => String(t.goodsId) === String(selectedGoodsId.value))
          : tasks[0]
        if (hit?.goodsId && !selectedGoodsId.value) selectedGoodsId.value = String(hit.goodsId)
        if (hit?.targetCount) targetCount.value = Number(hit.targetCount) || 1
      }
      if (!profile.value?.role && !(profile.value?.roles || []).length) {
        profileError.value = pRes.profile?.message || '该账号在第五人格下没有可绑定角色'
      } else if (profile.value?.currency && profile.value.currency.ok === false) {
        profileError.value = profile.value.currency.message || '积分查询失败'
      }
    } else {
      profileError.value = pSettled.reason?.message || '账号信息加载失败'
      ElMessage.error(profileError.value)
    }
    if (gSettled.status === 'fulfilled') {
      const gRes = gSettled.value
      goods.value = gRes.goods || []
    } else {
      ElMessage.error(gSettled.reason?.message || '商品列表加载失败')
    }
  } catch (e) {
    ElMessage.error(e.message || String(e))
  } finally {
    profileLoading.value = false
    goodsLoading.value = false
  }
}

function onSelectAccount(row) {
  selectedId.value = row.id
  loadAccountDetail(row.id)
}

function onPickGoods(g) {
  selectedGoodsId.value = String(g.exchangeId || g.id)
  const hit = selectedAccountTasks.value.find(
    (t) => String(t.goodsId) === String(selectedGoodsId.value)
  )
  if (hit?.targetCount) targetCount.value = Number(hit.targetCount) || 1
}

async function onDeleteTask(row, ev) {
  ev?.stopPropagation?.()
  const accountId = row.accountId || row.id
  const taskId = row.id && row.goodsId ? row.id : row.pointsTask?.id || null
  const goodsId = row.goodsId || row.pointsTask?.goodsId || null
  const deleteKey = taskId || `${accountId}:${goodsId || 'all'}`
  const label = row.goodsName || row.pointsTask?.goodsName || goodsId || row.mobile || accountId
  try {
    await ElMessageBox.confirm(
      `确认删除账号「${row.mobile || accountId}」的抢购任务「${label}」？`,
      '删除任务',
      {
        type: 'warning',
        confirmButtonText: '删除',
        cancelButtonText: '取消',
      }
    )
  } catch {
    return
  }
  setDeleting(deleteKey, true)
  try {
    await deletePointsTask(accountId, taskId, goodsId)
    ElMessage.success('已删除抢购任务')
    await loadAccounts()
    if (Number(selectedId.value) === Number(accountId)) {
      await loadAccountDetail(accountId)
    }
  } catch (e) {
    ElMessage.error(e.message || String(e))
  } finally {
    setDeleting(deleteKey, false)
  }
}

async function onSubmit() {
  if (!selectedId.value) return ElMessage.warning('请先选择账号')
  if (!selectedGoodsId.value) return ElMessage.warning('请选择商品')
  if (!Number.isFinite(Number(targetCount.value)) || Number(targetCount.value) < 1) {
    return ElMessage.warning('抢购次数须大于等于 1')
  }
  submitSaving.value = true
  try {
    const g = selectedGoods.value
    const role = selectedRole.value
    const data = await submitPointsTask(selectedId.value, {
      goodsId: selectedGoodsId.value,
      goodsName: g?.name,
      goods: g?.raw || g,
      targetCount: Number(targetCount.value),
      role,
      currencyType: profile.value?.currency?.currencyType,
      currencyBalance: pointsBalance.value,
    })
    ElMessage.success(data.message || '已提交')
    await loadAccounts()
    await loadAccountDetail(selectedId.value)
  } catch (e) {
    ElMessage.error(e.message || String(e))
  } finally {
    submitSaving.value = false
  }
}

onMounted(async () => {
  await loadAccounts()
  if (selectedId.value) await loadAccountDetail(selectedId.value)
})
</script>

<template>
  <div class="points-page">
    <div class="page-header">
      <div>
        <el-tag type="danger" effect="light" round>{{ gameName }}积分商城</el-tag>
        <h1>积分抢购配置</h1>
        <p class="sub">同一账号可提交多个商品；各商品独立计数与抢购，互不影响。开抢时间由抢购程序控制：dev 读 .env 的 POINTS_SECKILL_START_AT，test:now 为下一整分。已售罄 / 已兑换仍可提交。</p>
      </div>
      <div class="header-actions">
        <el-button :loading="loading" @click="loadAccounts">刷新账号</el-button>
        <el-button
          type="danger"
          :disabled="!selectedId"
          :loading="profileLoading || goodsLoading"
          @click="loadAccountDetail(selectedId)"
        >刷新商品</el-button>
      </div>
    </div>

    <div class="layout">
      <el-card shadow="never" class="account-card" v-loading="loading">
        <el-input v-model="filterMobile" placeholder="搜索手机号 / 昵称" clearable class="mb" />
        <el-table
          :data="filteredAccounts"
          highlight-current-row
          :current-row="selectedAccount"
          size="small"
          height="560"
          empty-text="暂无已登录账号"
          @row-click="onSelectAccount"
        >
          <el-table-column label="账号" min-width="160">
            <template #default="{ row }">
              <div class="mono">{{ row.mobile || '—' }}</div>
              <div class="cell-sub">{{ row.buyerNickname || row.nickname || '—' }}</div>
              <div class="cell-sub">
                {{ row.boundRoleName || '未加载角色' }}
                <span v-if="row.boundServerName"> / {{ row.boundServerName }}</span>
              </div>
              <div class="cell-sub">{{ currencyName }} {{ row.pointsBalance == null ? '—' : row.pointsBalance }}</div>
            </template>
          </el-table-column>
          <el-table-column label="任务" width="130">
            <template #default="{ row }">
              <div class="task-cell">
                <el-tag v-if="accountTaskCount(row)" type="success" size="small">
                  {{ accountTaskCount(row) }} 个商品
                </el-tag>
                <span v-else class="muted">未配置</span>
              </div>
            </template>
          </el-table-column>
        </el-table>
      </el-card>

      <div class="main-col">
        <el-card shadow="never" v-loading="profileLoading">
          <template #header>账号信息</template>
          <div v-if="!selectedAccount" class="muted">请选择左侧账号</div>
          <el-descriptions v-else :column="3" size="small" border>
            <el-descriptions-item label="手机号">{{ selectedAccount.mobile || '—' }}</el-descriptions-item>
            <el-descriptions-item label="买家昵称">{{ selectedAccount.buyerNickname || '—' }}</el-descriptions-item>
            <el-descriptions-item label="账户名称">{{ profile?.actAccount || selectedAccount.actAccount || '—' }}</el-descriptions-item>
            <el-descriptions-item label="区服">
              {{ boundRole?.serverName || boundRole?.server || selectedAccount.boundServerName || '—' }}
            </el-descriptions-item>
            <el-descriptions-item label="绑定角色">
              {{ boundRole?.roleName || selectedAccount.boundRoleName || '—' }}
              <span v-if="boundRole?.roleId" class="cell-sub">ID {{ boundRole.roleId }}</span>
            </el-descriptions-item>
            <el-descriptions-item :label="'剩余' + currencyName">
              <strong>{{ pointsBalance == null ? '—' : pointsBalance }}</strong>
            </el-descriptions-item>
          </el-descriptions>
          <p v-if="profileError" class="profile-error">{{ profileError }}</p>
          <el-form v-if="roles.length > 1" class="role-form" label-width="80px" @submit.prevent>
            <el-form-item label="选择角色">
              <el-select v-model="selectedRoleId" placeholder="选择绑定角色" style="width: 320px">
                <el-option
                  v-for="r in roles"
                  :key="r.roleId"
                  :label="`${r.roleName} / ${r.serverName || r.server || '未知区'}`"
                  :value="String(r.roleId)"
                />
              </el-select>
            </el-form-item>
          </el-form>
        </el-card>

        <el-card shadow="never" class="goods-card" v-loading="goodsLoading">
          <template #header>
            <div class="panel-head">
              <span>商品列表（含已售罄 / 已兑换）</span>
              <span class="muted">共 {{ goods.length }} 件</span>
            </div>
          </template>
          <div v-if="!goods.length" class="muted">暂无商品，请确认账号在线后刷新</div>
          <div v-else class="goods-grid">
            <button
              v-for="g in goods"
              :key="g.exchangeId || g.id"
              type="button"
              class="goods-item"
              :class="{ active: String(g.exchangeId || g.id) === String(selectedGoodsId) }"
              @click="onPickGoods(g)"
            >
              <img v-if="g.image" :src="g.image" alt="" class="goods-img" />
              <div class="goods-body">
                <div class="goods-name">{{ g.name }}</div>
                <div class="goods-meta">
                  <span>{{ g.price }} {{ currencyName }}</span>
                  <span v-if="g.stock != null">库存 {{ g.stock }}</span>
                </div>
                <el-tag :type="stockType(g)" size="small">{{ stockLabel(g) }}</el-tag>
              </div>
            </button>
          </div>
        </el-card>

        <el-card shadow="never">
          <template #header>提交抢购任务</template>
          <el-form label-width="100px" @submit.prevent>
            <el-form-item label="已选商品">
              <span>{{ selectedGoods?.name || '未选择' }}</span>
            </el-form-item>
            <el-form-item label="开抢时间">
              <span class="muted">由 points-seckill 控制（.env / test:now）</span>
            </el-form-item>
            <el-form-item label="抢购次数">
              <el-input-number v-model="targetCount" :min="1" :max="9999" />
            </el-form-item>
            <el-form-item>
              <el-button type="danger" :loading="submitSaving" @click="onSubmit">
                {{ selectedGoodsTask ? '更新该商品任务' : '提交任务' }}
              </el-button>
              <span v-if="selectedGoodsTask" class="muted hint">
                已配置 {{ selectedGoodsTask.goodsName || selectedGoodsTask.goodsId }}
                · {{ selectedGoodsTask.successCount }}/{{ selectedGoodsTask.targetCount }}
              </span>
              <el-button
                v-if="selectedGoodsTask"
                type="danger"
                plain
                :loading="isDeleting(selectedGoodsTask.id)"
                @click.stop="onDeleteTask({ ...selectedGoodsTask, mobile: selectedAccount.mobile, accountId: selectedAccount.id }, $event)"
              >删除该商品</el-button>
            </el-form-item>
          </el-form>
          <div v-if="selectedAccountTasks.length" class="account-tasks">
            <div class="muted" style="margin-bottom: 8px">本账号已配置 {{ selectedAccountTasks.length }} 个商品</div>
            <el-table :data="selectedAccountTasks" size="small">
              <el-table-column prop="goodsName" label="商品" min-width="140" show-overflow-tooltip />
              <el-table-column label="次数" width="80">
                <template #default="{ row }">{{ row.successCount || 0 }}/{{ row.targetCount || 1 }}</template>
              </el-table-column>
              <el-table-column label="操作" width="80">
                <template #default="{ row }">
                  <el-button
                    size="small"
                    type="danger"
                    plain
                    :loading="isDeleting(row.id)"
                    @click.stop="onDeleteTask({ ...row, mobile: selectedAccount.mobile, accountId: selectedAccount.id }, $event)"
                  >删除</el-button>
                </template>
              </el-table-column>
            </el-table>
          </div>
        </el-card>

        <el-card shadow="never">
          <template #header>
            <div class="panel-head">
              <span>已配置抢购任务</span>
              <span class="muted">共 {{ configuredTasks.length }} 条</span>
            </div>
          </template>
          <el-table :data="configuredTasks" size="small" empty-text="暂无抢购任务">
            <el-table-column prop="mobile" label="账号" min-width="120" />
            <el-table-column label="角色 / 区服" min-width="140">
              <template #default="{ row }">
                {{ row.roleName || row.boundRoleName || '—' }}
                <span class="cell-sub">{{ row.serverName || row.boundServerName || '' }}</span>
              </template>
            </el-table-column>
            <el-table-column prop="goodsName" label="商品" min-width="140" show-overflow-tooltip />
            <el-table-column label="次数" width="80">
              <template #default="{ row }">{{ row.successCount || 0 }}/{{ row.targetCount || 1 }}</template>
            </el-table-column>
            <el-table-column label="操作" width="80" fixed="right">
              <template #default="{ row }">
                <el-button
                  size="small"
                  type="danger"
                  plain
                  :loading="isDeleting(row.id || `${row.accountId}:${row.goodsId}`)"
                  @click.stop="onDeleteTask(row, $event)"
                >删除</el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-card>

        <el-card shadow="never">
          <template #header>当日成功日志</template>
          <el-table :data="successLogs" size="small" empty-text="当日暂无成功记录">
            <el-table-column label="时间" width="170">
              <template #default="{ row }">{{ fmtTime(row.successAt) }}</template>
            </el-table-column>
            <el-table-column prop="mobile" label="账号" min-width="120" />
            <el-table-column prop="goodsName" label="商品" min-width="140" show-overflow-tooltip />
            <el-table-column label="类型" width="90">
              <template #default="{ row }">
                <el-tag :type="row.kind === 'suspected' ? 'warning' : 'success'" size="small">
                  {{ row.kind === 'suspected' ? '疑似' : '成功' }}
                </el-tag>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </div>
    </div>
  </div>
</template>

<style scoped>
.points-page {
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
.header-actions { display: flex; gap: 8px; }
.layout {
  display: grid;
  grid-template-columns: 380px 1fr;
  gap: 14px;
  align-items: start;
}
@media (max-width: 960px) {
  .layout { grid-template-columns: 1fr; }
}
.account-card { position: sticky; top: 12px; }
.mb { margin-bottom: 10px; }
.main-col { display: flex; flex-direction: column; gap: 14px; }
.mono { font-family: ui-monospace, Consolas, monospace; }
.muted { color: var(--el-text-color-secondary); }
.cell-sub { color: var(--el-text-color-secondary); font-size: 12px; }
.panel-head { display: flex; justify-content: space-between; gap: 12px; }
.goods-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 10px;
}
.goods-item {
  display: flex;
  gap: 10px;
  text-align: left;
  padding: 10px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
  background: #fff;
  cursor: pointer;
}
.goods-item.active {
  border-color: var(--el-color-danger);
  box-shadow: 0 0 0 1px var(--el-color-danger-light-5);
}
.goods-img {
  width: 56px;
  height: 56px;
  object-fit: cover;
  border-radius: 6px;
  background: var(--el-fill-color-light);
}
.goods-name { font-weight: 600; margin-bottom: 4px; }
.goods-meta { display: flex; gap: 8px; font-size: 12px; color: var(--el-text-color-secondary); margin-bottom: 6px; }
.role-form { margin-top: 12px; }
.hint { margin-left: 12px; }
.task-cell { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.account-tasks { margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--el-border-color-lighter); }
.profile-error { margin: 10px 0 0; color: var(--el-color-danger); font-size: 13px; }
</style>
