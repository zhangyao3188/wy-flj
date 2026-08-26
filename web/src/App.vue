<script setup>
import { computed, watch } from 'vue'
import { useRoute } from 'vue-router'

const route = useRoute()
const title = computed(() => {
  if (route.name === 'accounts') return '账号管理 - 福利金'
  if (route.name === 'points-mall') return '第五人格积分商城'
  if (route.name === 'session') return '完成登录 - 福利金'
  return '福利金登录'
})
watch(title, (t) => { document.title = t }, { immediate: true })
</script>

<template>
  <el-config-provider>
    <div class="app-shell">
      <el-header v-if="route.name !== 'session'" height="56px" class="app-header">
        <router-link to="/" class="logo">福利金</router-link>
        <nav>
          <router-link to="/">登录</router-link>
          <router-link to="/accounts">账号管理</router-link>
          <router-link to="/points-mall">积分商城</router-link>
        </nav>
      </el-header>
      <el-main :class="{ 'session-main': route.name === 'session' }">
        <router-view />
      </el-main>
    </div>
  </el-config-provider>
</template>

<style scoped>
.app-shell {
  min-height: 100vh;
  background:
    radial-gradient(900px 420px at 100% -10%, #ffe8e6 0%, transparent 55%),
    radial-gradient(700px 360px at -10% 110%, #e8f1ff 0%, transparent 50%),
    #f4f6f9;
}
.app-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 20px;
  background: rgba(255, 255, 255, 0.85);
  backdrop-filter: blur(8px);
  border-bottom: 1px solid var(--el-border-color-lighter);
}
.logo {
  font-weight: 700;
  color: var(--el-color-danger);
  text-decoration: none;
  font-size: 1.1rem;
}
nav {
  display: flex;
  gap: 16px;
}
nav a {
  color: var(--el-text-color-regular);
  text-decoration: none;
  font-weight: 500;
}
nav a.router-link-active {
  color: var(--el-color-danger);
}
.el-main {
  padding: 0;
}
.session-main {
  padding: 0;
}
</style>
