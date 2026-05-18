<script setup lang="ts">
// 主机编辑 modal — 老 [public/index.html#L701-L792](public/index.html#L701-L792) + [public/hosts.js#L36-L267](public/hosts.js#L36-L267) 1:1
// 密码/私钥 authType 切换；编辑时密码/私钥/passphrase 留空 = 不修改；local host 只保存 name + links
import { ref, computed, watch } from 'vue';
import type { MainHost, HostLink, HostAuthType, HostFormPayload } from '@/utils/mainConsole';
import { isLocalHost, LOCAL_HOST_ID } from '@/utils/mainConsole';

interface Props {
  open: boolean;
  editing: MainHost | null;
  /** 所有 ssh 主机（用于 proxy 下拉，过滤掉自己和已有 proxy 的） */
  sshHosts: MainHost[];
}
const props = defineProps<Props>();
const emit = defineEmits<{
  close: [];
  submit: [payload: HostFormPayload | { isLocal: true; name: string; links: HostLink[] }, hostId: string | null];
}>();

const name = ref('');
const address = ref('');
const port = ref(22);
const username = ref('');
const password = ref('');
const privateKey = ref('');
const passphrase = ref('');
const proxyHostId = ref<string>('');
const authType = ref<HostAuthType>('password');
const linkRows = ref<HostLink[]>([{ name: '', url: '', description: '' }]);
const errorMsg = ref('');

const isEditing = computed(() => !!props.editing?.id);
const editingIsLocal = computed(() => isLocalHost(props.editing));

const proxyOptions = computed(() =>
  props.sshHosts.filter((h) => h.id !== props.editing?.id && !h.proxyHostId)
);

watch(() => [props.open, props.editing] as const, ([open, host]) => {
  if (!open) return;
  errorMsg.value = '';
  if (host) {
    name.value = host.name || '';
    address.value = host.host || '';
    port.value = host.port || 22;
    username.value = host.username || '';
    proxyHostId.value = host.proxyHostId || '';
    authType.value = host.authType === 'privateKey' ? 'privateKey' : 'password';
    const links = (host.links && host.links.length) ? host.links : [{ name: '', url: '', description: '' }];
    linkRows.value = links.map((l) => ({ ...l }));
  } else {
    name.value = '';
    address.value = '';
    port.value = 22;
    username.value = '';
    proxyHostId.value = '';
    authType.value = 'password';
    linkRows.value = [{ name: '', url: '', description: '' }];
  }
  password.value = '';
  privateKey.value = '';
  passphrase.value = '';
}, { immediate: true });

function addLink(): void {
  linkRows.value = [...linkRows.value, { name: '', url: '', description: '' }];
}

function removeLink(idx: number): void {
  linkRows.value = linkRows.value.filter((_, i) => i !== idx);
  if (!linkRows.value.length) linkRows.value = [{ name: '', url: '', description: '' }];
}

function onSubmit(e: Event): void {
  e.preventDefault();
  errorMsg.value = '';

  const collectedLinks = linkRows.value
    .filter((l) => l.name?.trim() || l.url?.trim() || l.description?.trim())
    .map((l) => ({
      id: l.id || '',
      name: (l.name || '').trim(),
      url: (l.url || '').trim(),
      description: (l.description || '').trim(),
    }));

  if (editingIsLocal.value) {
    emit('submit', { isLocal: true, name: name.value.trim(), links: collectedLinks }, LOCAL_HOST_ID);
    return;
  }

  const payload: HostFormPayload = {
    name: name.value.trim(),
    host: address.value.trim(),
    port: Number(port.value) || 22,
    username: username.value.trim(),
    authType: authType.value,
    proxyHostId: proxyHostId.value || null,
    links: collectedLinks,
  };

  if (authType.value === 'password') {
    if (!isEditing.value || password.value) payload.password = password.value;
  } else {
    if (!isEditing.value || privateKey.value.trim()) payload.privateKey = privateKey.value;
    if (!isEditing.value || passphrase.value) payload.passphrase = passphrase.value;
  }

  emit('submit', payload, isEditing.value ? props.editing!.id : null);
}

