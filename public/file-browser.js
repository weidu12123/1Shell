/**
 * 文件浏览模块
 *
 * 动态加载当前活跃主机的目录树，支持：
 * - Windows 盘符切换 + 目录导航 + 面包屑路径
 * - 隐藏文件过滤开关
 * - 文件预览 + 复制路径
 * - 错误恢复（加载失败时可返回上级）
 */
window.createFileBrowserModule = function ({ escapeHtml, getActiveHost, requestJson, showErrorMessage, state }) {
  const fileTreeEl = document.getElementById('file-tree');
  let currentHostId = null;
  let filePreviewEl = null;
  let showHidden = true;
  let lastData = null;
  let lastError = null;

  // ─── 目录缓存 ────────────────────────────────────────────────────────
  // key: `${hostId}:${dirPath}`, value: { data, timestamp }
  const dirCache = new Map();
  const DIR_CACHE_TTL_MS = 60000; // 缓存有效期 60 秒
  const DIR_CACHE_MAX = 50;       // 最多缓存 50 个目录

  function cacheKey(hostId, dirPath) {
    return `${hostId}:${dirPath || ''}`;
  }

  function getCachedDir(hostId, dirPath) {
    const key = cacheKey(hostId, dirPath);
    const entry = dirCache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > DIR_CACHE_TTL_MS) {
      dirCache.delete(key);
      return null;
    }
    return entry.data;
  }

  function setCachedDir(hostId, dirPath, data) {
    const key = cacheKey(hostId, dirPath);
    // 淘汰最旧的缓存
    if (dirCache.size >= DIR_CACHE_MAX) {
      const oldest = dirCache.keys().next().value;
      dirCache.delete(oldest);
    }
    dirCache.set(key, { data, timestamp: Date.now() });
  }

  function invalidateHostCache(hostId) {
    for (const key of dirCache.keys()) {
      if (key.startsWith(`${hostId}:`)) dirCache.delete(key);
    }
  }

  function formatSize(bytes) {
    if (bytes === 0) return '--';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  }

  function getDriveIcon(name) {
    return '<span class="text-slate-400 shrink-0 text-base">💿</span>';
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
    lastError = msg;
    const backBtn = lastData && lastData.parent
      ? `<button class="mt-3 px-3 py-1.5 rounded-lg bg-blue-500 text-white text-xs hover:bg-blue-600 transition-colors" data-action="go-back">返回上级</button>`
      : '';
    fileTreeEl.innerHTML = `
      <div class="flex flex-col items-center justify-center py-8 text-red-400 text-xs">
        <span class="mb-1">❌</span>
        <span>${escapeHtml(msg)}</span>
        ${backBtn}
      </div>`;
  }

  /**
   * 生成面包屑导航 HTML
   */
  function renderBreadcrumb(currentPath, isRoot) {
    const isWindows = currentPath.includes(':') || currentPath.includes('\\');
    let html = '<div class="flex items-center gap-0.5 px-2 py-1.5 text-[10px] border-b border-slate-100 dark:border-slate-700 mb-1 overflow-x-auto whitespace-nowrap">';

    // Windows 下始终显示"此电脑"按钮可返回盘符列表
    if (isWindows && currentPath !== '此电脑') {
      html += `<span class="cursor-pointer text-blue-400 hover:text-blue-600 hover:underline shrink-0 font-semibold" data-dir-path="__drives__" data-action="navigate">此电脑</span>`;
      html += '<span class="text-slate-300 mx-0.5">›</span>';
    }

    if (currentPath === '此电脑') {
      html += `<span class="text-slate-500 font-semibold shrink-0">此电脑</span>`;
    } else if (isWindows) {
      // Windows 路径面包屑
      const normalizedPath = currentPath.replace(/\\/g, '/');
      const parts = normalizedPath.split(/\//).filter(Boolean);
      let accumulated = parts[0] + '/';
      const startIndex = 1;
      for (let i = startIndex; i < parts.length; i++) {
        accumulated += parts[i] + '/';
        const isLast = i === parts.length - 1;
        const dirPath = accumulated.replace(/\//g, '\\');

        html += '<span class="text-slate-300 mx-0.5">›</span>';
        if (isLast) {
          html += `<span class="text-slate-500 dark:text-slate-400 font-medium shrink-0">${escapeHtml(parts[i])}</span>`;
        } else {
          html += `<span class="cursor-pointer text-blue-400 hover:text-blue-600 hover:underline shrink-0" data-dir-path="${escapeHtml(dirPath)}" data-action="navigate">${escapeHtml(parts[i])}</span>`;
        }
      }
    } else {
      // Linux 路径
      const parts = currentPath.split('/').filter(Boolean);
      let accumulated = '/';
      html += `<span class="cursor-pointer text-blue-400 hover:text-blue-600 hover:underline shrink-0" data-dir-path="/" data-action="navigate">/</span>`;
      for (let i = 0; i < parts.length; i++) {
        accumulated += parts[i] + '/';
        const isLast = i === parts.length - 1;
        html += '<span class="text-slate-300 mx-0.5">›</span>';
        if (isLast) {
          html += `<span class="text-slate-500 dark:text-slate-400 font-medium shrink-0">${escapeHtml(parts[i])}</span>`;
        } else {
          html += `<span class="cursor-pointer text-blue-400 hover:text-blue-600 hover:underline shrink-0" data-dir-path="${escapeHtml(accumulated)}" data-action="navigate">${escapeHtml(parts[i])}</span>`;
        }
      }
    }

    // 隐藏文件开关
    html += `<span class="ml-auto shrink-0 cursor-pointer px-1.5 py-0.5 rounded text-[9px] border transition-colors ${showHidden ? 'bg-blue-50 dark:bg-blue-900/30 border-blue-200 dark:border-blue-700 text-blue-500' : 'border-slate-200 dark:border-slate-600 text-slate-400 hover:text-blue-400'}" data-action="toggle-hidden" title="显示/隐藏隐藏文件">.*</span>`;
    html += '</div>';
    return html;
  }

  /**
   * 渲染盘符列表（Windows 根视图）
   */
  function renderDriveList(container, data) {
    lastData = data;
    const items = data.items || [];
    const filteredItems = showHidden ? items : items;

    let html = '';
    html += renderBreadcrumb('此电脑', true);

    html += '<ul class="space-y-0">';
    for (const item of filteredItems) {
      const icon = getDriveIcon(item.name);
      html += `<li>
        <div class="flex items-center gap-2 px-3 py-2 rounded hover:bg-slate-50 dark:hover:bg-[#1a2332] cursor-pointer transition-colors group" data-dir-path="${escapeHtml(item.path)}" data-action="navigate">
          ${icon}
          <span class="font-medium text-slate-600 dark:text-slate-300 group-hover:text-blue-500">${escapeHtml(item.name)}</span>
          <span class="ml-auto text-[10px] text-slate-300">本地磁盘</span>
        </div>
      </li>`;
    }
    html += '</ul>';

    html += `<div class="px-2 py-1.5 text-[9px] text-slate-300 dark:text-slate-600 border-t border-slate-50 dark:border-slate-800">`;
    html += `${items.length} 个磁盘`;
    html += '</div>';

    container.innerHTML = html;
  }

  /**
   * 渲染目录内容
   */
  function renderItems(container, data) {
    lastData = data;
    lastError = null;
    const { items, path: currentPath, parent, isRoot } = data;

    // Windows 根目录：显示盘符列表
    if (data.isRoot && currentPath === '此电脑') {
      renderDriveList(container, data);
      return;
    }

    const filteredItems = showHidden ? items : items.filter((i) => !i.name.startsWith('.'));

    let html = '';
    html += renderBreadcrumb(currentPath, isRoot);

    // 返回上级
    if (parent && parent !== currentPath) {
      const parentPath = parent.replace(/\//g, '\\');
      html += `<div class="flex items-center gap-1.5 px-2 py-1 rounded hover:bg-slate-50 dark:hover:bg-[#1a2332] cursor-pointer text-slate-400 hover:text-blue-500 transition-colors" data-dir-path="${escapeHtml(parentPath)}" data-action="navigate">
        <span class="shrink-0 text-[10px]">↑</span>
        <span class="text-[11px]">..</span>
      </div>`;
    }

    if (filteredItems.length === 0) {
      html += '<div class="px-2 py-4 text-slate-400 text-xs text-center">空目录</div>';
    }

    html += '<ul class="space-y-0">';
    for (const item of filteredItems) {
      const icon = item.isDrive ? getDriveIcon(item.name) : getFileIcon(item.name, item.isDir);
      const sizeText = item.isDir ? '' : `<span class="ml-auto text-[10px] text-slate-300 shrink-0">${formatSize(item.size)}</span>`;
      const safePath = item.path.replace(/\\/g, '\\\\');

      if (item.isDir) {
        html += `<li>
          <div class="flex items-center gap-1.5 px-2 py-1 rounded hover:bg-slate-50 dark:hover:bg-[#1a2332] cursor-pointer transition-colors group" data-dir-path="${escapeHtml(safePath)}" data-action="navigate">
            ${icon}
            <span class="font-medium text-slate-600 dark:text-slate-300 group-hover:text-blue-500 truncate">${escapeHtml(item.name)}</span>
          </div>
        </li>`;
      } else {
        html += `<li>
          <div class="flex items-center gap-1.5 px-2 py-1 rounded hover:bg-slate-50 dark:hover:bg-[#1a2332] cursor-pointer transition-colors group" data-file-path="${escapeHtml(safePath)}" data-action="preview">
            ${icon}
            <span class="text-slate-500 dark:text-slate-400 group-hover:text-blue-500 truncate">${escapeHtml(item.name)}</span>
            ${sizeText}
            <button class="shrink-0 hidden group-hover:inline-flex items-center justify-center w-5 h-5 rounded text-[9px] border border-slate-200 dark:border-slate-600 text-slate-400 hover:text-blue-500 hover:border-blue-300 transition-colors" data-action="download" data-download-path="${escapeHtml(safePath)}" title="下载">⬇</button>
          </div>
        </li>`;
      }
    }
    html += '</ul>';

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
   * 加载并显示指定目录（带缓存）
   */
  async function loadDir(dirPath, { skipCache = false } = {}) {
    const host = getActiveHost();
    if (!host) return;

    const hostId = host.id || 'local';
    currentHostId = hostId;

    // 尝试命中缓存（跳过 __drives__ 虚拟路径）
    if (!skipCache && dirPath !== '__drives__') {
      const cached = getCachedDir(hostId, dirPath);
      if (cached) {
        renderItems(fileTreeEl, cached);
        return;
      }
    }

    renderLoading();

    try {
      const params = new URLSearchParams({ hostId });
      if (dirPath && dirPath !== '__drives__') params.set('path', dirPath);

      const data = await requestJson(`/api/files/list?${params}`);
      if (currentHostId !== hostId) return;
      setCachedDir(hostId, dirPath, data);
      renderItems(fileTreeEl, data);
    } catch (err) {
      if (currentHostId !== hostId) return;
      renderError(err.message || '加载失败');
    }
  }

  /**
   * 下载文件
   */
  function downloadFile(filePath) {
    const host = getActiveHost();
    if (!host) return;
    const hostId = host.id || 'local';
    const params = new URLSearchParams({ hostId, path: filePath });
    // 触发浏览器下载
    const a = document.createElement('a');
    a.href = `/api/files/download?${params}`;
    a.download = '';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  /**
   * 上传文件弹窗
   */
  function showUploadDialog() {
    const host = getActiveHost();
    if (!host) return;
    if (!lastData || !lastData.path || lastData.path === '此电脑') {
      window.appShared?.showToast?.('请先进入一个目录', 'warn', 2000);
      return;
    }

    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.addEventListener('change', async () => {
      if (!input.files || input.files.length === 0) return;
      const hostId = host.id || 'local';
      const dirPath = lastData.path;

      for (const file of input.files) {
        try {
          const formData = new FormData();
          formData.append('hostId', hostId);
          formData.append('dirPath', dirPath);
          formData.append('file', file);

          const csrfToken = window.appShared?.getCsrfToken?.() || '';
          const resp = await fetch('/api/files/upload', {
            method: 'POST',
            headers: csrfToken ? { 'x-csrf-token': csrfToken } : {},
            body: formData,
          });
          if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            throw new Error(err.error || `上传失败 (${resp.status})`);
          }
          window.appShared?.showToast?.(`${file.name} 上传成功`, 'success', 2000);
        } catch (err) {
          window.appShared?.showToast?.(`${file.name} 上传失败: ${err.message}`, 'error', 3000);
        }
      }
      // 上传后清除该目录缓存并刷新
      dirCache.delete(cacheKey(hostId, dirPath));
      loadDir(dirPath);
    });
    input.click();
  }

  /**
   * 判断文件是否为图片
   */
  function isImageFile(name) {
    const ext = name.split('.').pop().toLowerCase();
    return ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp'].includes(ext);
  }

  /**
   * 文件预览弹窗
   */
  async function previewFile(filePath) {
    const host = getActiveHost();
    if (!host) return;
    const hostId = host.id || 'local';
    const fileName = filePath.split(/[\\/]/).pop();

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
            <button class="file-preview-action h-6 px-2 rounded text-[10px] border border-slate-200 dark:border-slate-600 text-slate-400 hover:text-blue-500 hover:border-blue-300 transition-colors" data-action="download-preview" title="下载文件">下载</button>
            <button class="file-preview-action h-6 px-2 rounded text-[10px] border border-slate-200 dark:border-slate-600 text-slate-400 hover:text-green-500 hover:border-green-300 transition-colors" data-action="edit-file" title="编辑文件">编辑</button>
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

    filePreviewEl.querySelector('[data-action="copy-path"]')?.addEventListener('click', () => {
      navigator.clipboard?.writeText(filePath).then(() => {
        window.appShared?.showToast?.('路径已复制', 'success', 2000);
      });
    });

    filePreviewEl.querySelector('[data-action="download-preview"]')?.addEventListener('click', () => {
      downloadFile(filePath);
    });

    // 编辑按钮（图片文件不支持编辑）
    const editBtn = filePreviewEl.querySelector('[data-action="edit-file"]');
    let fileContent = null; // 缓存文件内容

    if (editBtn) {
      if (isImageFile(fileName)) {
        editBtn.style.display = 'none';
      } else {
        editBtn.addEventListener('click', () => {
          if (fileContent === null) return; // 内容未加载完成
          const contentEl2 = filePreviewEl.querySelector('#file-preview-content');
          if (!contentEl2) return;

          // 检查是否已在编辑模式
          const existingEditor = contentEl2.querySelector('#file-edit-textarea');
          if (existingEditor) return;

          contentEl2.innerHTML = `
            <textarea id="file-edit-textarea" class="w-full h-full min-h-[300px] text-xs font-mono leading-relaxed p-2 rounded-lg border border-slate-200 dark:border-slate-600 bg-white dark:bg-[#0b1324] text-slate-700 dark:text-slate-200 outline-none resize-none" spellcheck="false">${escapeHtml(fileContent)}</textarea>
            <div class="flex items-center justify-between mt-2 pt-2 border-t border-slate-100 dark:border-slate-700">
              <span class="text-[10px] text-slate-400" id="file-edit-status"></span>
              <div class="flex gap-1.5">
                <button id="file-edit-cancel" class="h-6 px-2.5 rounded text-[10px] border border-slate-200 dark:border-slate-600 text-slate-500 hover:text-slate-700 transition-colors">取消</button>
                <button id="file-edit-save" class="h-6 px-2.5 rounded text-[10px] bg-blue-500 text-white hover:bg-blue-600 transition-colors font-semibold">保存</button>
              </div>
            </div>`;

          editBtn.textContent = '编辑中';
          editBtn.classList.add('text-green-500', 'border-green-300');

          contentEl2.querySelector('#file-edit-cancel')?.addEventListener('click', () => {
            // 恢复预览模式
            contentEl2.innerHTML = `<pre class="text-xs text-slate-600 dark:text-slate-300 whitespace-pre-wrap break-all font-mono leading-relaxed">${escapeHtml(fileContent)}</pre>`;
            editBtn.textContent = '编辑';
            editBtn.classList.remove('text-green-500', 'border-green-300');
          });

          contentEl2.querySelector('#file-edit-save')?.addEventListener('click', async () => {
            const textarea = contentEl2.querySelector('#file-edit-textarea');
            const statusEl = contentEl2.querySelector('#file-edit-status');
            const saveBtn = contentEl2.querySelector('#file-edit-save');
            if (!textarea || !saveBtn) return;

            saveBtn.disabled = true;
            saveBtn.textContent = '保存中…';
            if (statusEl) statusEl.textContent = '';

            try {
              await requestJson('/api/files/write', {
                method: 'POST',
                body: JSON.stringify({ hostId, path: filePath, content: textarea.value }),
              });
              fileContent = textarea.value;
              // 文件内容变更后，清除所在目录的缓存（文件大小等可能变化）
              if (lastData?.path) dirCache.delete(cacheKey(hostId, lastData.path));
              window.appShared?.showToast?.('保存成功', 'success', 2000);
              // 恢复预览模式
              contentEl2.innerHTML = `<pre class="text-xs text-slate-600 dark:text-slate-300 whitespace-pre-wrap break-all font-mono leading-relaxed">${escapeHtml(fileContent)}</pre>`;
              editBtn.textContent = '编辑';
              editBtn.classList.remove('text-green-500', 'border-green-300');
            } catch (err) {
              saveBtn.disabled = false;
              saveBtn.textContent = '保存';
              if (statusEl) statusEl.textContent = `保存失败: ${err.message}`;
            }
          });
        });
      }
    }

    const contentEl = filePreviewEl.querySelector('#file-preview-content');

    // 图片文件：通过下载接口加载为 blob 显示
    if (isImageFile(fileName)) {
      try {
        const params = new URLSearchParams({ hostId, path: filePath });
        const resp = await fetch(`/api/files/download?${params}`);
        if (!resp.ok) throw new Error('加载失败');
        const blob = await resp.blob();
        const url = URL.createObjectURL(blob);
        contentEl.innerHTML = `<div class="flex items-center justify-center"><img src="${url}" alt="${escapeHtml(fileName)}" class="max-w-full max-h-[60vh] rounded-lg shadow-sm" onload="this.parentElement.classList.add('loaded')" /></div>`;
      } catch (err) {
        contentEl.innerHTML = `<div class="text-center py-8 text-red-400 text-xs">${escapeHtml(err.message || '图片加载失败')}</div>`;
      }
      return;
    }

    // 文本文件预览
    try {
      const params = new URLSearchParams({ hostId, path: filePath });
      const data = await requestJson(`/api/files/read?${params}`);
      fileContent = data.content;
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

    // 返回上级（错误页面中的按钮）
    if (e.target.closest('[data-action="go-back"]')) {
      if (lastData && lastData.parent) {
        loadDir(lastData.parent);
      }
      return;
    }

    const navigateEl = e.target.closest('[data-action="navigate"]');
    if (navigateEl) {
      const dirPath = navigateEl.getAttribute('data-dir-path');
      if (dirPath === '__drives__') {
        loadDir('');
      } else {
        loadDir(dirPath);
      }
      return;
    }

    // 下载文件
    const downloadEl = e.target.closest('[data-action="download"]');
    if (downloadEl) {
      e.stopPropagation();
      downloadFile(downloadEl.getAttribute('data-download-path'));
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
      invalidateHostCache(currentHostId);
      loadDir('');
    }
  }

  function initialize() {
    if (fileTreeEl) {
      fileTreeEl.addEventListener('click', handleTreeClick);
    }

    // 上传按钮
    const uploadBtn = document.getElementById('file-upload-btn');
    if (uploadBtn) {
      uploadBtn.addEventListener('click', showUploadDialog);
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

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && filePreviewEl) {
        closePreview();
      }
    });
  }

  return { initialize, loadDir, syncActiveHost };
};
