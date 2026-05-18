// useFileBrowser.ts — MainConsole 刀 3 阶段 2 · 文件浏览器
// 1:1 复刻 [public/file-browser.js](public/file-browser.js)（599 行）
// 单例：currentPath / items / 缓存 60s/50 LRU / 预览 + 编辑 / 上传 multipart / 下载 a.href / 写入

import { reactive, ref, watch, type Ref } from 'vue';

import { useApiClient } from '@/composables/useApiClient';
import { useSessionTerminal } from '@/composables/useSessionTerminal';
import { useNotifyStore } from '@/stores/notify';
import { LOCAL_HOST_ID } from '@/utils/mainConsole';

export interface DirItem {
  name: string;
  path: string;
  isDir: boolean;
  isDrive?: boolean;
  size?: number;
}

export interface DirListResponse {
  items: DirItem[];
  path: string;
  parent?: string;
  isRoot?: boolean;
}

interface ReadFileResponse {
  content: string;
  size: number;
}

interface CacheEntry {
  data: DirListResponse;
  ts: number;
}

const DIR_CACHE_TTL_MS = 60_000;
const DIR_CACHE_MAX = 50;

const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp'];

export interface PreviewState {
  open: boolean;
  filePath: string;
  fileName: string;
  isImage: boolean;
  loading: boolean;
  content: string;
  imageUrl: string;
  error: string;
  mode: 'view' | 'edit';
  editValue: string;
  saving: boolean;
  saveError: string;
}

export interface FileBrowserApi {
  readonly currentPath: Ref<string>;
  readonly items: Ref<DirItem[]>;
  readonly parent: Ref<string>;
  readonly isRoot: Ref<boolean>;
  readonly isWindows: Ref<boolean>;
  readonly loading: Ref<boolean>;
  readonly error: Ref<string>;
  readonly showHidden: Ref<boolean>;
  readonly hiddenCount: Ref<number>;
  readonly preview: PreviewState;

  initialize(): void;
  loadDir(path: string, opts?: { skipCache?: boolean }): Promise<void>;
  navigate(path: string): void;
  goBack(): void;
  refreshCurrent(): void;
  toggleHidden(): void;
  showUploadDialog(): void;
  downloadFile(filePath: string): void;
  openPreview(filePath: string): Promise<void>;
  closePreview(): void;
  copyPreviewPath(): void;
  startEdit(): void;
  cancelEdit(): void;
  saveEdit(): Promise<void>;
}

let _instance: FileBrowserApi | null = null;

export function useFileBrowser(): FileBrowserApi {
  if (!_instance) _instance = create();
  return _instance;
}

export function _resetFileBrowserSingleton(): void {
  _instance = null;
}

