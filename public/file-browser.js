/**
 * 文件浏览模块
 *
 * 动态加载当前活跃主机的目录树，支持：
 * - 目录导航 + 面包屑路径
 * - 隐藏文件过滤开关
 * - 文件预览 + 复制路径
 * - 文件下载（本机直接下载，远程通过 API）
 */
window.createFileBrowserModule = function ({ escapeHtml, getActiveHost, requestJson, showErrorMessage, state }) {
  'use strict';

  const fileTreeEl = document.getElementById('file-tree');
  let currentHostId = null;
  let filePreviewEl = null;
  let showHidden = false;
  let lastData = null; // 缓存最后一次加载的目录数据

  function formatSize(bytes) {
    if (bytes === 0) return '--';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  }

  function getFileIcon(name, isDir) {
    if (isDir) return '<span class="text-blue-400 shrink-0">📁</span>';
    const ext = name.split('.').pop().toLowerCase();
    const iconMap = {
      js: '🟨', ts: '🔷', json: '📋', md: '📝', txt: '📄',
      sh: '⚙️', bash: '⚙️', py: '🐍', html: '🌐', css: '🎨',
      yml: '📦', yaml: '📦', xml: '📰', sql: '🗃️',
      png: '🖼️', jpg: '🖼️', jpeg: '🖼️', gif: '🖼️', svg: '🖼️',
      zip: '📦', gz: '📦', tar: '📦',
      log: '📜', env: '🔒', conf: '⚙️', cfg: '⚙️',
    };
    return `<span class="text-slate-400 shrink-0">${iconMap[ext] || '📄'}</span>`;
  }

  function renderLoading() {
    fileTreeEl.innerHTML = '<div class="flex items-center justify-center py-8 text-slate-400 text-xs"><span class="animate-pulse">加载中...</span></div>';
  }

  function renderError(msg) {
    fileTreeEl.innerHTML = `<div class="flex items-center justify-center py-8 text-red-400 text-xs">${escapeHtml(msg)}</div>`;
  }

  /**
   * 生成面包屑导航 HTML
   */
  function renderBreadcrumb(currentPath) {
    // 拆分路径为段
    const sep = currentPath.includes('/') ? '/' : '\\';
    const parts = currentPath.split(/[/\\]/).filter(Boolean);
    let accumulated = currentPath.startsWith('/') ? '/' : '';

    let html = '<div class="flex items-center gap-0.5 px-2 py-1.5 text-[10px] border-b border-slate-100 dark:border-slate-700 mb-1 overflow-x-auto whitespace-nowrap">';

    // 根目录
    html += `<span class="cursor-pointer text-blue-400 hover:text-blue-600 hover:underline shrink-0" data-dir-path="${escapeHtml(accumulated || '/')}" data-action="navigate">/</span>`;

    for (let i = 0; i < parts.length; i++) {
      accumulated += (accumulated.endsWith('/') ? '' : '/') + parts[i];
      const isLast = i === parts.length - 1;

      html += '<span class="text-slate-300 mx-0.5">›</span>';
      if (isLast) {
        html += `<span class="text-slate-500 dark:text-slate-400 font-medium shrink-0">${escapeHtml(parts[i])}</span>`;
      } else {
        html += `<span class="cursor-pointer text-blue-400 hover:text-blue-600 hover:underline shrink-0" data-dir-path="${escapeHtml(accumulated)}" data-action="navigate">${escapeHtml(parts[i])}</span>`;
      }
    }

    // 隐藏文件开关
    html += `<span class="ml-auto shrink-0 cursor-pointer px-1.5 py-0.5 rounded text-[9px] border transition-colors ${showHidden ? 'bg-blue-50 dark:bg-blue-900/30 border-blue-200 dark:border-blue-700 text-blue-500' : 'border-slate-200 dark:border-slate-600 text-slate-400 hover:text-blue-400'}" data-action="toggle-hidden" title="显示/隐藏隐藏文件">${showHidden ? '.*' : '.*'}</span>`;
    html += '</div>';
    return html;
  }

  /**
   * 渲染目录内容
   */
  function renderItems(container, data) {
    lastData = data;
    const { items, path: currentPath, parent } = data;

    // 过滤隐藏文件
    const filteredItems = showHidden ? items : items.filter((i) => !i.name.startsWith('.'));

    let html = '';

    // 面包屑导航
    html += renderBreadcrumb(currentPath);

    // 返回上级
    if (parent && parent !== currentPath) {
      html += `<div class="flex items-center gap-1.5 px-2 py-1 rounded hover:bg-slate-50 dark:hover:bg-[#1a2332] cursor-pointer text-slate-400 hover:text-blue-500 transition-colors" data-dir-path="${escapeHtml(parent)}" data-action="navigate">
        <span class="shrink-0 text-[10px]">↑</span>
        <span class="text-[11px]">..</span>
      </div>`;
    }

    if (filteredItems.length === 0) {
      html += '<div class="px-2 py-4 text-slate-400 text-xs text-center">空目录</div>';
    }

    html += '<ul class="space-y-0">';
    for (const item of filteredItems) {
      const icon = getFileIcon(item.name, item.isDir);
      const sizeText = item.isDir ? '' : `<span class="ml-auto text-[10px] text-slate-300 shrink-0">${formatSize(item.size)}</span>`;

      if (item.isDir) {
        html += `<li>
          <div class="flex items-center gap-1.5 px-2 py-1 rounded hover:bg-slate-50 dark:hover:bg-[#1a2332] cursor-pointer transition-colors group" data-dir-path="${escapeHtml(item.path)}" data-action="navigate">
            ${icon}
            <span class="font-medium text-slate-600 dark:text-slate-300 group-hover:text-blue-500 truncate">${escapeHtml(item.name)}</span>
          </div>
        </li>`;
      } else {
        html += `<li>
          <div class="flex items-center gap-1.5 px-2 py-1 rounded hover:bg-slate-50 dark:hover:bg-[#1a2332] cursor-pointer transition-colors group" data-file-path="${escapeHtml(item.path)}" data-action="preview">
            ${icon}
            <span class="text-slate-500 dark:text-slate-400 group-hover:text-blue-500 truncate">${escapeHtml(item.name)}</span>
            ${sizeText}
          </div>
        </li>`;
      }
    }
    html += '</ul>';

    // 底部统计
    const dirCount = filteredItems.filter((i) => i.isDir).length;
    const fileCount = filteredItems.length - dirCount;
    const hiddenCount = items.length - filteredItems.length;
    html += `<div class="px-2 py-1.5 text-[9px] text-slate-300 dark:text-slate-600 border-t border-slate-50 dark:border-slate-800">`;
    html += `${dirCount} 目录 / ${fileCount} 文件`;
    if (hiddenCount > 0) html += ` / ${hiddenCount} 隐藏`;
    html += '</div>';

    container.innerHTML = html;
  }

  /**
   * 加载并显示指定目录
   */
  async function loadDir(dirPath) {
    const host = getActiveHost();
    if (!host) return;

    const hostId = host.id || 'local';
    currentHostId = hostId;
    renderLoading();

    try {
      const params = new URLSearchParams({ hostId });
      if (dirPath) params.set('path', dirPath);

      const data = await requestJson(`/api/files/list?${params}`);
      if (currentHostId !== hostId) return;
      renderItems(fileTreeEl, data);
    } catch (err) {
      if (currentHostId !== hostId) return;
      renderError(err.message || '加载失败');
    }
  }

  /**
   * 文件预览弹窗
   */
  async function previewFile(filePath) {
    const host = getActiveHost();
    if (!host) return;
    const hostId = host.id || 'local';
    const fileName = filePath.split('/').pop();

    closePreview();
    filePreviewEl = document.createElement('div');
    filePreviewEl.className = 'fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm';
    filePreviewEl.innerHTML = `
      <div class="bg-white dark:bg-[#0f1923] rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-700 w-[90vw] max-w-3xl max-h-[80vh] flex flex-col overflow-hidden">
        <div class="flex items-center justify-between px-4 py-3 border-b border-slate-100 dark:border-slate-700">
          <div class="flex items-center gap-2 min-w-0">
            <span class="text-slate-400">📄</span>
            <span class="text-sm font-medium text-slate-700 dark:text-slate-200 truncate">${escapeHtml(fileName)}</span>
          </div>
          <div class="flex items-center gap-1.5 shrink-0">
            <button class="file-preview-action h-6 px-2 rounded text-[10px] border border-slate-200 dark:border-slate-600 text-slate-400 hover:text-blue-500 hover:border-blue-300 transition-colors" data-action="copy-path" title="复制路径">路径</button>
            <button id="file-preview-close" class="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-400 hover:text-red-500 transition-colors text-sm">×</button>
          </div>
        </div>
        <div class="px-4 py-1 text-[10px] text-slate-400 truncate border-b border-slate-50 dark:border-slate-800">${escapeHtml(filePath)}</div>
        <div class="flex-1 overflow-auto p-4" id="file-preview-content">
          <div class="flex items-center justify-center py-8 text-slate-400 text-xs animate-pulse">加载中...</div>
        </div>
      </div>
    `;

    document.body.appendChild(filePreviewEl);

    filePreviewEl.querySelector('#file-preview-close').addEventListener('click', closePreview);
    filePreviewEl.addEventListener('click', (e) => {
      if (e.target === filePreviewEl) closePreview();
    });

    // 复制路径
    filePreviewEl.querySelector('[data-action="copy-path"]')?.addEventListener('click', () => {
      navigator.clipboard?.writeText(filePath).then(() => {
        window.appShared?.showToast?.('路径已复制', 'success', 2000);
      });
    });

    const contentEl = filePreviewEl.querySelector('#file-preview-content');
    try {
      const params = new URLSearchParams({ hostId, path: filePath });
      const data = await requestJson(`/api/files/read?${params}`);
      contentEl.innerHTML = `<pre class="text-xs text-slate-600 dark:text-slate-300 whitespace-pre-wrap break-all font-mono leading-relaxed">${escapeHtml(data.content)}</pre>
        <div class="mt-2 pt-2 border-t border-slate-100 dark:border-slate-700 text-[10px] text-slate-400">${formatSize(data.size)}</div>`;
    } catch (err) {
      contentEl.innerHTML = `<div class="text-center py-8 text-red-400 text-xs">${escapeHtml(err.message || '读取失败')}</div>`;
    }
  }

  function closePreview() {
    filePreviewEl?.remove();
    filePreviewEl = null;
  }

  function handleTreeClick(e) {
    // 隐藏文件过滤开关
    if (e.target.closest('[data-action="toggle-hidden"]')) {
      showHidden = !showHidden;
      if (lastData) renderItems(fileTreeEl, lastData);
      return;
    }

    const navigateEl = e.target.closest('[data-action="navigate"]');
    if (navigateEl) {
      loadDir(navigateEl.getAttribute('data-dir-path'));
      return;
    }

    const previewEl = e.target.closest('[data-action="preview"]');
    if (previewEl) {
      previewFile(previewEl.getAttribute('data-file-path'));
    }
  }

  function syncActiveHost() {
    const host = getActiveHost();
    if (!host) return;
    const hostId = host.id || 'local';
    if (hostId !== currentHostId) {
      loadDir('');
    }
  }

  function initialize() {
    if (fileTreeEl) {
      fileTreeEl.addEventListener('click', handleTreeClick);
    }

    const appShell = document.getElementById('app-shell');
    if (appShell) {
      const observer = new MutationObserver(() => {
        if (!appShell.classList.contains('hidden')) {
          loadDir('');
          observer.disconnect();
        }
      });
      observer.observe(appShell, { attributes: true, attributeFilter: ['class'] });
      if (!appShell.classList.contains('hidden')) {
        loadDir('');
      }
    }

    // Esc 关闭预览
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && filePreviewEl) {
        closePreview();
      }
    });
  }

  return { initialize, loadDir, syncActiveHost };
};