function setError(msg: string): void {
  errorMsg.value = msg;
}
defineExpose({ setError });
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="modal-overlay fixed inset-0 z-[2000] flex items-center justify-center bg-black/50 backdrop-blur-sm"
      @click.self="emit('close')"
    >
      <div class="modal-box w-full max-w-xl max-h-[calc(100vh-48px)] overflow-y-auto bg-white dark:bg-[#111827] rounded-2xl shadow-2xl border border-slate-200 dark:border-[#1e293b]">
        <div class="modal-header flex items-center justify-between px-5 py-3.5 border-b border-slate-100 dark:border-[#1e293b]">
          <div>
            <div class="modal-title text-base font-bold text-slate-700 dark:text-slate-200">{{ isEditing ? '编辑主机' : '新增主机' }}</div>
            <div class="text-xs text-slate-400 mt-0.5">保存后可直接从左侧切换到该主机</div>
          </div>
          <button
            class="icon-btn h-7 px-2.5 rounded-lg border border-slate-200 dark:border-[#1e293b] text-xs text-slate-500 dark:text-slate-300 hover:text-red-500 hover:border-red-200 transition-all"
            type="button"
            @click="emit('close')"
          >关闭</button>
        </div>

        <form class="p-5 flex flex-col gap-4" autocomplete="off" @submit="onSubmit">
          <div class="flex gap-3">
            <div class="flex-1 flex flex-col gap-1.5">
              <label class="text-xs font-semibold text-slate-500 dark:text-slate-400">主机名称</label>
              <input
                v-model="name"
                type="text"
                placeholder="例如：东京节点"
                required
                autocomplete="off"
                class="w-full h-9 px-3 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-slate-50 dark:bg-[#0b1324] dark:text-slate-200 text-sm outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-100"
              />
            </div>
            <div v-if="!editingIsLocal" class="flex-1 flex flex-col gap-1.5">
              <label class="text-xs font-semibold text-slate-500 dark:text-slate-400">用户名</label>
              <input
                v-model="username"
                type="text"
                placeholder="root"
                required
                autocomplete="username"
                class="w-full h-9 px-3 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-slate-50 dark:bg-[#0b1324] dark:text-slate-200 text-sm outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-100"
              />
            </div>
          </div>

          <template v-if="!editingIsLocal">
            <div class="flex gap-3">
              <div class="flex-1 flex flex-col gap-1.5">
                <label class="text-xs font-semibold text-slate-500 dark:text-slate-400">主机地址</label>
                <input
                  v-model="address"
                  type="text"
                  placeholder="example.com 或 1.2.3.4"
                  required
                  class="w-full h-9 px-3 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-slate-50 dark:bg-[#0b1324] dark:text-slate-200 text-sm outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-100"
                />
              </div>
              <div class="flex-1 flex flex-col gap-1.5">
                <label class="text-xs font-semibold text-slate-500 dark:text-slate-400">端口</label>
                <input
                  v-model.number="port"
                  type="number"
                  min="1"
                  max="65535"
                  required
                  class="w-full h-9 px-3 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-slate-50 dark:bg-[#0b1324] dark:text-slate-200 text-sm outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-100"
                />
              </div>
            </div>

            <div class="flex flex-col gap-1.5">
              <label class="text-xs font-semibold text-slate-500 dark:text-slate-400">中继跳板 (ProxyJump)</label>
              <select
                v-model="proxyHostId"
                class="w-full h-9 px-3 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-slate-50 dark:bg-[#0b1324] dark:text-slate-200 text-sm outline-none cursor-pointer focus:border-blue-400"
              >
                <option value="">直连（无跳板）</option>
                <option v-for="h in proxyOptions" :key="h.id" :value="h.id">{{ h.name }} ({{ h.host }})</option>
              </select>
              <div class="text-[11px] text-slate-400">如目标机在 NAT 内网，选择一台公网主机作为跳板。</div>
            </div>

            <div class="flex flex-col gap-1.5">
              <label class="text-xs font-semibold text-slate-500 dark:text-slate-400">认证方式</label>
              <div class="flex gap-2">
                <button
                  type="button"
                  class="h-8 px-3 rounded-lg text-xs font-semibold transition-all"
                  :class="authType === 'password' ? 'bg-blue-500 text-white' : 'border border-slate-200 dark:border-[#1e293b] text-slate-500 dark:text-slate-300'"
                  @click="authType = 'password'"
                >密码</button>
                <button
                  type="button"
                  class="h-8 px-3 rounded-lg text-xs font-semibold transition-all"
                  :class="authType === 'privateKey' ? 'bg-blue-500 text-white' : 'border border-slate-200 dark:border-[#1e293b] text-slate-500 dark:text-slate-300'"
                  @click="authType = 'privateKey'"
                >私钥</button>
              </div>
            </div>

            <div v-if="authType === 'password'" class="flex flex-col gap-1.5">
              <label class="text-xs font-semibold text-slate-500 dark:text-slate-400">密码</label>
              <input
                v-model="password"
                type="password"
                :placeholder="isEditing ? '编辑时留空表示保持不变' : '请输入密码'"
                autocomplete="new-password"
                class="w-full h-9 px-3 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-slate-50 dark:bg-[#0b1324] dark:text-slate-200 text-sm outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-100"
              />
            </div>

            <div v-else class="flex flex-col gap-3">
              <div class="flex flex-col gap-1.5">
                <label class="text-xs font-semibold text-slate-500 dark:text-slate-400">私钥内容</label>
                <textarea
                  v-model="privateKey"
                  rows="5"
                  :placeholder="isEditing ? '编辑时留空表示保持不变' : '粘贴私钥（PEM 格式）'"
                  class="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-slate-50 dark:bg-[#0b1324] dark:text-slate-200 text-sm outline-none resize-y font-mono focus:border-blue-400 focus:ring-1 focus:ring-blue-100"
                ></textarea>
              </div>
              <div class="flex flex-col gap-1.5">
                <label class="text-xs font-semibold text-slate-500 dark:text-slate-400">私钥口令</label>
                <input
                  v-model="passphrase"
                  type="password"
                  :placeholder="isEditing ? '可选，编辑时留空表示保持不变' : '可选'"
                  autocomplete="new-password"
                  class="w-full h-9 px-3 rounded-lg border border-slate-200 dark:border-[#1e293b] bg-slate-50 dark:bg-[#0b1324] dark:text-slate-200 text-sm outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-100"
                />
              </div>
            </div>
          </template>

          <!-- 快捷链接 -->
          <div class="flex flex-col gap-1.5">
            <label class="text-xs font-semibold text-slate-500 dark:text-slate-400">快捷跳转</label>
            <div class="flex flex-col gap-2">
              <div
                v-for="(lk, idx) in linkRows"
                :key="idx"
                class="rounded-lg border border-slate-200 dark:border-[#1e293b] p-2 flex flex-col gap-2"
              >
                <div class="flex gap-2">
                  <input
                    v-model="lk.name"
                    type="text"
                    placeholder="链接名称"
                    class="flex-1 h-8 px-2 rounded border border-slate-200 dark:border-[#1e293b] bg-slate-50 dark:bg-[#0b1324] dark:text-slate-200 text-xs outline-none focus:border-blue-400"
                  />
                  <input
                    v-model="lk.url"
                    type="text"
                    placeholder="https://..."
                    class="flex-1 h-8 px-2 rounded border border-slate-200 dark:border-[#1e293b] bg-slate-50 dark:bg-[#0b1324] dark:text-slate-200 text-xs outline-none focus:border-blue-400"
                  />
                </div>
                <div class="flex gap-2 items-center">
                  <input
                    v-model="lk.description"
                    type="text"
                    placeholder="描述（可选）"
                    class="flex-1 h-8 px-2 rounded border border-slate-200 dark:border-[#1e293b] bg-slate-50 dark:bg-[#0b1324] dark:text-slate-200 text-xs outline-none focus:border-blue-400"
                  />
                  <button
                    type="button"
                    class="h-8 px-2 rounded border border-slate-200 dark:border-[#1e293b] text-[11px] text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20"
                    @click="removeLink(idx)"
                  >删除链接</button>
                </div>
              </div>
            </div>
            <button
              type="button"
              class="self-start h-7 px-3 rounded-lg border border-slate-200 dark:border-[#1e293b] text-xs text-slate-500 dark:text-slate-300 hover:border-blue-300 hover:text-blue-500 transition-all"
              @click="addLink"
            >新增链接</button>
            <div class="text-[11px] text-slate-400">仅支持 http:// 或 https://，保存后会显示在主机卡片中。</div>
          </div>

          <div class="flex items-center justify-between pt-2 border-t border-slate-100 dark:border-[#1e293b]">
            <div class="text-red-500 text-xs">{{ errorMsg }}</div>
            <button
              type="submit"
              class="h-9 px-5 rounded-lg bg-gradient-to-r from-blue-500 to-blue-600 text-white text-sm font-semibold shadow-md hover:shadow-lg transition-all"
            >保存主机</button>
          </div>
        </form>
      </div>
    </div>
  </Teleport>
</template>
