<script setup lang="ts">
// FileBrowserPanel.vue — MainConsole 刀 3 阶段 2 · 文件浏览器面板
// 1:1 复刻 [public/file-browser.js](public/file-browser.js) + [public/index.html](public/index.html) #file-tree
// 占左栏 aside 内 flex:5 块 (HostListSidebar 之下),自身容器内滚动,不外溢
import { computed, onBeforeUnmount, onMounted } from 'vue';

import { useFileBrowser, type DirItem } from '@/composables/useFileBrowser';

const fb = useFileBrowser();

onMounted(() => { fb.initialize(); });
onBeforeUnmount(() => { fb.closePreview(); });

// 显示项：showHidden 决定是否过滤 .开头
const visibleItems = computed<DirItem[]>(() => {
  if (fb.showHidden.value) return fb.items.value;
  return fb.items.value.filter((i) => !i.name.startsWith('.'));
});
const dirCount = computed(() => visibleItems.value.filter((i) => i.isDir).length);
const fileCount = computed(() => visibleItems.value.length - dirCount.value);

// 面包屑分段（Windows / Linux 分别处理）
interface Crumb {
  label: string;
  path: string;
  active: boolean;
  isDrives?: boolean;
}
const crumbs = computed<Crumb[]>(() => {
  const path = fb.currentPath.value;
  if (path === '此电脑') {
    return [{ label: '此电脑', path: '__drives__', active: true }];
  }
  if (fb.isWindows.value) {
    const list: Crumb[] = [{ label: '此电脑', path: '__drives__', active: false, isDrives: true }];
    const normalized = path.replace(/\\/g, '/');
    const parts = normalized.split('/').filter(Boolean);
    if (!parts.length) return list;
    let accumulated = parts[0] + '/';
    list.push({
      label: parts[0],
      path: accumulated.replace(/\//g, '\\'),
      active: parts.length === 1,
    });
    for (let i = 1; i < parts.length; i += 1) {
      accumulated += parts[i] + '/';
      list.push({
        label: parts[i],
        path: accumulated.replace(/\//g, '\\'),
        active: i === parts.length - 1,
      });
    }
    return list;
  }
  // Linux
  const parts = path.split('/').filter(Boolean);
  const list: Crumb[] = [{ label: '/', path: '/', active: parts.length === 0 }];
  let accumulated = '/';
  for (let i = 0; i < parts.length; i += 1) {
    accumulated += parts[i] + '/';
    list.push({
      label: parts[i],
      path: accumulated,
      active: i === parts.length - 1,
    });
  }
  return list;
});

function fileIcon(name: string, isDir: boolean): string {
  if (isDir) return '📁';
  const ext = (name.split('.').pop() || '').toLowerCase();
  const map: Record<string, string> = {
    js: '🟨', ts: '🔷', json: '📋', md: '📝', txt: '📄',
    sh: '⚙️', bash: '⚙️', py: '🐍', html: '🌐', css: '🎨',
    yml: '📦', yaml: '📦', xml: '📰', sql: '🗃️',
    png: '🖼️', jpg: '🖼️', jpeg: '🖼️', gif: '🖼️', svg: '🖼️',
    zip: '📦', gz: '📦', tar: '📦',
    log: '📜', env: '🔒', conf: '⚙️', cfg: '⚙️',
  };
  return map[ext] || '📄';
}

function formatSize(bytes: number | undefined): string {
  if (!bytes || bytes === 0) return '--';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

function onItemClick(item: DirItem): void {
  if (item.isDir || item.isDrive) {
    fb.navigate(item.path);
  } else {
    void fb.openPreview(item.path);
  }
}

function onDownloadClick(event: MouseEvent, item: DirItem): void {
  event.stopPropagation();
  fb.downloadFile(item.path);
}

function onMaskClick(event: MouseEvent): void {
  if (event.target === event.currentTarget) fb.closePreview();
}
</script>

<template>
  <div class="file-browser">
    <!-- toolbar -->
    <div class="fb-toolbar">
      <span class="fb-toolbar-title">文件浏览</span>
      <div class="fb-toolbar-actions">
        <button
          type="button"
          class="fb-mini-btn"
          :class="{ active: fb.showHidden.value }"
          title="显示/隐藏隐藏文件"
          @click="fb.toggleHidden"
        >.*</button>
        <button
          type="button"
          class="fb-mini-btn"
          title="刷新当前目录"
          @click="fb.refreshCurrent"
        >⟳</button>
        <button
          type="button"
          class="fb-mini-btn"
          title="上传文件到当前目录"
          @click="fb.showUploadDialog"
        >↑</button>
      </div>
    </div>

    <!-- breadcrumb -->
    <div v-if="fb.currentPath.value" class="fb-breadcrumb">
      <template v-for="(c, i) in crumbs" :key="i">
        <span
          v-if="c.active"
          class="fb-crumb fb-crumb-active"
        >{{ c.label }}</span>
        <span
          v-else
          class="fb-crumb fb-crumb-link"
          @click="fb.navigate(c.path)"
        >{{ c.label }}</span>
        <span v-if="i < crumbs.length - 1" class="fb-crumb-sep">›</span>
      </template>
    </div>

    <!-- body -->
    <div class="fb-body">
      <div v-if="fb.loading.value" class="fb-loading">加载中...</div>

      <template v-else-if="fb.error.value">
        <div class="fb-error">
          <span class="fb-error-icon">❌</span>
          <span class="fb-error-msg">{{ fb.error.value }}</span>
          <button
            v-if="fb.parent.value"
            type="button"
            class="fb-back-btn"
            @click="fb.goBack"
          >返回上级</button>
        </div>
      </template>

      <template v-else>
        <!-- 返回上级（非根目录） -->
        <div
          v-if="fb.parent.value && fb.parent.value !== fb.currentPath.value"
          class="fb-item fb-item-up"
          @click="fb.goBack"
        >
          <span class="fb-item-icon">↑</span>
          <span class="fb-item-name">..</span>
        </div>

        <div v-if="!visibleItems.length && !fb.parent.value" class="fb-empty">空目录</div>

        <ul class="fb-list">
          <li v-for="item in visibleItems" :key="item.path">
            <div
              class="fb-item"
              :class="{ 'fb-item-dir': item.isDir || item.isDrive, 'fb-item-file': !item.isDir && !item.isDrive }"
              @click="onItemClick(item)"
            >
              <span class="fb-item-icon">{{ item.isDrive ? '💿' : fileIcon(item.name, item.isDir) }}</span>
              <span class="fb-item-name">{{ item.name }}</span>
              <span v-if="item.isDrive" class="fb-item-meta">本地磁盘</span>
              <span v-else-if="!item.isDir" class="fb-item-size">{{ formatSize(item.size) }}</span>
              <button
                v-if="!item.isDir && !item.isDrive"
                type="button"
                class="fb-download-btn"
                title="下载"
                @click="onDownloadClick($event, item)"
              >⬇</button>
            </div>
          </li>
        </ul>

        <div class="fb-footer">
          <template v-if="fb.currentPath.value === '此电脑'">
            {{ visibleItems.length }} 个磁盘
          </template>
          <template v-else>
            {{ dirCount }} 目录 / {{ fileCount }} 文件
            <template v-if="fb.hiddenCount.value > 0"> / {{ fb.hiddenCount.value }} 隐藏</template>
          </template>
        </div>
      </template>
    </div>

    <!-- 文件预览 modal（fixed,ESC/点遮罩关） -->
    <div v-if="fb.preview.open" class="fb-preview-mask" @click="onMaskClick">
      <div class="fb-preview-card">
        <div class="fb-preview-header">
          <div class="fb-preview-title">
            <span class="fb-preview-icon">{{ fb.preview.isImage ? '🖼️' : '📄' }}</span>
            <span class="fb-preview-name">{{ fb.preview.fileName }}</span>
          </div>
          <div class="fb-preview-actions">
            <button type="button" class="fb-preview-action" title="复制路径" @click="fb.copyPreviewPath">路径</button>
            <button type="button" class="fb-preview-action" title="下载文件" @click="fb.downloadFile(fb.preview.filePath)">下载</button>
            <button
              v-if="!fb.preview.isImage"
              type="button"
              class="fb-preview-action"
              :class="{ 'fb-preview-action-active': fb.preview.mode === 'edit' }"
              :disabled="fb.preview.loading || Boolean(fb.preview.error)"
              title="编辑文件"
              @click="fb.startEdit"
            >{{ fb.preview.mode === 'edit' ? '编辑中' : '编辑' }}</button>
            <button type="button" class="fb-preview-close" @click="fb.closePreview">×</button>
          </div>
        </div>
        <div class="fb-preview-path">{{ fb.preview.filePath }}</div>
        <div class="fb-preview-body">
          <div v-if="fb.preview.loading" class="fb-preview-loading">加载中...</div>
          <div v-else-if="fb.preview.error" class="fb-preview-error">{{ fb.preview.error }}</div>

          <template v-else-if="fb.preview.isImage">
            <div class="fb-preview-image-wrap">
              <img :src="fb.preview.imageUrl" :alt="fb.preview.fileName" class="fb-preview-image" />
            </div>
          </template>

          <template v-else-if="fb.preview.mode === 'view'">
            <pre class="fb-preview-text">{{ fb.preview.content }}</pre>
          </template>

          <template v-else>
            <textarea
              v-model="fb.preview.editValue"
              class="fb-preview-textarea"
              spellcheck="false"
            />
            <div class="fb-preview-edit-footer">
              <span class="fb-preview-edit-status">{{ fb.preview.saveError }}</span>
              <div class="fb-preview-edit-actions">
                <button type="button" class="fb-edit-cancel" :disabled="fb.preview.saving" @click="fb.cancelEdit">取消</button>
                <button type="button" class="fb-edit-save" :disabled="fb.preview.saving" @click="fb.saveEdit">{{ fb.preview.saving ? '保存中…' : '保存' }}</button>
              </div>
            </div>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>
