<script setup lang="ts">
// 系统设置 — 4.2：由弹窗改为独立页面（左侧分区导航 + 右侧内容）
import { ref, watch, onMounted, onBeforeUnmount } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import QRCode from 'qrcode';
import AppIcon from '@/components/AppIcon.vue';
import { useApiClient } from '@/composables/useApiClient';
import { useNotifyStore } from '@/stores/notify';
import IpFilterTab from '@/components/main/IpFilterTab.vue';

type SecurityMode = 'strict' | 'standard' | 'trusted';

interface SecuritySettings {
  securityMode: SecurityMode;
  agentPrivilegeIsolation: boolean;
  agentUser: string;
  commandRules?: CommandRule[];
  updatedAt?: string | null;
}

interface CommandRule {
  id: string;
  pattern: string;
  action: 'allow' | 'deny';
  note?: string;
  enabled: boolean;
}

interface SecuritySettingsResponse {
  ok?: boolean;
  settings?: SecuritySettings;
  modes?: string[];
}

interface AgentUserInitResponse {
  ok?: boolean;
  hostId?: string;
  agentUser?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  durationMs?: number;
}

const route = useRoute();
const router = useRouter();
const { requestJson } = useApiClient();
const notify = useNotifyStore();

const SECURITY_MODES: SecurityMode[] = ['strict', 'standard', 'trusted'];
const SECURITY_MODE_LABELS: Record<SecurityMode, string> = {
  strict: '严格 strict',
  standard: '标准 standard',
  trusted: '信任直通 trusted',
};

type Tab = 'account' | 'security' | 'ipfilter' | 'desktop' | 'about';

const APP_VERSION = '4.7.8';
const GITHUB_URL = 'https://github.com/weidu12123/1Shell';
const VPS_SWITCH_URL = 'https://github.com/weidu12123/vps-switch';

const TAB_ITEMS: Array<{ key: Tab; label: string; icon: string; desc: string }> = [
  { key: 'account',  label: '账号设置',    icon: 'lock',    desc: '用户名与访问口令' },
  { key: 'security', label: '安全',        icon: 'shield',  desc: '两步验证 · 安全档位 · 权限隔离' },
  { key: 'ipfilter', label: 'IP 访问控制', icon: 'globe',   desc: '黑白名单与访问限制' },
  { key: 'desktop',  label: '桌面版',      icon: 'console', desc: '自启 · 托盘 · 本地服务' },
  { key: 'about',    label: '关于 / 详情', icon: 'github',  desc: '版本 · 检查更新 · 项目主页' },
];

function isTab(v: unknown): v is Tab {
  return typeof v === 'string' && TAB_ITEMS.some((t) => t.key === v);
}

const tab = ref<Tab>(isTab(route.query.tab) ? route.query.tab : 'account');

function switchTab(t: Tab): void {
  tab.value = t;
  void router.replace({ query: t === 'account' ? {} : { tab: t } });
}

const username = ref('');
const password = ref('');
const passwordConfirm = ref('');
const errorMsg = ref('');

const securityLoading = ref(false);
const securitySaving = ref(false);
const securityError = ref('');
const securityModes = ref<SecurityMode[]>([...SECURITY_MODES]);
const securityMode = ref<SecurityMode>('strict');
const securitySettingsLoaded = ref(false);
const agentPrivilegeIsolation = ref(false);
const agentUser = ref('oneshell-agent');
const initHostId = ref('local');
const initLoading = ref(false);
const initResult = ref('');

// ── 命令白/黑名单 ──
const commandRules = ref<CommandRule[]>([]);
const newRulePattern = ref('');
const newRuleAction = ref<'allow' | 'deny'>('allow');
const newRuleNote = ref('');
const ruleEvalCommand = ref('');
const ruleEvalResult = ref<RuleEvalResult | null>(null);
const ruleEvalBusy = ref(false);

interface RuleEvalResult {
  verdict: string;
  level: string;
  action: string;
  reasons: string[];
  catastrophic: boolean;
  matchedRule: { pattern: string; action: string } | null;
}

// ── 两步验证（2FA） ──
interface TwoFaStatus {
  available?: boolean;
  enabled: boolean;
  pendingSetup?: boolean;
  remainingRecoveryCodes?: number;
  enabledAt?: string | null;
}
const twofaStatus = ref<TwoFaStatus | null>(null);
const twofaError = ref('');
const twofaBusy = ref(false);
const twofaSetup = ref<{ secret: string; otpauthUrl: string } | null>(null);
const twofaQrDataUrl = ref('');
const twofaCode = ref('');
const twofaDisableCode = ref('');
const twofaRecoveryCodes = ref<string[]>([]);

type DesktopBooleanKey = 'startAtLogin' | 'backgroundOnClose' | 'skipLocalLogin';

const desktopAvailable = ref(false);
const desktopLoading = ref(false);
const desktopSaving = ref(false);
const desktopError = ref('');
const desktopSettingsLoaded = ref(false);
const desktopSettings = ref<OneShellDesktopSettings | null>(null);

// ── 关于 / 自动更新 ──
const updateState = ref<OneShellUpdateState | null>(null);
const updateBusy = ref(false);
let updateUnsub: (() => void) | null = null;

// 服务端在线更新（截图那套：版本/更新日志/回退/无人值守/Token/限流）
interface ServerUpdateRateLimit {
  limit: number; used: number; remaining: number; resetAt: string; authenticated: boolean;
}
interface ServerUpdateStatus {
  buildType: 'binary' | 'docker' | 'desktop';
  currentVersion: string;
  latestVersion: string;
  hasUpdate: boolean;
  publishedAt: string;
  releaseName: string;
  releaseNotes: string;
  releaseUrl: string;
  asset: { name: string; size: number } | null;
  checkedAt: string | null;
  checkError: string;
  applying: boolean;
  previousVersion: string;
  canRollback: boolean;
  lastUpdatedAt: string;
  autoUpdate: boolean;
  autoUpdateAt: string;
  hasToken: boolean;
  rateLimit: ServerUpdateRateLimit;
  repoUrl: string;
}

const srvUpdate = ref<ServerUpdateStatus | null>(null);
const srvBusy = ref('');           // '' | 'check' | 'apply' | 'rollback' | 'docker' | 'token' | 'verify' | 'restart'
const srvError = ref('');
const srvNotesOpen = ref(true);
const srvRestarting = ref(false);
const srvRestartText = ref('');
const tokenInput = ref('');
const tokenVerifyMsg = ref('');
const isDesktopMode = Boolean(window.oneshellDesktop?.isDesktop);
const SERVER_RESTART_INITIAL_DELAY_MS = 2500;
const SERVER_RESTART_POLL_MS = 1500;
const SERVER_RESTART_TIMEOUT_MS = 90000;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function hardReloadApp(): void {
  const url = new URL(window.location.href);
  url.searchParams.set('_1shellUpdated', Date.now().toString(36));
  window.location.replace(url.toString());
}

