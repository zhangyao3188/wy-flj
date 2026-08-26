import { createRouter, createWebHistory } from 'vue-router'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'login', component: () => import('@/views/LoginView.vue') },
    { path: '/session', name: 'session', component: () => import('@/views/SessionView.vue') },
    { path: '/accounts', name: 'accounts', component: () => import('@/views/AccountsView.vue') },
    { path: '/points-mall', name: 'points-mall', component: () => import('@/views/PointsMallView.vue') },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
})

export default router
