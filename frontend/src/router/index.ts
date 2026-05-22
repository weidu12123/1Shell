import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';

const routes: RouteRecordRaw[] = [
  { path: '/',             name: 'home',        component: () => import('@/views/WorldHomeView.vue') },
  { path: '/console',      name: 'console',     component: () => import('@/views/MainConsoleView.vue') },
  { path: '/hosts',        name: 'hosts',       component: () => import('@/views/HostRepositoryView.vue') },
  { path: '/audit',        name: 'audit',       component: () => import('@/views/AuditView.vue') },
  { path: '/probe',        name: 'probe',       component: () => import('@/views/ProbeView.vue') },
  { path: '/cli-setup',    name: 'cli-setup',   component: () => import('@/views/CliSetupView.vue') },
  { path: '/scripts',      name: 'scripts',     component: () => import('@/views/ScriptsView.vue') },
  { path: '/skills',       name: 'skills',      component: () => import('@/views/SkillsView.vue') },
  { path: '/programs',     name: 'programs',    component: () => import('@/views/ProgramsView.vue') },
  { path: '/skill-studio', name: 'skill-studio', component: () => import('@/views/SkillStudioView.vue') },
];

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes,
});

export default router;