async function readServerVersion(): Promise<string> {
  const response = await fetch(`/api/updater/status?_=${Date.now()}`, {
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json() as { status?: { currentVersion?: string } };
  return String(data.status?.currentVersion || '').trim();
}

async function reloadAfterServerUpdate(expectedVersion: string, label: string): Promise<void> {
  srvBusy.value = 'restart';
  srvRestarting.value = true;
  srvRestartText.value = `${label}已提交，等待服务重启并加载新前端…`;
  await wait(SERVER_RESTART_INITIAL_DELAY_MS);

  const deadline = Date.now() + SERVER_RESTART_TIMEOUT_MS;
  let lastVersion = '';
  while (Date.now() < deadline) {
    try {
      const version = await readServerVersion();
      lastVersion = version;
      if (!expectedVersion || version === expectedVersion) {
        srvRestartText.value = `服务已恢复到 v${version || expectedVersion}，正在刷新页面…`;
        await wait(300);
        hardReloadApp();
        return;
      }
      srvRestartText.value = `服务已响应，当前版本 v${version || '未知'}，继续等待 v${expectedVersion}…`;
    } catch {
      srvRestartText.value = '服务正在重启，继续等待…';
    }
    await wait(SERVER_RESTART_POLL_MS);
  }

  srvBusy.value = '';
  srvRestarting.value = false;
  srvRestartText.value = '';
  srvError.value = lastVersion && expectedVersion
    ? `已提交${label}，但自动刷新超时：当前服务报告 v${lastVersion}，目标 v${expectedVersion}。请手动刷新页面。`
    : `已提交${label}，但自动刷新超时。请手动刷新页面。`;
  notify.warn(srvError.value, 8000);
}

async function loadServerUpdate(): Promise<void> {
  if (isDesktopMode) return;
  try {
    const r = await requestJson<{ ok: boolean; status: ServerUpdateStatus }>('/api/updater/status');
    srvUpdate.value = r.status;
    tokenInput.value = '';
  } catch (e) { srvError.value = (e as Error).message || '加载更新状态失败'; }
}

async function srvCheck(): Promise<void> {
  if (srvBusy.value) return;
  srvBusy.value = 'check'; srvError.value = '';
  try {
    const r = await requestJson<{ status: ServerUpdateStatus; error?: string }>('/api/updater/check', { method: 'POST' });
    srvUpdate.value = r.status;
    if (r.error) srvError.value = r.error;
  } catch (e) { srvError.value = (e as Error).message || '检查更新失败'; }
  finally { srvBusy.value = ''; }
}

async function srvApply(): Promise<void> {
  if (srvBusy.value) return;
  if (!window.confirm('确定更新并重启？更新期间服务会短暂中断。')) return;
  srvBusy.value = 'apply'; srvError.value = '';
  try {
    const result = await requestJson<{ toVersion?: string }>('/api/updater/apply', { method: 'POST', body: JSON.stringify({}) });
    const toVersion = String(result.toVersion || srvUpdate.value?.latestVersion || '').trim();
    notify.success('更新已开始，服务即将重启并刷新页面…', 6000);
    void reloadAfterServerUpdate(toVersion, '更新');
  } catch (e) {
    srvBusy.value = '';
    srvError.value = (e as Error).message || '更新失败';
  }
}

async function srvDockerPull(): Promise<void> {
  if (srvBusy.value) return;
  if (!window.confirm('拉取最新镜像并重建容器？')) return;
  srvBusy.value = 'docker'; srvError.value = '';
  try {
    await requestJson('/api/updater/docker-pull', { method: 'POST' });
    notify.success('已触发镜像拉取与容器重建…');
  } catch (e) { srvError.value = (e as Error).message || '拉取镜像失败'; }
  finally { srvBusy.value = ''; }
}

async function srvRollback(): Promise<void> {
  if (srvBusy.value) return;
  if (!window.confirm('回退到上一版本并重启？')) return;
  srvBusy.value = 'rollback'; srvError.value = '';
  try {
    const result = await requestJson<{ toVersion?: string }>('/api/updater/rollback', { method: 'POST' });
    const toVersion = String(result.toVersion || srvUpdate.value?.previousVersion || '').trim();
    notify.success('回退已开始，服务即将重启并刷新页面…', 6000);
    void reloadAfterServerUpdate(toVersion, '回退');
  } catch (e) {
    srvBusy.value = '';
    srvError.value = (e as Error).message || '回退失败';
  }
}

async function srvSaveToken(): Promise<void> {
  if (srvBusy.value) return;
  srvBusy.value = 'token'; srvError.value = ''; tokenVerifyMsg.value = '';
  try {
    const r = await requestJson<{ status: ServerUpdateStatus }>('/api/updater/token', { method: 'POST', body: JSON.stringify({ token: tokenInput.value }) });
    srvUpdate.value = r.status; tokenInput.value = '';
    notify.success('GitHub Token 已保存');
  } catch (e) { srvError.value = (e as Error).message || '保存失败'; }
  finally { srvBusy.value = ''; }
}

async function srvVerifyToken(): Promise<void> {
  if (srvBusy.value) return;
  srvBusy.value = 'verify'; tokenVerifyMsg.value = '';
  try {
    const r = await requestJson<{ ok: boolean; limit?: number; remaining?: number; error?: string }>('/api/updater/token/verify', { method: 'POST', body: JSON.stringify({ token: tokenInput.value }) });
    tokenVerifyMsg.value = r.ok ? `有效 · 限额 ${r.remaining}/${r.limit}` : `无效：${r.error || ''}`;
  } catch (e) { tokenVerifyMsg.value = (e as Error).message || '验证失败'; }
  finally { srvBusy.value = ''; }
}

async function srvRefreshRate(): Promise<void> {
  try {
    const r = await requestJson<{ rateLimit: ServerUpdateRateLimit }>('/api/updater/rate-limit', { method: 'POST' });
    if (srvUpdate.value) srvUpdate.value = { ...srvUpdate.value, rateLimit: r.rateLimit };
  } catch { /* ignore */ }
}

async function srvToggleAuto(enabled: boolean): Promise<void> {
  try {
    const r = await requestJson<{ status: ServerUpdateStatus }>('/api/updater/auto', { method: 'POST', body: JSON.stringify({ enabled }) });
    srvUpdate.value = r.status;
  } catch (e) { srvError.value = (e as Error).message || '设置失败'; }
}

async function srvSaveAutoAt(at: string): Promise<void> {
  try {
    const r = await requestJson<{ status: ServerUpdateStatus }>('/api/updater/auto', { method: 'POST', body: JSON.stringify({ at }) });
    srvUpdate.value = r.status;
  } catch (e) { srvError.value = (e as Error).message || '设置失败'; }
}

function loadUpdateState(): void {
  const bridge = window.oneshellDesktop;
  if (!bridge?.isDesktop) { updateState.value = null; void loadServerUpdate(); return; }
  if (!updateUnsub) {
    updateUnsub = bridge.onUpdateState((s) => { updateState.value = s; });
  }
  void bridge.getUpdateState().then((s) => { updateState.value = s; });
}

async function onCheckUpdate(): Promise<void> {
  const bridge = window.oneshellDesktop;
  if (!bridge?.isDesktop || updateBusy.value) return;
  updateBusy.value = true;
  try { updateState.value = await bridge.checkUpdate(); }
  finally { updateBusy.value = false; }
}

async function onDownloadUpdate(): Promise<void> {
  const bridge = window.oneshellDesktop;
  if (!bridge?.isDesktop || updateBusy.value) return;
  updateBusy.value = true;
  try { updateState.value = await bridge.downloadUpdate(); }
  finally { updateBusy.value = false; }
}

async function onInstallUpdate(): Promise<void> {
  const bridge = window.oneshellDesktop;
  if (!bridge?.isDesktop) return;
  await bridge.installUpdate();
}

function loadTabData(t: Tab): void {
  if (t === 'security') {
    void loadSecuritySettings();
    void loadTwofaStatus();
  } else if (t === 'desktop') {
    void loadDesktopSettings();
  } else if (t === 'about') {
    loadUpdateState();
  }
}

watch(tab, loadTabData);

onMounted(() => {
  loadTabData(tab.value);
});

onBeforeUnmount(() => {
  if (updateUnsub) { updateUnsub(); updateUnsub = null; }
});

async function onSubmit(e: Event): Promise<void> {
  e.preventDefault();
  errorMsg.value = '';
  if (password.value && password.value !== passwordConfirm.value) {
    errorMsg.value = '两次输入的口令不一致';
    return;
  }
  if (!username.value && !password.value) {
    errorMsg.value = '请填写用户名或密码';
    return;
  }
  try {
    const body: Record<string, string> = {};
    if (username.value) body.username = username.value;
    if (password.value) body.password = password.value;
    await requestJson('/api/auth/credentials', {
      method: 'PUT',
      body: JSON.stringify(body),
    });
    username.value = '';
    password.value = '';
    passwordConfirm.value = '';
    notify.success('凭据已更新，下次登录生效');
  } catch (err) {
    errorMsg.value = (err as Error).message || '保存失败';
  }
}

function openMcpHub(): void {
  void router.push('/config/mcp');
}

function isSecurityMode(value: string): value is SecurityMode {
  return SECURITY_MODES.includes(value as SecurityMode);
}

async function loadSecuritySettings(): Promise<void> {
  if (securitySettingsLoaded.value || securityLoading.value) return;
  securityError.value = '';
  securityLoading.value = true;
  try {
    const res = await requestJson<SecuritySettingsResponse>('/api/security/settings');
    const modes = Array.isArray(res.modes) ? res.modes.filter(isSecurityMode) : [];
    if (modes.length) securityModes.value = modes;
    if (res.settings) applySecuritySettings(res.settings);
    securitySettingsLoaded.value = true;
  } catch (err) {
    securityError.value = (err as Error).message || '加载安全设置失败';
  } finally {
    securityLoading.value = false;
  }
}

function applySecuritySettings(settings: SecuritySettings): void {
  securityMode.value = isSecurityMode(settings.securityMode) ? settings.securityMode : 'strict';
  agentPrivilegeIsolation.value = settings.agentPrivilegeIsolation === true;
  agentUser.value = settings.agentUser || 'oneshell-agent';
  commandRules.value = Array.isArray(settings.commandRules)
    ? settings.commandRules.map((r) => ({
        id: String(r.id || ''),
        pattern: String(r.pattern || ''),
        action: r.action === 'deny' ? 'deny' : 'allow',
        note: String(r.note || ''),
        enabled: r.enabled !== false,
      }))
    : [];
}

function addCommandRule(): void {
  securityError.value = '';
  const pattern = newRulePattern.value.trim().replace(/\s+/g, ' ');
  if (!pattern) {
    securityError.value = '请填写命令规则，如 docker compose *';
    return;
  }
  if (/[;&|]/.test(pattern)) {
    securityError.value = '规则匹配单条命令段，不能包含 ; & | 分隔符';
    return;
  }
  if (newRuleAction.value === 'allow' && /rm\s+[^|]*-[a-z]*r[a-z]*f|--no-preserve-root|mkfs|\bdd\b[^|]*of=\/dev\//i.test(pattern)) {
    securityError.value = '灾难级操作不能用 allow 规则放行（红线无法豁免）';
    return;
  }
  commandRules.value.push({
    id: `crule-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    pattern,
    action: newRuleAction.value,
    note: newRuleNote.value.trim().slice(0, 200),
    enabled: true,
  });
  newRulePattern.value = '';
  newRuleNote.value = '';
}

function removeCommandRule(id: string): void {
  commandRules.value = commandRules.value.filter((r) => r.id !== id);
}

async function evaluateRuleCommand(): Promise<void> {
  const command = ruleEvalCommand.value.trim();
  if (!command) {
    ruleEvalResult.value = null;
    return;
  }
  ruleEvalBusy.value = true;
  try {
    const res = await requestJson<{ ok?: boolean } & RuleEvalResult>('/api/security/evaluate', {
      method: 'POST',
      body: JSON.stringify({ command }),
    });
    ruleEvalResult.value = {
      verdict: res.verdict,
      level: res.level,
      action: res.action,
      reasons: res.reasons || [],
      catastrophic: res.catastrophic === true,
      matchedRule: res.matchedRule || null,
    };
  } catch (err) {
    ruleEvalResult.value = {
      verdict: (err as Error).message || '评估失败',
      level: '',
      action: '',
      reasons: [],
      catastrophic: false,
      matchedRule: null,
    };
  } finally {
    ruleEvalBusy.value = false;
  }
}

function ruleEvalBadgeClass(action: string): string {
  if (action === 'block' || action === 'deny') return 'bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300';
  if (action === 'approval') return 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300';
  if (action === 'warn') return 'bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300';
  return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300';
}

function ruleEvalLabel(res: RuleEvalResult): string {
  if (res.catastrophic) return '灾难红线拦截';
  if (res.matchedRule?.action === 'deny') return '黑名单拦截';
  if (res.matchedRule?.action === 'allow') return '白名单放行';
  if (res.action === 'block') return '风险阻断';
  if (res.action === 'approval') return '需要审批';
  if (res.action === 'warn') return '放行并告警';
  return '放行';
}

async function onSecuritySubmit(e: Event): Promise<void> {
  e.preventDefault();
  securityError.value = '';
  if (agentPrivilegeIsolation.value && !agentUser.value.trim()) {
    securityError.value = '启用 Agent 权限隔离时必须填写普通用户';
    return;
  }
  securitySaving.value = true;
  try {
    const res = await requestJson<SecuritySettingsResponse>('/api/security/settings', {
      method: 'PUT',
      body: JSON.stringify({
        securityMode: securityMode.value,
        agentPrivilegeIsolation: agentPrivilegeIsolation.value,
        agentUser: agentUser.value.trim() || 'oneshell-agent',
        commandRules: commandRules.value,
      }),
    });
    if (res.settings) applySecuritySettings(res.settings);
    notify.success('安全设置已保存');
  } catch (err) {
    securityError.value = (err as Error).message || '保存安全设置失败';
  } finally {
    securitySaving.value = false;
  }
}

async function onInitAgentUser(): Promise<void> {
  securityError.value = '';
  initResult.value = '';
  if (!agentUser.value.trim()) {
    securityError.value = '请先填写 Agent 普通用户';
    return;
  }
  initLoading.value = true;
  try {
    const res = await requestJson<AgentUserInitResponse>('/api/security/agent-user/init', {
      method: 'POST',
      body: JSON.stringify({ hostId: initHostId.value.trim() || 'local', agentUser: agentUser.value.trim() }),
    });
    initResult.value = [
      `exitCode=${res.exitCode ?? 0}`,
      res.stdout ? `stdout:\n${res.stdout}` : '',
      res.stderr ? `stderr:\n${res.stderr}` : '',
    ].filter(Boolean).join('\n');
    if (res.ok) notify.success('Agent 普通用户初始化完成');
    else securityError.value = '初始化未成功，请查看输出';
  } catch (err) {
    securityError.value = (err as Error).message || '初始化失败';
  } finally {
    initLoading.value = false;
  }
}

// ── 两步验证（2FA）逻辑 ──

async function loadTwofaStatus(): Promise<void> {
  twofaError.value = '';
  try {
    twofaStatus.value = await requestJson<TwoFaStatus>('/api/auth/2fa/status');
  } catch (err) {
    twofaError.value = (err as Error).message || '加载 2FA 状态失败';
  }
}

async function onTwofaSetup(): Promise<void> {
  twofaError.value = '';
  twofaBusy.value = true;
  twofaRecoveryCodes.value = [];
  try {
    const res = await requestJson<{ secret: string; otpauthUrl: string }>('/api/auth/2fa/setup', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    twofaSetup.value = res;
    twofaCode.value = '';
    twofaQrDataUrl.value = await QRCode.toDataURL(res.otpauthUrl, { width: 180, margin: 1 });
  } catch (err) {
    twofaError.value = (err as Error).message || '生成 2FA 密钥失败';
  } finally {
    twofaBusy.value = false;
  }
}

async function onTwofaEnable(): Promise<void> {
  twofaError.value = '';
  if (!twofaCode.value.trim()) {
    twofaError.value = '请输入认证器中的 6 位验证码';
    return;
  }
  twofaBusy.value = true;
  try {
    const res = await requestJson<{ ok: boolean; recoveryCodes: string[] }>('/api/auth/2fa/enable', {
      method: 'POST',
      body: JSON.stringify({ code: twofaCode.value.trim() }),
    });
    twofaRecoveryCodes.value = res.recoveryCodes || [];
    twofaSetup.value = null;
    twofaQrDataUrl.value = '';
    twofaCode.value = '';
    notify.success('两步验证已开启');
    await loadTwofaStatus();
  } catch (err) {
    twofaError.value = (err as Error).message || '开启失败';
  } finally {
    twofaBusy.value = false;
  }
}

async function onTwofaDisable(): Promise<void> {
  twofaError.value = '';
  if (!twofaDisableCode.value.trim()) {
    twofaError.value = '请输入验证码或恢复码以确认关闭';
    return;
  }
  twofaBusy.value = true;
  try {
    await requestJson('/api/auth/2fa/disable', {
      method: 'POST',
      body: JSON.stringify({ code: twofaDisableCode.value.trim() }),
    });
    twofaDisableCode.value = '';
    twofaRecoveryCodes.value = [];
    notify.success('两步验证已关闭');
    await loadTwofaStatus();
  } catch (err) {
    twofaError.value = (err as Error).message || '关闭失败';
  } finally {
    twofaBusy.value = false;
  }
}

function copyRecoveryCodes(): void {
  if (!twofaRecoveryCodes.value.length) return;
  navigator.clipboard?.writeText(twofaRecoveryCodes.value.join('\n')).then(() => {
    notify.success('恢复码已复制，请妥善保存');
  }).catch(() => {
    notify.error('复制失败，请手动抄录');
  });
}

async function loadDesktopSettings(force = false): Promise<void> {
  const bridge = window.oneshellDesktop;
  desktopAvailable.value = Boolean(bridge?.isDesktop);
  if (!bridge?.isDesktop) {
    desktopSettings.value = null;
    desktopSettingsLoaded.value = true;
    desktopError.value = '';
    return;
  }
  if (!force && (desktopSettingsLoaded.value || desktopLoading.value)) return;
  desktopError.value = '';
  desktopLoading.value = true;
  try {
    desktopSettings.value = await bridge.getSettings();
    desktopAvailable.value = true;
    desktopSettingsLoaded.value = true;
  } catch (err) {
    desktopError.value = (err as Error).message || '加载桌面设置失败';
  } finally {
    desktopLoading.value = false;
  }
}

async function onDesktopToggle(key: DesktopBooleanKey, event: Event): Promise<void> {
  const bridge = window.oneshellDesktop;
  const checked = (event.target as HTMLInputElement).checked;
  if (!bridge?.isDesktop || !desktopSettings.value) return;
  const previous = { ...desktopSettings.value };
  desktopSettings.value = { ...desktopSettings.value, [key]: checked };
  desktopSaving.value = true;
  desktopError.value = '';
  try {
    desktopSettings.value = await bridge.updateSettings({ [key]: checked });
    notify.success('桌面设置已保存');
  } catch (err) {
    desktopSettings.value = previous;
    desktopError.value = (err as Error).message || '保存桌面设置失败';
  } finally {
    desktopSaving.value = false;
  }
}
</script>

<template>
  <div class="h-screen flex flex-col p-2 gap-2">
    <!-- 顶栏 -->
    <header class="shrink-0 h-14 flex items-center justify-between px-5 bg-shell-panel dark:bg-[#111827] rounded-2xl border border-slate-200 dark:border-[#1e293b] shadow-sm">
      <div class="flex items-center gap-3 shrink-0">
        <span class="w-9 h-9 rounded-xl bg-blue-100 text-blue-600 dark:bg-blue-500/15 dark:text-blue-300 flex items-center justify-center">
          <AppIcon name="cog" :size="20" />
        </span>
        <div>
          <div class="text-base font-bold text-slate-700 dark:text-slate-200">系统设置</div>
          <div class="text-[11px] text-slate-400">账号 · 安全 · 访问控制 · 桌面版</div>
        </div>
      </div>
      <button
        type="button"
        class="h-8 px-3 rounded-lg bg-cyan-500 text-white text-xs font-semibold hover:bg-cyan-600 transition-all cursor-pointer"
        @click="openMcpHub"
      >MCP 与远程接入 →</button>
    </header>

    <!-- 主体：左导航 + 右内容 -->
    <div class="flex-1 min-h-0 flex gap-2">
      <!-- 左侧分区导航 -->
      <nav class="shrink-0 w-56 bg-shell-panel dark:bg-[#111827] rounded-2xl border border-slate-200 dark:border-[#1e293b] shadow-sm p-2 flex flex-col gap-1">
        <button
          v-for="item in TAB_ITEMS"
          :key="item.key"
          type="button"
          class="settings-nav-item cursor-pointer"
          :class="{ 'settings-nav-item--active': tab === item.key }"
          @click="switchTab(item.key)"
        >
          <span class="settings-nav-icon">
            <AppIcon :name="item.icon" :size="17" />
          </span>
          <span class="min-w-0 text-left">
            <span class="block text-[13px] font-semibold leading-tight">{{ item.label }}</span>
            <span class="block text-[10.5px] opacity-70 leading-tight mt-0.5 truncate">{{ item.desc }}</span>
          </span>
        </button>
      </nav>

      <!-- 右侧内容 -->
      <section class="flex-1 min-w-0 bg-shell-panel dark:bg-[#111827] rounded-2xl border border-slate-200 dark:border-[#1e293b] shadow-sm overflow-y-auto">
        <div class="max-w-2xl px-6 py-5">
          <!-- 账号设置 -->
          <form v-if="tab === 'account'" class="flex flex-col gap-4" autocomplete="off" @submit="onSubmit">
            <div class="settings-section-title">账号设置</div>
            <div class="flex flex-col gap-1.5">
              <label class="text-xs font-semibold text-slate-500 dark:text-slate-400">用户名</label>
              <input
                v-model="username"
                type="text"
                placeholder="admin"
                class="w-full h-9 px-3 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-slate-50 text-slate-700 dark:bg-[#0b1324] dark:text-slate-200 text-sm outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-100"
              />
            </div>
            <div class="flex flex-col gap-1.5">
              <label class="text-xs font-semibold text-slate-500 dark:text-slate-400">新访问口令</label>
              <input
                v-model="password"
                type="password"
                placeholder="留空表示不修改"
                autocomplete="new-password"
                class="w-full h-9 px-3 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-slate-50 text-slate-700 dark:bg-[#0b1324] dark:text-slate-200 text-sm outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-100"
              />
            </div>
            <div class="flex flex-col gap-1.5">
              <label class="text-xs font-semibold text-slate-500 dark:text-slate-400">确认新访问口令</label>
              <input
                v-model="passwordConfirm"
                type="password"
                placeholder="再次输入新口令"
                autocomplete="new-password"
                class="w-full h-9 px-3 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-slate-50 text-slate-700 dark:bg-[#0b1324] dark:text-slate-200 text-sm outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-100"
              />
            </div>
            <div class="flex items-center justify-between pt-2 border-t border-slate-100 dark:border-[#1e293b]">
              <div class="text-red-500 text-xs">{{ errorMsg }}</div>
              <button
                type="submit"
                class="h-9 px-5 rounded-lg bg-gradient-to-r from-blue-500 to-blue-600 text-white text-sm font-semibold shadow-md hover:shadow-lg transition-all cursor-pointer"
              >保存设置</button>
            </div>
          </form>

          <!-- IP 访问控制 -->
          <template v-else-if="tab === 'ipfilter'">
            <div class="settings-section-title">IP 访问控制</div>
            <div class="-mx-5 -mb-5">
              <IpFilterTab />
            </div>
          </template>

          <!-- 安全设置 -->
          <form v-else-if="tab === 'security'" class="flex flex-col gap-4" autocomplete="off" @submit="onSecuritySubmit">
            <div class="settings-section-title">安全</div>
            <div v-if="securityLoading" class="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500 dark:border-[#1e293b] dark:bg-[#0b1324] dark:text-slate-400">
              正在加载安全设置…
            </div>

            <!-- 两步验证（2FA） -->
            <div class="rounded-xl border border-slate-200 bg-white/70 p-3 dark:border-[#1e293b] dark:bg-white/[0.03]">
              <div class="flex items-center justify-between gap-3">
                <div>
                  <div class="text-sm font-semibold text-slate-700 dark:text-slate-200">两步验证（2FA）</div>
                  <div class="mt-1 text-xs text-slate-500 dark:text-slate-400">使用 Google Authenticator 等 TOTP 认证器，为登录增加第二道保护。</div>
                </div>
                <span
                  class="shrink-0 rounded-lg px-2.5 py-1 text-xs font-semibold"
                  :class="twofaStatus?.enabled
                    ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-200'
                    : 'bg-slate-100 text-slate-500 dark:bg-white/10 dark:text-slate-300'"
                >{{ twofaStatus?.enabled ? '已开启' : '未开启' }}</span>
              </div>

              <!-- 未开启：生成密钥 → 扫码 → 输入验证码确认 -->
              <template v-if="twofaStatus && !twofaStatus.enabled">
                <div v-if="!twofaSetup" class="mt-3">
                  <button
                    type="button"
                    class="h-9 px-4 rounded-lg border border-blue-200 bg-blue-50 text-xs font-semibold text-blue-600 hover:bg-blue-100 dark:border-blue-500/20 dark:bg-blue-500/10 dark:text-blue-200 disabled:opacity-50 cursor-pointer"
                    :disabled="twofaBusy"
                    @click="onTwofaSetup"
                  >{{ twofaBusy ? '生成中…' : '开启两步验证' }}</button>
                </div>
                <div v-else class="mt-3 flex flex-col gap-3">
                  <div class="flex items-start gap-4">
                    <img v-if="twofaQrDataUrl" :src="twofaQrDataUrl" alt="2FA QR Code" class="w-[140px] h-[140px] rounded-lg border border-slate-200 dark:border-[#1e293b] bg-white p-1" />
                    <div class="flex-1 text-xs text-slate-500 dark:text-slate-400">
                      <p>1. 用 Google Authenticator 等认证器应用扫描二维码；</p>
                      <p class="mt-1">2. 无法扫码时手动输入密钥：</p>
                      <code class="mt-1 block break-all rounded bg-slate-100 px-2 py-1 font-mono text-[11px] text-slate-700 dark:bg-[#0b1324] dark:text-slate-200">{{ twofaSetup.secret }}</code>
                      <p class="mt-1">3. 输入认证器显示的 6 位验证码完成开启。</p>
                    </div>
                  </div>
                  <div class="flex gap-2">
                    <input
                      v-model="twofaCode"
                      type="text"
                      inputmode="numeric"
                      maxlength="6"
                      placeholder="6 位验证码"
                      class="flex-1 h-9 px-3 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-slate-50 text-slate-700 dark:bg-[#0b1324] dark:text-slate-200 text-sm tracking-widest outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-100"
                    />
                    <button
                      type="button"
                      class="h-9 px-4 rounded-lg bg-gradient-to-r from-blue-500 to-blue-600 text-white text-xs font-semibold shadow-md hover:shadow-lg transition-all disabled:opacity-50 cursor-pointer"
                      :disabled="twofaBusy"
                      @click="onTwofaEnable"
                    >{{ twofaBusy ? '验证中…' : '确认开启' }}</button>
                  </div>
                </div>
              </template>

              <!-- 刚开启：一次性展示恢复码 -->
              <div v-if="twofaRecoveryCodes.length" class="mt-3 rounded-xl border border-amber-200 bg-amber-50/70 p-3 dark:border-amber-500/20 dark:bg-amber-500/10">
                <div class="flex items-center justify-between gap-3">
                  <div class="text-xs font-semibold text-amber-700 dark:text-amber-200">一次性恢复码（仅显示这一次，请立即保存）</div>
                  <button
                    type="button"
                    class="h-7 px-2.5 rounded-lg border border-amber-300 text-[11px] font-semibold text-amber-700 hover:bg-amber-100 dark:border-amber-500/30 dark:text-amber-200 cursor-pointer"
                    @click="copyRecoveryCodes"
                  >复制全部</button>
                </div>
                <div class="mt-2 grid grid-cols-2 gap-1 font-mono text-[11px] text-amber-800 dark:text-amber-100">
                  <span v-for="c in twofaRecoveryCodes" :key="c">{{ c }}</span>
                </div>
                <div class="mt-2 text-[11px] text-amber-700/80 dark:text-amber-200/80">每个恢复码只能使用一次，用于丢失认证器时登录或关闭 2FA。</div>
              </div>

              <!-- 已开启：剩余恢复码 + 关闭入口 -->
              <template v-if="twofaStatus?.enabled">
                <div class="mt-3 text-xs text-slate-500 dark:text-slate-400">
                  剩余可用恢复码：{{ twofaStatus.remainingRecoveryCodes ?? 0 }} 个
                  <template v-if="twofaStatus.enabledAt">（开启于 {{ new Date(twofaStatus.enabledAt).toLocaleString() }}）</template>
                </div>
                <div class="mt-2 flex gap-2">
                  <input
                    v-model="twofaDisableCode"
                    type="text"
                    placeholder="验证码或恢复码"
                    class="flex-1 h-9 px-3 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-slate-50 text-slate-700 dark:bg-[#0b1324] dark:text-slate-200 text-sm outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-100"
                  />
                  <button
                    type="button"
                    class="h-9 px-4 rounded-lg border border-red-200 bg-red-50 text-xs font-semibold text-red-600 hover:bg-red-100 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-300 disabled:opacity-50 cursor-pointer"
                    :disabled="twofaBusy"
                    @click="onTwofaDisable"
                  >{{ twofaBusy ? '处理中…' : '关闭两步验证' }}</button>
                </div>
                <div class="mt-1 text-[11px] text-slate-400">关闭后可重新开启以重置密钥和恢复码（即"重置 2FA"）。</div>
              </template>

              <div v-if="twofaError" class="mt-2 text-xs text-red-500">{{ twofaError }}</div>
            </div>

            <div class="rounded-xl border border-amber-200 bg-amber-50/70 px-3 py-2 text-xs text-amber-700 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-200">
              安全默认兼顾个人使用体验和高风险操作保护；如果你要保持当前权限体验，可以关闭 Agent 权限隔离或切到"信任直通"。降级会写入审计。
            </div>

            <div class="flex flex-col gap-1.5">
              <label class="text-xs font-semibold text-slate-500 dark:text-slate-400">安全档位</label>
              <select
                v-model="securityMode"
                class="w-full h-9 px-3 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-slate-50 text-slate-700 dark:bg-[#0b1324] dark:text-slate-200 text-sm outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-100"
              >
                <option v-for="m in securityModes" :key="m" :value="m">{{ SECURITY_MODE_LABELS[m] }}</option>
              </select>
              <div class="text-[11px] text-slate-400">strict：高危需审批/关键风险阻断；trusted：回到更自由的个人使用体验，但灾难命令仍保留红线。</div>
            </div>

            <div class="flex flex-col gap-2">
              <label class="text-xs font-semibold text-slate-500 dark:text-slate-400">命令白名单 / 黑名单</label>
              <div class="rounded-xl border border-slate-200 bg-slate-50 px-3 py-3 dark:border-[#1e293b] dark:bg-[#0b1324]">
                <div class="text-xs text-slate-500 dark:text-slate-400">
                  按命令前缀匹配（支持 <code class="font-mono">docker compose *</code> 式通配）。黑名单无条件拦截整条命令（含包装写法）；白名单逐条豁免命中部分的审批/告警，但<b>豁免不了灾难红线与最高危规则</b>（rm -rf / 等），且只豁免真正命中的部分——命令里夹带的其他操作照常分级。黑名单优先于白名单。
                </div>

                <div v-if="commandRules.length === 0" class="mt-2 text-[11px] text-slate-400">
                  暂无规则。示例：白名单 <code class="font-mono">docker compose *</code> 让外部 agent 在任何挡位下直接执行 compose 常规操作。
                </div>

                <div v-else class="mt-2 flex flex-col gap-1.5">
                  <div
                    v-for="rule in commandRules"
                    :key="rule.id"
                    class="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 dark:border-[#1e293b] dark:bg-[#0f1a30]"
                  >
                    <span
                      class="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold"
                      :class="rule.action === 'deny' ? 'bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300' : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300'"
                    >{{ rule.action === 'deny' ? '黑名单' : '白名单' }}</span>
                    <code class="min-w-0 flex-1 truncate font-mono text-xs text-slate-700 dark:text-slate-200" :title="rule.pattern">{{ rule.pattern }}</code>
                    <span v-if="rule.note" class="hidden sm:block max-w-40 truncate text-[11px] text-slate-400" :title="rule.note">{{ rule.note }}</span>
                    <label class="flex shrink-0 cursor-pointer items-center gap-1 text-[11px] text-slate-500 dark:text-slate-400">
                      <input v-model="rule.enabled" type="checkbox" />
                      启用
                    </label>
                    <button
                      type="button"
                      class="shrink-0 text-xs text-red-500 hover:text-red-600 cursor-pointer"
                      @click="removeCommandRule(rule.id)"
                    >删除</button>
                  </div>
                </div>

                <div class="mt-3 flex flex-wrap gap-2">
                  <select
                    v-model="newRuleAction"
                    class="h-9 rounded-lg border border-slate-200 bg-white px-2 text-sm text-slate-700 outline-none dark:border-[#1e293b] dark:bg-[#0f1a30] dark:text-slate-200"
                  >
                    <option value="allow">白名单（放行）</option>
                    <option value="deny">黑名单（拦截）</option>
                  </select>
                  <input
                    v-model="newRulePattern"
                    type="text"
                    placeholder="命令前缀，如 docker compose * 或 git push --force"
                    class="min-w-48 flex-1 h-9 px-3 rounded-lg border border-slate-200 bg-white font-mono text-sm text-slate-700 outline-none focus:border-blue-400 dark:border-[#1e293b] dark:bg-[#0f1a30] dark:text-slate-200"
                    @keydown.enter.prevent="addCommandRule"
                  />
                  <input
                    v-model="newRuleNote"
                    type="text"
                    placeholder="备注（可选）"
                    class="w-32 h-9 px-3 rounded-lg border border-slate-200 bg-white text-sm text-slate-700 outline-none focus:border-blue-400 dark:border-[#1e293b] dark:bg-[#0f1a30] dark:text-slate-200"
                  />
                  <button
                    type="button"
                    class="h-9 px-3 rounded-lg border border-blue-200 bg-blue-50 text-xs font-semibold text-blue-700 hover:bg-blue-100 dark:border-blue-500/20 dark:bg-blue-500/10 dark:text-blue-200 cursor-pointer"
                    @click="addCommandRule"
                  >添加规则</button>
                </div>
              </div>
            </div>

            <div class="flex flex-col gap-2">
              <label class="text-xs font-semibold text-slate-500 dark:text-slate-400">命令试算</label>
              <div class="rounded-xl border border-slate-200 bg-slate-50 px-3 py-3 dark:border-[#1e293b] dark:bg-[#0b1324]">
                <div class="text-xs text-slate-500 dark:text-slate-400">输入一条命令，按当前挡位 + 规则试算它会被怎么处理（不会真正执行）。</div>
                <div class="mt-2 flex gap-2">
                  <input
                    v-model="ruleEvalCommand"
                    type="text"
                    placeholder="如 sudo docker compose up -d"
                    class="flex-1 h-9 px-3 rounded-lg border border-slate-200 bg-white font-mono text-sm text-slate-700 outline-none focus:border-blue-400 dark:border-[#1e293b] dark:bg-[#0f1a30] dark:text-slate-200"
                    @keydown.enter.prevent="evaluateRuleCommand"
                  />
                  <button
                    type="button"
                    class="h-9 px-3 rounded-lg border border-slate-300 bg-white text-xs font-semibold text-slate-600 hover:bg-slate-100 dark:border-slate-600 dark:bg-[#0f1a30] dark:text-slate-300 disabled:opacity-50 cursor-pointer"
                    :disabled="ruleEvalBusy"
                    @click="evaluateRuleCommand"
                  >{{ ruleEvalBusy ? '…' : '试算' }}</button>
                </div>
                <div v-if="ruleEvalResult" class="mt-2 flex flex-wrap items-center gap-2 text-xs">
                  <span class="rounded px-2 py-0.5 font-bold" :class="ruleEvalBadgeClass(ruleEvalResult.action)">{{ ruleEvalLabel(ruleEvalResult) }}</span>
                  <span v-if="ruleEvalResult.level" class="text-slate-500 dark:text-slate-400">风险等级：{{ ruleEvalResult.level }}</span>
                  <span v-if="ruleEvalResult.reasons.length" class="text-slate-500 dark:text-slate-400">规则：{{ ruleEvalResult.reasons.join('、') }}</span>
                </div>
              </div>
            </div>

            <label class="flex items-start gap-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-3 dark:border-[#1e293b] dark:bg-[#0b1324] cursor-pointer">
              <input v-model="agentPrivilegeIsolation" type="checkbox" class="mt-1" />
              <span>
                <span class="block text-sm font-semibold text-slate-700 dark:text-slate-200">启用 Agent 权限隔离</span>
                <span class="mt-1 block text-xs text-slate-500 dark:text-slate-400">AI 命令会包裹为普通用户执行。关闭后恢复目前 root/当前用户直通权限水平。</span>
              </span>
            </label>

            <div class="flex flex-col gap-1.5">
              <label class="text-xs font-semibold text-slate-500 dark:text-slate-400">Agent 普通用户</label>
              <input
                v-model="agentUser"
                type="text"
                placeholder="oneshell-agent"
                class="w-full h-9 px-3 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-slate-50 text-slate-700 dark:bg-[#0b1324] dark:text-slate-200 text-sm outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-100"
              />
              <div class="text-[11px] text-slate-400">启用前请先在目标 Linux 主机初始化该用户；下方按钮会创建用户并写入只读 sudo 白名单。</div>
            </div>

            <div class="rounded-xl border border-slate-200 bg-white/70 p-3 dark:border-[#1e293b] dark:bg-white/[0.03]">
              <div class="flex items-start justify-between gap-3">
                <div>
                  <div class="text-sm font-semibold text-slate-700 dark:text-slate-200">初始化 Agent 普通用户</div>
                  <div class="mt-1 text-xs text-slate-500 dark:text-slate-400">在目标 Linux 主机上创建用户并写入只读 sudo 白名单。需要当前连接用户具备 root 权限。</div>
                </div>
              </div>
              <div class="mt-3 flex gap-2">
                <input
                  v-model="initHostId"
                  type="text"
                  placeholder="local 或主机 ID"
                  class="flex-1 h-9 px-3 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-slate-50 text-slate-700 dark:bg-[#0b1324] dark:text-slate-200 text-sm outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-100"
                />
                <button
                  type="button"
                  class="h-9 px-3 rounded-lg border border-emerald-200 bg-emerald-50 text-xs font-semibold text-emerald-700 hover:bg-emerald-100 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-200 disabled:opacity-50 cursor-pointer"
                  :disabled="initLoading"
                  @click="onInitAgentUser"
                >{{ initLoading ? '初始化中…' : '初始化' }}</button>
              </div>
              <pre v-if="initResult" class="mt-3 max-h-32 overflow-auto whitespace-pre-wrap rounded-lg bg-slate-950 p-3 text-[11px] text-slate-100">{{ initResult }}</pre>
            </div>

            <div class="flex items-center justify-between pt-2 border-t border-slate-100 dark:border-[#1e293b]">
              <div class="text-red-500 text-xs">{{ securityError }}</div>
              <button
                type="submit"
                class="h-9 px-5 rounded-lg bg-gradient-to-r from-blue-500 to-blue-600 text-white text-sm font-semibold shadow-md hover:shadow-lg transition-all disabled:opacity-50 cursor-pointer"
                :disabled="securitySaving"
              >{{ securitySaving ? '保存中…' : '保存安全设置' }}</button>
            </div>
          </form>

          <!-- 桌面版设置 -->
          <div v-else-if="tab === 'desktop'" class="flex flex-col gap-4">
            <div class="settings-section-title">桌面版</div>
            <div v-if="desktopLoading" class="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500 dark:border-[#1e293b] dark:bg-[#0b1324] dark:text-slate-400">
              正在加载桌面设置…
            </div>

            <div v-else-if="!desktopAvailable" class="rounded-xl border border-slate-200 bg-slate-50 px-3 py-3 text-sm text-slate-600 dark:border-[#1e293b] dark:bg-[#0b1324] dark:text-slate-300">
              仅桌面版可配置。当前浏览器模式不会启用开机自启和窗口关闭后的后台运行。
            </div>

            <template v-else-if="desktopSettings">
              <div class="rounded-xl border border-cyan-200 bg-cyan-50/70 px-3 py-3 dark:border-cyan-500/20 dark:bg-cyan-500/10">
                <div class="flex items-center justify-between gap-3">
                  <div>
                    <div class="text-sm font-semibold text-cyan-800 dark:text-cyan-200">本地服务</div>
                    <div class="mt-1 text-xs text-cyan-700/75 dark:text-cyan-200/75">MCP 与 API 继续通过本机 HTTP 端口提供。</div>
                  </div>
                  <div class="shrink-0 rounded-lg bg-white/70 px-2.5 py-1 text-xs font-semibold text-cyan-700 dark:bg-white/10 dark:text-cyan-200">
                    {{ desktopSettings.serviceRunning ? '运行中' : '未运行' }}
                  </div>
                </div>
                <div class="mt-3 grid grid-cols-1 gap-2 text-xs text-cyan-800 dark:text-cyan-100">
                  <div class="flex items-center justify-between gap-3">
                    <span class="text-cyan-700/70 dark:text-cyan-200/70">端口</span>
                    <span class="font-mono">{{ desktopSettings.port }}</span>
                  </div>
                  <div class="flex items-start justify-between gap-3">
                    <span class="shrink-0 text-cyan-700/70 dark:text-cyan-200/70">地址</span>
                    <span class="break-all font-mono text-right">{{ desktopSettings.url }}</span>
                  </div>
                </div>
              </div>

              <label class="flex items-start gap-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-3 dark:border-[#1e293b] dark:bg-[#0b1324] cursor-pointer">
                <input
                  type="checkbox"
                  class="mt-1"
                  :checked="desktopSettings.startAtLogin"
                  :disabled="desktopSaving"
                  @change="onDesktopToggle('startAtLogin', $event)"
                />
                <span>
                  <span class="block text-sm font-semibold text-slate-700 dark:text-slate-200">开机自启</span>
                  <span class="mt-1 block text-xs text-slate-500 dark:text-slate-400">登录系统后自动启动 1Shell 桌面版。</span>
                </span>
              </label>

              <label class="flex items-start gap-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-3 dark:border-[#1e293b] dark:bg-[#0b1324] cursor-pointer">
                <input
                  type="checkbox"
                  class="mt-1"
                  :checked="desktopSettings.backgroundOnClose"
                  :disabled="desktopSaving"
                  @change="onDesktopToggle('backgroundOnClose', $event)"
                />
                <span>
                  <span class="block text-sm font-semibold text-slate-700 dark:text-slate-200">关闭窗口后后台运行</span>
                  <span class="mt-1 block text-xs text-slate-500 dark:text-slate-400">关闭主窗口时隐藏到托盘，本地 MCP/API 服务继续保留。</span>
                </span>
              </label>

              <label class="flex items-start gap-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-3 dark:border-[#1e293b] dark:bg-[#0b1324] cursor-pointer">
                <input
                  type="checkbox"
                  class="mt-1"
                  :checked="desktopSettings.skipLocalLogin"
                  :disabled="desktopSaving"
                  @change="onDesktopToggle('skipLocalLogin', $event)"
                />
                <span>
                  <span class="block text-sm font-semibold text-slate-700 dark:text-slate-200">本机免登录</span>
                  <span class="mt-1 block text-xs text-slate-500 dark:text-slate-400">桌面窗口打开时自动建立本机会话，跳过登录页。仅对本机窗口生效——浏览器或局域网访问仍需正常登录，下次启动窗口时生效。</span>
                </span>
              </label>

              <div class="rounded-xl border border-slate-200 bg-white/70 px-3 py-3 text-xs text-slate-500 dark:border-[#1e293b] dark:bg-white/[0.03] dark:text-slate-400">
                <div class="flex items-start justify-between gap-3">
                  <span class="shrink-0 font-semibold text-slate-600 dark:text-slate-300">数据目录</span>
                  <span class="break-all text-right font-mono">{{ desktopSettings.dataDir }}</span>
                </div>
                <div class="mt-2 flex items-start justify-between gap-3">
                  <span class="shrink-0 font-semibold text-slate-600 dark:text-slate-300">环境文件</span>
                  <span class="break-all text-right font-mono">{{ desktopSettings.envFile }}</span>
                </div>
              </div>
            </template>

            <div v-else class="rounded-xl border border-red-200 bg-red-50 px-3 py-3 text-sm text-red-600 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-200">
              {{ desktopError || '桌面设置不可用' }}
            </div>

            <div class="flex items-center justify-between pt-2 border-t border-slate-100 dark:border-[#1e293b]">
              <div class="text-red-500 text-xs">{{ desktopError }}</div>
              <button
                type="button"
                class="h-9 px-4 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-white dark:bg-[#1a2332] text-xs font-semibold text-slate-600 dark:text-slate-300 hover:border-blue-300 hover:text-blue-500 transition-all disabled:opacity-50 cursor-pointer"
                :disabled="desktopLoading || desktopSaving"
                @click="loadDesktopSettings(true)"
              >刷新</button>
            </div>
          </div>

          <!-- 关于 / 详情 -->
          <div v-else-if="tab === 'about'" class="flex flex-col gap-4">
            <div class="settings-section-title">关于 / 详情</div>

            <div class="rounded-xl border border-slate-200 bg-slate-50 px-4 py-4 dark:border-[#1e293b] dark:bg-[#0b1324]">
              <div class="flex items-center gap-3">
                <img src="/logo.png" alt="1Shell" class="w-12 h-12 rounded-xl object-cover" />
                <div>
                  <div class="text-base font-semibold text-slate-800 dark:text-slate-100">1Shell</div>
                  <div class="mt-0.5 text-xs text-slate-500 dark:text-slate-400">AI 驱动的 VPS / 服务器管理控制台</div>
                  <div class="mt-1 text-xs font-mono text-slate-500 dark:text-slate-400">
                    v{{ updateState?.currentVersion || APP_VERSION }}
                  </div>
                </div>
              </div>
              <div class="mt-4 flex flex-wrap items-center gap-2">
                <a
                  :href="GITHUB_URL"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="inline-flex items-center gap-2 h-9 px-4 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-white dark:bg-[#1a2332] text-xs font-semibold text-slate-600 dark:text-slate-300 hover:border-blue-300 hover:text-blue-500 transition-all"
                >
                  <AppIcon name="github" :size="16" />
                  1Shell 项目主页
                </a>
                <a
                  :href="VPS_SWITCH_URL"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="inline-flex items-center gap-2 h-9 px-4 rounded-lg bg-gradient-to-r from-sky-500 to-indigo-600 text-white text-xs font-semibold shadow-sm hover:shadow-md transition-all"
                >
                  <AppIcon name="spark" :size="15" />
                  前往全新重构版 VPS Switch →
                </a>
              </div>
              <div class="mt-3 rounded-lg border border-sky-200/80 bg-sky-50/70 px-3 py-2.5 text-xs leading-relaxed text-sky-900 dark:border-sky-500/20 dark:bg-sky-500/10 dark:text-sky-200">
                <b>项目演进通知：</b>1Shell 已进入收官维护阶段（v4.7.8）。全新继任项目 <a :href="VPS_SWITCH_URL" target="_blank" rel="noopener noreferrer" class="font-semibold underline hover:text-sky-600 dark:hover:text-sky-100">VPS Switch</a> 采用 Rust + GPUI 原生硬件加速架构重构，内存占用直降 70%，终端、文件流式传输、精准探针与 MCP Server 全面升级。
              </div>
            </div>
            <!-- 服务端在线更新（binary/docker 部署）-->
            <template v-if="!isDesktopMode && srvUpdate">
              <!-- 版本信息 + 立即检查 -->
              <div class="flex items-center justify-between gap-3">
                <div class="flex items-center gap-2 text-sm font-semibold text-slate-700 dark:text-slate-200">
                  <AppIcon name="spark" :size="16" /> 版本信息
                </div>
                <button
                  type="button"
                  class="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-white dark:bg-[#1a2332] text-xs font-semibold text-slate-600 dark:text-slate-300 hover:border-blue-300 hover:text-blue-500 transition-all disabled:opacity-50 cursor-pointer"
                  :disabled="!!srvBusy"
                  @click="srvCheck"
                >
                  <AppIcon name="history" :size="14" /> {{ srvBusy === 'check' ? '检查中…' : '立即检查' }}
                </button>
              </div>

              <div class="grid grid-cols-2 gap-x-6 gap-y-2 text-xs">
                <div class="flex gap-3">
                  <span class="w-16 shrink-0 text-slate-400">当前版本</span>
                  <span class="font-mono text-slate-700 dark:text-slate-200">v{{ srvUpdate.currentVersion }}</span>
                </div>
                <div class="flex gap-3">
                  <span class="w-16 shrink-0 text-slate-400">最新版本</span>
                  <span class="font-mono" :class="srvUpdate.hasUpdate ? 'text-blue-500 font-semibold' : 'text-slate-700 dark:text-slate-200'">{{ srvUpdate.latestVersion ? 'v' + srvUpdate.latestVersion : '—' }}</span>
                </div>
                <div class="flex gap-3">
                  <span class="w-16 shrink-0 text-slate-400">构建类型</span>
                  <span class="font-mono text-slate-700 dark:text-slate-200">{{ srvUpdate.buildType }}</span>
                </div>
                <div class="flex gap-3">
                  <span class="w-16 shrink-0 text-slate-400">发布时间</span>
                  <span class="font-mono text-slate-700 dark:text-slate-200">{{ srvUpdate.publishedAt ? new Date(srvUpdate.publishedAt).toLocaleString() : '—' }}</span>
                </div>
              </div>

              <!-- 更新日志（折叠）-->
              <div v-if="srvUpdate.releaseNotes" class="rounded-xl border border-slate-200 dark:border-[#1e293b] overflow-hidden">
                <button
                  type="button"
                  class="w-full flex items-center justify-between gap-3 px-3 py-2.5 text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-white/[0.03] cursor-pointer"
                  @click="srvNotesOpen = !srvNotesOpen"
                >
                  <span>查看 v{{ srvUpdate.latestVersion }} 更新内容<span v-if="srvUpdate.releaseName" class="text-slate-400"> — {{ srvUpdate.releaseName }}</span></span>
                  <span class="shrink-0 transition-transform" :class="srvNotesOpen ? 'rotate-180' : ''">⌄</span>
                </button>
                <div v-if="srvNotesOpen" class="max-h-48 overflow-y-auto whitespace-pre-wrap border-t border-slate-200 dark:border-[#1e293b] px-3 py-2 text-[11px] text-slate-500 dark:text-slate-400">{{ srvUpdate.releaseNotes }}</div>
              </div>

              <div class="h-px bg-slate-100 dark:bg-[#1e293b]"></div>

              <!-- 上一版本 / 上次更新 -->
              <div class="flex flex-col gap-1.5 text-xs text-slate-500 dark:text-slate-400">
                <div v-if="srvUpdate.previousVersion">
                  上一版本：<span class="font-mono">v{{ srvUpdate.previousVersion }}</span>
                  <span v-if="srvUpdate.canRollback" class="text-slate-400">（可一键回退）</span>
                </div>
                <div v-if="srvUpdate.lastUpdatedAt">上次更新于：{{ new Date(srvUpdate.lastUpdatedAt).toLocaleString() }}</div>
              </div>

              <!-- 无人值守自动更新 -->
              <div class="flex items-start justify-between gap-3">
                <div>
                  <div class="text-sm font-semibold text-slate-700 dark:text-slate-200">无人值守自动更新</div>
                  <div class="mt-1 text-xs text-slate-500 dark:text-slate-400">开启后服务每天到指定时间自动检查新版本，发现新版即下载{{ srvUpdate.buildType === 'docker' ? '镜像' : '二进制' }}并重启。</div>
                </div>
                <button
                  type="button"
                  role="switch"
                  :aria-checked="srvUpdate.autoUpdate"
                  class="relative shrink-0 mt-1 h-6 w-11 rounded-full transition-colors cursor-pointer"
                  :class="srvUpdate.autoUpdate ? 'bg-blue-500' : 'bg-slate-300 dark:bg-slate-600'"
                  @click="srvToggleAuto(!srvUpdate.autoUpdate)"
                >
                  <span class="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform" :class="srvUpdate.autoUpdate ? 'translate-x-[22px]' : 'translate-x-0.5'"></span>
                </button>
              </div>

              <div class="flex items-center justify-between gap-3" :class="srvUpdate.autoUpdate ? '' : 'opacity-50'">
                <label class="text-xs text-slate-500 dark:text-slate-400">触发时间（本地时区，HH:MM）</label>
                <input
                  type="text"
                  inputmode="numeric"
                  placeholder="03:00"
                  :value="srvUpdate.autoUpdateAt"
                  :disabled="!srvUpdate.autoUpdate"
                  class="w-24 h-8 px-3 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-slate-50 dark:bg-[#0b1324] text-slate-700 dark:text-slate-200 text-sm font-mono text-center outline-none focus:border-blue-400 disabled:cursor-not-allowed"
                  @change="srvSaveAutoAt(($event.target as HTMLInputElement).value)"
                />
              </div>

              <div class="h-px bg-slate-100 dark:bg-[#1e293b]"></div>

              <!-- GitHub Token -->
              <div>
                <div class="flex items-center gap-2 text-sm font-semibold text-slate-700 dark:text-slate-200">
                  <AppIcon name="lock" :size="15" /> GitHub Token
                </div>
                <div class="mt-1 text-xs text-slate-500 dark:text-slate-400">把 GitHub API 限流从匿名 60/小时 提升到认证 5000/小时；只读权限即可。</div>
                <div class="mt-2 flex gap-2">
                  <input
                    v-model="tokenInput"
                    type="password"
                    autocomplete="off"
                    :placeholder="srvUpdate.hasToken ? '已配置 token，输入以替换' : 'ghp_xxxxxxxxxxxx'"
                    class="flex-1 h-9 px-3 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-slate-50 dark:bg-[#0b1324] text-slate-700 dark:text-slate-200 text-sm font-mono outline-none focus:border-blue-400"
                  />
                  <button
                    type="button"
                    class="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-white dark:bg-[#1a2332] text-xs font-semibold text-slate-600 dark:text-slate-300 hover:border-blue-300 hover:text-blue-500 transition-all disabled:opacity-50 cursor-pointer"
                    :disabled="!tokenInput || !!srvBusy"
                    @click="srvVerifyToken"
                  ><AppIcon name="shield" :size="14" /> {{ srvBusy === 'verify' ? '验证中…' : '验证' }}</button>
                  <button
                    type="button"
                    class="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-white dark:bg-[#1a2332] text-xs font-semibold text-slate-600 dark:text-slate-300 hover:border-blue-300 hover:text-blue-500 transition-all disabled:opacity-50 cursor-pointer"
                    :disabled="!tokenInput || !!srvBusy"
                    @click="srvSaveToken"
                  ><AppIcon name="save" :size="14" /> 保存</button>
                </div>
                <div v-if="tokenVerifyMsg" class="mt-1.5 text-[11px] text-slate-500 dark:text-slate-400">{{ tokenVerifyMsg }}</div>
              </div>

              <!-- API 限流 -->
              <div v-if="srvUpdate.rateLimit">
                <div class="flex items-center justify-between gap-3">
                  <div class="flex items-center gap-2 text-xs font-semibold text-slate-600 dark:text-slate-300">
                    <AppIcon name="check" :size="14" /> API 限流
                    <span class="rounded bg-slate-100 dark:bg-[#1e293b] px-1.5 py-0.5 text-[10px] font-normal text-slate-500 dark:text-slate-400">{{ srvUpdate.rateLimit.authenticated ? '已认证' : '匿名' }}</span>
                  </div>
                  <button type="button" class="text-slate-400 hover:text-blue-500 cursor-pointer" title="刷新限流" @click="srvRefreshRate"><AppIcon name="history" :size="14" /></button>
                </div>
                <div class="mt-1.5 text-[11px] text-slate-500 dark:text-slate-400">
                  已用 {{ srvUpdate.rateLimit.used }} / {{ srvUpdate.rateLimit.limit }} · 剩余 {{ srvUpdate.rateLimit.remaining }}
                </div>
                <div class="mt-1 h-1.5 w-full rounded-full bg-slate-200 dark:bg-[#1e293b] overflow-hidden">
                  <div class="h-full rounded-full bg-emerald-500 transition-all" :style="{ width: `${srvUpdate.rateLimit.limit ? Math.min(100, (srvUpdate.rateLimit.used / srvUpdate.rateLimit.limit) * 100) : 0}%` }"></div>
                </div>
                <div v-if="srvUpdate.rateLimit.resetAt" class="mt-1 text-[11px] text-slate-400">重置于：{{ new Date(srvUpdate.rateLimit.resetAt).toLocaleString() }}</div>
              </div>

              <div
                v-if="srvRestarting"
                class="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-700 dark:border-blue-500/20 dark:bg-blue-500/10 dark:text-blue-200"
              >
                {{ srvRestartText }}
              </div>
              <div v-if="srvError" class="text-xs text-red-500">{{ srvError }}</div>
              <div v-else-if="srvUpdate.checkError" class="text-xs text-red-500">检查失败：{{ srvUpdate.checkError }}</div>

              <!-- 底部操作 -->
              <div class="flex items-center justify-between gap-2 pt-2 border-t border-slate-100 dark:border-[#1e293b]">
                <div class="flex gap-2">
                  <button
                    v-if="srvUpdate.buildType === 'docker'"
                    type="button"
                    class="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-white dark:bg-[#1a2332] text-xs font-semibold text-slate-600 dark:text-slate-300 hover:border-blue-300 hover:text-blue-500 transition-all disabled:opacity-50 cursor-pointer"
                    :disabled="!!srvBusy"
                    @click="srvDockerPull"
                  ><AppIcon name="download" :size="14" /> {{ srvBusy === 'docker' ? '拉取中…' : '拉取镜像' }}</button>
                  <button
                    v-if="srvUpdate.canRollback"
                    type="button"
                    class="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-white dark:bg-[#1a2332] text-xs font-semibold text-slate-600 dark:text-slate-300 hover:border-amber-300 hover:text-amber-500 transition-all disabled:opacity-50 cursor-pointer"
                    :disabled="!!srvBusy"
                    @click="srvRollback"
                  ><AppIcon name="history" :size="14" /> {{ srvBusy === 'rollback' ? '回退中…' : '回退到上一版本' }}</button>
                </div>
                <button
                  v-if="srvUpdate.buildType !== 'docker'"
                  type="button"
                  class="inline-flex items-center gap-1.5 h-9 px-4 rounded-lg text-white text-xs font-semibold shadow-md transition-all cursor-pointer"
                  :class="srvUpdate.hasUpdate && !srvBusy ? 'bg-gradient-to-r from-blue-500 to-blue-600 hover:shadow-lg' : 'bg-slate-300 dark:bg-slate-600 cursor-not-allowed'"
                  :disabled="!srvUpdate.hasUpdate || !!srvBusy"
                  @click="srvApply"
                ><AppIcon name="arrow-up" :size="14" /> {{ srvBusy === 'apply' ? '更新中…' : (srvBusy === 'restart' ? '等待重启…' : '更新并重启') }}</button>
              </div>
            </template>

            <!-- 桌面版：检查 / 下载 / 安装 -->
            <div v-else-if="isDesktopMode" class="rounded-xl border border-slate-200 bg-white/70 px-4 py-4 dark:border-[#1e293b] dark:bg-white/[0.03]">
              <div class="flex items-center justify-between gap-3">
                <div>
                  <div class="text-sm font-semibold text-slate-700 dark:text-slate-200">软件更新</div>
                  <div class="mt-1 text-xs text-slate-500 dark:text-slate-400">
                    <template v-if="updateState?.status === 'checking'">正在检查更新…</template>
                    <template v-else-if="updateState?.status === 'available'">发现新版本 v{{ updateState?.version }}</template>
                    <template v-else-if="updateState?.status === 'downloading'">正在下载 {{ updateState?.percent }}%</template>
                    <template v-else-if="updateState?.status === 'downloaded'">v{{ updateState?.version }} 已就绪，重启即可安装</template>
                    <template v-else-if="updateState?.status === 'not-available'">已是最新版本</template>
                    <template v-else-if="updateState?.status === 'error'">检查更新失败</template>
                    <template v-else>点击检查是否有新版本</template>
                  </div>
                </div>
                <div class="shrink-0 flex gap-2">
                  <button
                    v-if="updateState?.status !== 'downloaded'"
                    type="button"
                    class="h-9 px-4 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-white dark:bg-[#1a2332] text-xs font-semibold text-slate-600 dark:text-slate-300 hover:border-blue-300 hover:text-blue-500 transition-all disabled:opacity-50 cursor-pointer"
                    :disabled="updateBusy || updateState?.status === 'checking' || updateState?.status === 'downloading'"
                    @click="onCheckUpdate"
                  >检查更新</button>
                  <button
                    v-if="updateState?.status === 'available'"
                    type="button"
                    class="h-9 px-4 rounded-lg bg-gradient-to-r from-blue-500 to-blue-600 text-white text-xs font-semibold shadow-md hover:shadow-lg transition-all disabled:opacity-50 cursor-pointer"
                    :disabled="updateBusy"
                    @click="onDownloadUpdate"
                  >下载更新</button>
                  <button
                    v-if="updateState?.status === 'downloaded'"
                    type="button"
                    class="h-9 px-4 rounded-lg bg-gradient-to-r from-emerald-500 to-emerald-600 text-white text-xs font-semibold shadow-md hover:shadow-lg transition-all cursor-pointer"
                    @click="onInstallUpdate"
                  >重启并安装</button>
                </div>
              </div>

              <div v-if="updateState?.status === 'downloading'" class="mt-3 h-1.5 w-full rounded-full bg-slate-200 dark:bg-[#1e293b] overflow-hidden">
                <div class="h-full rounded-full bg-blue-500 transition-all" :style="{ width: `${updateState?.percent || 0}%` }"></div>
              </div>

              <div v-if="(updateState?.status === 'available' || updateState?.status === 'downloading' || updateState?.status === 'downloaded') && updateState?.releaseNotes" class="mt-3 max-h-40 overflow-y-auto whitespace-pre-wrap rounded-lg bg-slate-50 dark:bg-[#0b1324] px-3 py-2 text-[11px] text-slate-500 dark:text-slate-400">{{ updateState.releaseNotes }}</div>

              <div class="mt-3 flex items-center justify-between gap-3 rounded-lg border border-sky-200/80 bg-sky-50/70 px-3 py-2 text-xs text-sky-900 dark:border-sky-500/20 dark:bg-sky-500/10 dark:text-sky-200">
                <span>1Shell 桌面版已升级换代为 <b>VPS Switch</b>（Rust + GPUI 原生客户端，内存占用直降 70%）</span>
                <a
                  :href="VPS_SWITCH_URL"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="shrink-0 font-semibold text-sky-600 underline hover:text-sky-500 dark:text-sky-300"
                >前往下载 →</a>
              </div>

              <div v-if="updateState?.status === 'error' && updateState?.error" class="mt-2 text-xs text-red-500">{{ updateState.error }}</div>
            </div>

            <!-- 加载中 -->
            <div v-else class="rounded-xl border border-slate-200 bg-white/70 px-4 py-3 text-xs text-slate-500 dark:border-[#1e293b] dark:bg-white/[0.03] dark:text-slate-400">
              正在加载更新状态…
            </div>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.settings-section-title {
  font-size: 15px;
  font-weight: 700;
  color: #334155;
}
html.dark .settings-section-title {
  color: #e2e8f0;
}

.settings-nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 10px;
  border-radius: 12px;
  border: 1px solid transparent;
  color: #64748b;
  transition: background-color 0.15s ease, color 0.15s ease, border-color 0.15s ease;
}
.settings-nav-item:hover {
  background: rgba(59, 130, 246, 0.06);
  color: #2563eb;
}
.settings-nav-item--active {
  background: rgba(59, 130, 246, 0.1);
  border-color: rgba(59, 130, 246, 0.25);
  color: #2563eb;
}
html.dark .settings-nav-item {
  color: #94a3b8;
}
html.dark .settings-nav-item:hover {
  background: rgba(56, 189, 248, 0.08);
  color: #7dd3fc;
}
html.dark .settings-nav-item--active {
  background: rgba(56, 189, 248, 0.12);
  border-color: rgba(56, 189, 248, 0.3);
  color: #7dd3fc;
}

.settings-nav-icon {
  flex-shrink: 0;
  width: 30px;
  height: 30px;
  border-radius: 9px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: rgba(100, 116, 139, 0.08);
}
.settings-nav-item--active .settings-nav-icon {
  background: rgba(59, 130, 246, 0.14);
}
html.dark .settings-nav-icon {
  background: rgba(148, 163, 184, 0.08);
}
html.dark .settings-nav-item--active .settings-nav-icon {
  background: rgba(56, 189, 248, 0.15);
}
</style>
