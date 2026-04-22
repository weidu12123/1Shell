/**
 * 脚本 & Playbook 快捷注入模块
 *
 * 在主控台终端工具栏提供「脚本」和「Playbook」按钮，
 * 将脚本库中的脚本渲染为命令后注入终端执行，
 * 用户可以直接在终端中看到输出结果。
 *
 * Playbook 会将所有步骤渲染后拼接成一段脚本（用注释分隔），
 * 一次性注入终端，由 shell 顺序执行。
 */
(() => {
  'use strict';

  function createScriptInjectModule({
    escapeHtml,
    getActiveHost,
    getSessionTerminalModule,
    requestJson,
    showErrorMessage,
  }) {
    // ─── DOM refs ────────────────────────────────────────────────────
    const scriptPanel = document.getElementById('script-inject-panel');
    const scriptSelect = document.getElementById('si-script-select');
    const paramsForm = document.getElementById('si-params-form');
    const previewRow = document.getElementById('si-preview-row');
    const previewCode = document.getElementById('si-preview-code');
    const injectBtn = document.getElementById('si-inject-btn');
    const runBtn = document.getElementById('si-run-btn');
    const closeBtn = document.getElementById('si-close-btn');
    const openBtn = document.getElementById('inject-script-btn');

    const playbookPanel = document.getElementById('playbook-inject-panel');
    const playbookSelect = document.getElementById('pi-playbook-select');
    const piRunBtn = document.getElementById('pi-run-btn');
    const piCloseBtn = document.getElementById('pi-close-btn');
    const piStepsPreview = document.getElementById('pi-steps-preview');
    const piResult = document.getElementById('pi-result');
    const piOpenBtn = document.getElementById('inject-playbook-btn');

    let scripts = [];
    let playbooks = [];
    let selectedScript = null;
    let initialized = false;

    // ─── 工具函数 ─────────────────────────────────────────────────
    function getSessionTerminal() {
      return getSessionTerminalModule?.() || null;
    }

    function getHostId() {
      const host = getActiveHost?.();
      return host?.id || 'local';
    }

    function triggerResize() {
      setTimeout(() => {
        window.dispatchEvent(new Event('resize'));
        getSessionTerminal()?.getTerminal?.()?.scrollToBottom?.();
      }, 60);
    }

    /**
     * 注入命令到终端并回车执行。
     *
     * 单行命令直接写入；多行命令包在 bash heredoc 中，
     * 确保 shell 将整段脚本作为一个整体执行，
     * 而不是逐行回车（否则长时间运行的命令会吃掉后续行）。
     */
    function injectToTerminal(command) {
      const stm = getSessionTerminal();
      if (!stm) {
        window.appShared?.showToast?.('终端未连接', 'warn', 2000);
        return false;
      }

      const lines = command.split('\n').filter((l) => l.trim() !== '');
      let payload;
      if (lines.length <= 1) {
        // 单行命令直接注入
        payload = command.trim() + '\n';
      } else {
        // 多行命令：用 heredoc 包装，确保 shell 整体执行
        const eof = '__1SHELL_EOF__';
        payload = `bash << '${eof}'\n${command}\n${eof}\n`;
      }

      if (!stm.sendSessionInput(payload)) {
        window.appShared?.showToast?.('注入失败，终端会话未就绪', 'warn', 2000);
        return false;
      }
      return true;
    }

    // ─── 脚本面板 ─────────────────────────────────────────────────
    async function loadScripts() {
      try {
        const resp = await requestJson('/api/scripts');
        scripts = resp.scripts || [];
      } catch { scripts = []; }
      renderScriptOptions();
    }

    function renderScriptOptions() {
      scriptSelect.innerHTML = '<option value="">选择脚本…</option>'
        + scripts.map((s) =>
          `<option value="${escapeHtml(s.id)}">${escapeHtml(s.icon || '📜')} ${escapeHtml(s.name)}</option>`
        ).join('');
    }

    function onScriptChange() {
      const id = scriptSelect.value;
      selectedScript = scripts.find((s) => s.id === id) || null;
      if (!selectedScript) {
        paramsForm.classList.add('hidden');
        paramsForm.innerHTML = '';
        previewRow.classList.add('hidden');
        return;
      }
      renderParams();
      refreshPreview();
    }

    function renderParams() {
      const defs = selectedScript?.parameters || [];
      if (!defs.length) {
        paramsForm.classList.add('hidden');
        paramsForm.innerHTML = '';
        return;
      }
      paramsForm.classList.remove('hidden');
      paramsForm.innerHTML = defs.map((def) => {
        let input;
        if (def.type === 'boolean') {
          input = `<select data-pname="${escapeHtml(def.name)}" class="si-param h-7 px-2 rounded border border-slate-200 dark:border-[#1e293b] bg-white dark:bg-[#0b1324] text-xs outline-none"><option value="false">false</option><option value="true">true</option></select>`;
        } else if (def.type === 'select') {
          const opts = (def.options || []).map((o) =>
            `<option value="${escapeHtml(o.value)}">${escapeHtml(o.label || o.value)}</option>`
          ).join('');
          input = `<select data-pname="${escapeHtml(def.name)}" class="si-param h-7 px-2 rounded border border-slate-200 dark:border-[#1e293b] bg-white dark:bg-[#0b1324] text-xs outline-none">${opts}</select>`;
        } else {
          input = `<input type="${def.type === 'number' ? 'number' : 'text'}" data-pname="${escapeHtml(def.name)}" class="si-param h-7 px-2 rounded border border-slate-200 dark:border-[#1e293b] bg-white dark:bg-[#0b1324] text-xs outline-none w-32" value="${escapeHtml(def.default || '')}" placeholder="${escapeHtml(def.label || def.name)}" />`;
        }
        const required = def.required ? '<span class="text-red-500">*</span>' : '';
        return `<div class="flex items-center gap-1"><span class="text-[10px] text-slate-500">${escapeHtml(def.label || def.name)}${required}</span>${input}</div>`;
      }).join('');

      paramsForm.querySelectorAll('.si-param').forEach((el) => {
        el.addEventListener('change', refreshPreview);
        el.addEventListener('input', refreshPreview);
      });
    }

    function collectParams() {
      const params = {};
      paramsForm.querySelectorAll('[data-pname]').forEach((el) => {
        params[el.getAttribute('data-pname')] = el.value;
      });
      return params;
    }

    async function refreshPreview() {
      if (!selectedScript) return;
      previewRow.classList.remove('hidden');
      const params = collectParams();
      try {
        const resp = await requestJson(`/api/scripts/${encodeURIComponent(selectedScript.id)}/preview`, {
          method: 'POST',
          body: JSON.stringify({ hostId: getHostId(), params }),
        });
        previewCode.textContent = resp.renderedCommand || '（空）';
      } catch (err) {
        previewCode.textContent = `预览失败: ${err.message}`;
      }
    }

    function onInject() {
      const command = previewCode.textContent;
      if (!command || command.startsWith('预览失败')) return;
      if (injectToTerminal(command)) {
        closeScriptPanel();
        getSessionTerminal()?.focusTerminal();
      }
    }

    function onCopyScript() {
      const command = previewCode.textContent;
      if (!command || command.startsWith('预览失败')) return;
      navigator.clipboard?.writeText(command).then(() => {
        window.appShared?.showToast?.('命令已复制', 'success', 2000);
      });
    }

    function openScriptPanel() {
      closePlaybookPanel();
      scriptPanel.classList.remove('hidden');
      if (!scripts.length) loadScripts();
      triggerResize();
    }

    function closeScriptPanel() {
      scriptPanel.classList.add('hidden');
      scriptSelect.value = '';
      selectedScript = null;
      paramsForm.classList.add('hidden');
      paramsForm.innerHTML = '';
      previewRow.classList.add('hidden');
      triggerResize();
    }

    // ─── Playbook 面板 ────────────────────────────────────────────
    async function loadPlaybooks() {
      try {
        const resp = await requestJson('/api/playbooks');
        playbooks = resp.playbooks || [];
      } catch { playbooks = []; }
      renderPlaybookOptions();
    }

    function renderPlaybookOptions() {
      playbookSelect.innerHTML = '<option value="">选择 Playbook…</option>'
        + playbooks.map((p) =>
          `<option value="${escapeHtml(p.id)}">${escapeHtml(p.icon || '📘')} ${escapeHtml(p.name)}</option>`
        ).join('');
    }

    function onPlaybookChange() {
      const id = playbookSelect.value;
      const pb = playbooks.find((p) => p.id === id);
      if (!pb) {
        piRunBtn.disabled = true;
        piStepsPreview.classList.add('hidden');
        piResult.classList.add('hidden');
        return;
      }
      piRunBtn.disabled = false;
      piResult.classList.add('hidden');

      const steps = pb.steps || [];
      if (steps.length) {
        piStepsPreview.classList.remove('hidden');
        piStepsPreview.innerHTML = `<span class="font-semibold">${steps.length} 个步骤：</span> `
          + steps.map((s, i) => {
            const hostLabel = s.hostId ? escapeHtml(s.hostId) : `<span class="text-blue-500">当前主机</span>`;
            return `<span class="inline-flex items-center gap-0.5">${i + 1}. ${escapeHtml(s.scriptName || s.scriptId)} → ${hostLabel}</span>`;
          }).join('<span class="text-slate-300 mx-1">›</span>');
      } else {
        piStepsPreview.classList.add('hidden');
      }
    }

    /**
     * 执行 Playbook：逐步 preview 渲染命令 → 拼接成完整脚本 → 一次性注入终端
     *
     * 生成的脚本形如：
     *   echo '── [1/3] 磁盘检查 ──'
     *   df -h
     *   echo '── [2/3] 内存检查 ──'
     *   free -m
     *   echo '── [3/3] 进程检查 ──'
     *   ps aux --sort=-%mem | head -20
     *
     * 这样用户在终端里能清楚看到每一步的分隔和输出。
     */
    async function onRunPlaybook() {
      const id = playbookSelect.value;
      if (!id) return;
      const pb = playbooks.find((p) => p.id === id);
      if (!pb) return;

      const steps = pb.steps || [];
      if (!steps.length) {
        window.appShared?.showToast?.('Playbook 没有任何步骤', 'warn', 2000);
        return;
      }

      const hostId = getHostId();

      piRunBtn.disabled = true;
      piRunBtn.textContent = '渲染中…';
      piResult.classList.remove('hidden');
      piResult.innerHTML = '<span class="text-slate-400">正在渲染命令…</span>';

      try {
        const commandParts = [];

        for (let i = 0; i < steps.length; i++) {
          const step = steps[i];
          const stepHostId = step.hostId || hostId;
          const stepName = step.scriptName || step.scriptId || `步骤 ${i + 1}`;

          // 调 preview API 渲染参数
          const resp = await requestJson(`/api/scripts/${encodeURIComponent(step.scriptId)}/preview`, {
            method: 'POST',
            body: JSON.stringify({ hostId: stepHostId, params: step.params || {} }),
          });

          const rendered = resp.renderedCommand || '';
          if (!rendered) {
            piResult.innerHTML = `<span class="text-red-500">步骤 ${i + 1}「${escapeHtml(stepName)}」渲染为空</span>`;
            return;
          }

          // 添加分隔注释 + 命令
          commandParts.push(`echo '── [${i + 1}/${steps.length}] ${stepName.replace(/'/g, "\\'")} ──'`);
          commandParts.push(rendered);
        }

        // 拼接完整脚本
        const fullScript = commandParts.join('\n');

        // 预览拼接结果
        piResult.innerHTML = `<div class="mb-1"><span class="text-green-600 dark:text-green-400 font-semibold">${steps.length} 个步骤已渲染</span></div>`
          + `<pre class="px-3 py-1.5 rounded-lg bg-slate-800 text-slate-200 font-mono text-xs overflow-x-auto whitespace-pre-wrap break-all max-h-32 overflow-y-auto">${escapeHtml(fullScript)}</pre>`;

        // 注入终端执行
        if (injectToTerminal(fullScript)) {
          window.appShared?.showToast?.(`Playbook「${pb.name}」已注入终端`, 'success', 3000);
          getSessionTerminal()?.focusTerminal();
        }
      } catch (err) {
        piResult.innerHTML = `<span class="text-red-500">${escapeHtml(err.message)}</span>`;
        showErrorMessage(err);
      } finally {
        piRunBtn.disabled = false;
        piRunBtn.textContent = '执行';
      }
    }

    function openPlaybookPanel() {
      closeScriptPanel();
      playbookPanel.classList.remove('hidden');
      piResult.classList.add('hidden');
      if (!playbooks.length) loadPlaybooks();
      triggerResize();
    }

    function closePlaybookPanel() {
      playbookPanel.classList.add('hidden');
      playbookSelect.value = '';
      piRunBtn.disabled = true;
      piStepsPreview.classList.add('hidden');
      piResult.classList.add('hidden');
      triggerResize();
    }

    // ─── 初始化 ──────────────────────────────────────────────────
    function initialize() {
      if (initialized) return;
      initialized = true;

      // 脚本面板事件
      openBtn?.addEventListener('click', () => {
        if (scriptPanel.classList.contains('hidden')) openScriptPanel();
        else closeScriptPanel();
      });
      closeBtn?.addEventListener('click', closeScriptPanel);
      scriptSelect?.addEventListener('change', onScriptChange);
      injectBtn?.addEventListener('click', onInject);
      runBtn?.addEventListener('click', onCopyScript);

      // Playbook 面板事件
      piOpenBtn?.addEventListener('click', () => {
        if (playbookPanel.classList.contains('hidden')) openPlaybookPanel();
        else closePlaybookPanel();
      });
      piCloseBtn?.addEventListener('click', closePlaybookPanel);
      playbookSelect?.addEventListener('change', onPlaybookChange);
      piRunBtn?.addEventListener('click', () => onRunPlaybook().catch(showErrorMessage));
    }

    return {
      initialize,
      openScriptPanel,
      closeScriptPanel,
      openPlaybookPanel,
      closePlaybookPanel,
    };
  }

  window.createScriptInjectModule = createScriptInjectModule;
})();