function getCsrfToken(): string {
  const m = document.cookie.match(/(?:^|;\s*)mvps_csrf_token=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : '';
}

function isImageFile(name: string): boolean {
  const ext = (name.split('.').pop() || '').toLowerCase();
  return IMAGE_EXTS.includes(ext);
}

function create(): FileBrowserApi {
  const { requestJson } = useApiClient();
  const sessionTerminal = useSessionTerminal();
  const notify = useNotifyStore();

  const currentPath = ref('');
  const items = ref<DirItem[]>([]);
  const parent = ref('');
  const isRoot = ref(false);
  const isWindows = ref(false);
  const loading = ref(false);
  const error = ref('');
  const showHidden = ref(true);
  const hiddenCount = ref(0);

  const preview = reactive<PreviewState>({
    open: false,
    filePath: '',
    fileName: '',
    isImage: false,
    loading: false,
    content: '',
    imageUrl: '',
    error: '',
    mode: 'view',
    editValue: '',
    saving: false,
    saveError: '',
  });

  let currentHostId = '';
  const dirCache = new Map<string, CacheEntry>();
  const hostSnapshots = new Map<string, DirListResponse>();
  let initialized = false;
  let escListener: ((e: KeyboardEvent) => void) | null = null;
  let lastBlobUrl = '';

  function cacheKey(hostId: string, path: string): string {
    return `${hostId}:${path || ''}`;
  }

  function getCached(hostId: string, path: string): DirListResponse | null {
    const entry = dirCache.get(cacheKey(hostId, path));
    if (!entry) return null;
    if (Date.now() - entry.ts > DIR_CACHE_TTL_MS) {
      dirCache.delete(cacheKey(hostId, path));
      return null;
    }
    return entry.data;
  }

  function setCached(hostId: string, path: string, data: DirListResponse): void {
    if (dirCache.size >= DIR_CACHE_MAX) {
      const oldest = dirCache.keys().next().value;
      if (oldest) dirCache.delete(oldest);
    }
    dirCache.set(cacheKey(hostId, path), { data, ts: Date.now() });
  }

  function invalidateHostCache(hostId: string): void {
    if (!hostId) return;
    for (const key of [...dirCache.keys()]) {
      if (key.startsWith(`${hostId}:`)) dirCache.delete(key);
    }
    hostSnapshots.delete(hostId);
  }

  function makeSnapshot(): DirListResponse {
    return {
      path: currentPath.value,
      parent: parent.value,
      isRoot: isRoot.value,
      items: items.value,
    };
  }

  function saveHostSnapshot(hostId: string): void {
    if (!hostId) return;
    hostSnapshots.set(hostId, makeSnapshot());
  }

  function restoreHostSnapshot(hostId: string): boolean {
    const snapshot = hostSnapshots.get(hostId);
    if (!snapshot) return false;
    applyData(snapshot);
    return true;
  }

  function applyData(data: DirListResponse): void {
    const path = data.path || '';
    currentPath.value = path;
    items.value = data.items || [];
    parent.value = data.parent || '';
    isRoot.value = Boolean(data.isRoot);
    isWindows.value = path.includes(':') || path.includes('\\') || path === '此电脑';
    error.value = '';

    // 计算隐藏文件数量
    const total = (data.items || []).length;
    const visible = showHidden.value
      ? total
      : (data.items || []).filter((i) => !i.name.startsWith('.')).length;
    hiddenCount.value = total - visible;
    if (currentHostId) hostSnapshots.set(currentHostId, data);
  }

  function getHostId(): string {
    return sessionTerminal.activeHostId.value || LOCAL_HOST_ID;
  }

  async function loadDir(dirPath: string, opts: { skipCache?: boolean } = {}): Promise<void> {
    const hostId = getHostId();
    const requestPath = dirPath === '此电脑' ? '' : dirPath;
    currentHostId = hostId;

    if (!opts.skipCache && requestPath !== '__drives__') {
      const cached = getCached(hostId, requestPath);
      if (cached) {
        applyData(cached);
        return;
      }
    }

    loading.value = true;
    error.value = '';

    try {
      const params = new URLSearchParams({ hostId });
      if (requestPath && requestPath !== '__drives__') params.set('path', requestPath);
      const data = await requestJson<DirListResponse>(`/api/files/list?${params}`);
      if (currentHostId !== hostId) return;
      setCached(hostId, requestPath, data);
      applyData(data);
    } catch (err) {
      if (currentHostId !== hostId) return;
      error.value = (err as Error).message || '加载失败';
    } finally {
      if (currentHostId === hostId) loading.value = false;
    }
  }

  function navigate(path: string): void {
    void loadDir(path);
  }

  function goBack(): void {
    if (parent.value) void loadDir(parent.value);
  }

  function refreshCurrent(): void {
    invalidateHostCache(currentHostId);
    void loadDir(currentPath.value, { skipCache: true });
  }

  function switchHost(hostId: string, previousHostId = currentHostId): void {
    if (previousHostId && previousHostId !== hostId) saveHostSnapshot(previousHostId);
    currentHostId = hostId;
    closePreview();

    const restored = restoreHostSnapshot(hostId);
    if (!restored) {
      items.value = [];
      currentPath.value = '';
      parent.value = '';
      isRoot.value = false;
      isWindows.value = false;
      hiddenCount.value = 0;
      error.value = '';
    }

    void loadDir(restored ? currentPath.value : '');
  }

  function toggleHidden(): void {
    showHidden.value = !showHidden.value;
    // 重新计算隐藏计数
    const total = items.value.length;
    const visible = showHidden.value
      ? total
      : items.value.filter((i) => !i.name.startsWith('.')).length;
    hiddenCount.value = total - visible;
  }

  function downloadFile(filePath: string): void {
    if (!filePath) return;
    const hostId = getHostId();
    const params = new URLSearchParams({ hostId, path: filePath });
    const a = document.createElement('a');
    a.href = `/api/files/download?${params}`;
    a.download = '';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function showUploadDialog(): void {
    if (!currentPath.value || currentPath.value === '此电脑') {
      notify.warn('请先进入一个目录');
      return;
    }
    const hostId = getHostId();
    const dirPath = currentPath.value;
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.addEventListener('change', async () => {
      if (!input.files || input.files.length === 0) return;
      for (const file of Array.from(input.files)) {
        try {
          const formData = new FormData();
          formData.append('hostId', hostId);
          formData.append('dirPath', dirPath);
          formData.append('file', file);
          const csrf = getCsrfToken();
          const resp = await fetch('/api/files/upload', {
            method: 'POST',
            headers: csrf ? { 'x-csrf-token': csrf } : {},
            body: formData,
          });
          if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            throw new Error((err as { error?: string }).error || `上传失败 (${resp.status})`);
          }
          notify.success(`${file.name} 上传成功`);
        } catch (err) {
          notify.error(`${file.name} 上传失败: ${(err as Error).message}`);
        }
      }
      dirCache.delete(cacheKey(hostId, dirPath));
      void loadDir(dirPath, { skipCache: true });
    });
    input.click();
  }

  function clearBlobUrl(): void {
    if (lastBlobUrl) {
      URL.revokeObjectURL(lastBlobUrl);
      lastBlobUrl = '';
    }
  }

  function copyPreviewPath(): void {
    if (!preview.filePath) return;
    navigator.clipboard?.writeText(preview.filePath).then(() => {
      notify.success('路径已复制');
    }).catch(() => { /* 静默 */ });
  }

  async function openPreview(filePath: string): Promise<void> {
    closePreview();
    const hostId = getHostId();
    const fileName = filePath.split(/[\\/]/).pop() || filePath;
    const isImg = isImageFile(fileName);
    preview.open = true;
    preview.filePath = filePath;
    preview.fileName = fileName;
    preview.isImage = isImg;
    preview.loading = true;
    preview.content = '';
    preview.imageUrl = '';
    preview.error = '';
    preview.mode = 'view';
    preview.editValue = '';
    preview.saving = false;
    preview.saveError = '';

    try {
      if (isImg) {
        const params = new URLSearchParams({ hostId, path: filePath });
        const resp = await fetch(`/api/files/download?${params}`);
        if (!resp.ok) throw new Error('加载失败');
        const blob = await resp.blob();
        const url = URL.createObjectURL(blob);
        lastBlobUrl = url;
        preview.imageUrl = url;
      } else {
        const params = new URLSearchParams({ hostId, path: filePath });
        const data = await requestJson<ReadFileResponse>(`/api/files/read?${params}`);
        preview.content = data.content || '';
      }
    } catch (err) {
      preview.error = (err as Error).message || '读取失败';
    } finally {
      preview.loading = false;
    }
  }

  function closePreview(): void {
    preview.open = false;
    preview.filePath = '';
    preview.fileName = '';
    preview.content = '';
    preview.imageUrl = '';
    preview.error = '';
    preview.mode = 'view';
    preview.editValue = '';
    preview.saveError = '';
    clearBlobUrl();
  }

  function startEdit(): void {
    if (preview.isImage || preview.loading) return;
    preview.mode = 'edit';
    preview.editValue = preview.content;
    preview.saveError = '';
  }

  function cancelEdit(): void {
    preview.mode = 'view';
    preview.editValue = '';
    preview.saveError = '';
  }

  async function saveEdit(): Promise<void> {
    if (preview.saving) return;
    const hostId = getHostId();
    preview.saving = true;
    preview.saveError = '';
    try {
      await requestJson('/api/files/write', {
        method: 'POST',
        body: JSON.stringify({ hostId, path: preview.filePath, content: preview.editValue }),
      });
      preview.content = preview.editValue;
      preview.mode = 'view';
      if (currentPath.value) {
        dirCache.delete(cacheKey(hostId, currentPath.value));
      }
      notify.success('保存成功');
    } catch (err) {
      preview.saveError = `保存失败: ${(err as Error).message}`;
    } finally {
      preview.saving = false;
    }
  }

  function initialize(): void {
    if (initialized) return;
    initialized = true;

    watch(sessionTerminal.activeHostId, (newId, oldId) => {
      switchHost(newId || LOCAL_HOST_ID, oldId || currentHostId);
    }, { flush: 'post' });

    // ESC 关预览
    escListener = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && preview.open) closePreview();
    };
    document.addEventListener('keydown', escListener);

    // 首次加载
    void loadDir('');
  }

  return {
    currentPath,
    items,
    parent,
    isRoot,
    isWindows,
    loading,
    error,
    showHidden,
    hiddenCount,
    preview,
    initialize,
    loadDir,
    navigate,
    goBack,
    refreshCurrent,
    toggleHidden,
    showUploadDialog,
    downloadFile,
    openPreview,
    closePreview,
    copyPreviewPath,
    startEdit,
    cancelEdit,
    saveEdit,
  };
}
