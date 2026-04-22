(() => {
  'use strict';

  function createTerminalAnalyzeModule({
    escapeHtml,
    getActiveHost,
    getRecentCommands,
    getSessionTerminalModule,
    onCloseAiPanel,
    requestJson,
    showErrorMessage,
  }) {
    const fabEl = document.getElementById('analyze-fab');
    const ctxMenuEl = document.getElementById('analyze-ctx-menu');
    const ctxAnalyzeBtnEl = document.getElementById('analyze-ctx-analyze-btn');
    const panelEl = document.getElementById('analyze-panel');
    const panelCloseBtnEl = document.getElementById('analyze-panel-close-btn');
    const analyzeAgainBtnEl = document.getElementById('analyze-again-btn');
    const previewTextEl = document.getElementById('analyze-preview-text');
    const previewToggleEl = document.getElementById('analyze-preview-toggle');
    const summaryEl = document.getElementById('analyze-summary');
    const errorTypeEl = document.getElementById('analyze-error-type');
    const fixSectionEl = document.getElementById('analyze-fix-section');
    const fixCmdEl = document.getElementById('analyze-fix-cmd');
    const fixRiskEl = document.getElementById('analyze-fix-risk');
    const fixCopyBtnEl = document.getElementById('analyze-fix-copy-btn');
    const fixInsertBtnEl = document.getElementById('analyze-fix-insert-btn');
    const fixInsertConfirmEl = document.getElementById('analyze-fix-insert-confirm');
    const fixInsertConfirmYesEl = document.getElementById('analyze-fix-insert-confirm-yes');
    const fixInsertConfirmNoEl = document.getElementById('analyze-fix-insert-confirm-no');
    const loadingEl = document.getElementById('analyze-loading');
    const resultEl = document.getElementById('analyze-result');

    const RISK_LABELS = Object.freeze({
      safe: { text: '低风险', cls: 'risk-safe' },
      caution: { text: '中风险，请确认', cls: 'risk-caution' },
      danger: { text: '高风险，仅复制', cls: 'risk-danger' },
    });

    const ERROR_TYPE_LABELS = Object.freeze({
      permission_denied: '权限不足',
      command_not_found: '命令不存在',
      oom: '内存不足 (OOM)',
      network_error: '网络错误',
      syntax_error: '语法错误',
      other: '其他错误',
    });

    let initialized = false;
    let selectionBound = false;
    let isAnalyzing = false;
    let currentSelectedText = '';
    let lastResult = null;
    let previewExpanded = false;
    let selectionCheckTimer = null;

    function getSessionTerminal() {
      return getSessionTerminalModule?.() || null;
    }

    function getHostPayload() {
      const host = getActiveHost?.() || {};
      return {
        hostId: host.id || 'local',
        shellType: 'bash',
        platform: host.type === 'local' ? 'local' : 'linux',
      };
    }

    // ── FAB 显隐 ─────────────────────────────────────────────────────

    function showFab() {
      fabEl.classList.remove('hidden');
    }

    function hideFab() {
      fabEl.classList.add('hidden');
    }

    // ── 右键菜单 ─────────────────────────────────────────────────────

    function hideCtxMenu() {
      ctxMenuEl.classList.add('hidden');
    }

    function showCtxMenu(x, y) {
      const vpW = window.innerWidth;
      const vpH = window.innerHeight;
      const menuW = 160;
      const menuH = 48;
      const left = x + menuW > vpW ? vpW - menuW - 6 : x;
      const top = y + menuH > vpH ? vpH - menuH - 6 : y;
      ctxMenuEl.style.left = `${left}px`;
      ctxMenuEl.style.top = `${top}px`;
      ctxMenuEl.classList.remove('hidden');
    }

    // ── 面板 ─────────────────────────────────────────────────────────

    function openPanel() {
      onCloseAiPanel?.();
      panelEl.classList.remove('hidden');
    }

    function closePanel() {
      panelEl.classList.add('hidden');
      fixInsertConfirmEl.classList.add('hidden');
      // 修复3：关闭分析面板时恢复 AI Chat 面板
      document.querySelector('.ai-panel')?.classList.remove('ai-panel--hidden-by-analyze');
    }

    // ── 预览折叠 ─────────────────────────────────────────────────────

    function renderPreview(text) {
      const lines = text.split('\n');
      const needsTruncate = lines.length > 10;
      previewExpanded = false;
      previewTextEl.textContent = needsTruncate
        ? lines.slice(0, 10).join('\n') + '\n…'
        : text;
      if (needsTruncate) {
        previewToggleEl.textContent = '展开全部';
        previewToggleEl.classList.remove('hidden');
      } else {
        previewToggleEl.classList.add('hidden');
      }
    }

    function togglePreview() {
      const lines = currentSelectedText.split('\n');
      previewExpanded = !previewExpanded;
      previewTextEl.textContent = previewExpanded
        ? currentSelectedText
        : lines.slice(0, 10).join('\n') + '\n…';
      previewToggleEl.textContent = previewExpanded ? '收起' : '展开全部';
    }

    // ── 结果渲染 ─────────────────────────────────────────────────────

    function setLoading(flag) {
      isAnalyzing = flag;
      analyzeAgainBtnEl.disabled = flag;
      analyzeAgainBtnEl.textContent = flag ? '分析中…' : '重新分析';
      if (flag) {
        loadingEl.classList.remove('hidden');
        resultEl.classList.add('hidden');
      } else {
        loadingEl.classList.add('hidden');
        resultEl.classList.remove('hidden');
      }
    }

    function renderResult(result) {
      lastResult = result;

      summaryEl.textContent = result.summary || '--';

      if (result.errorType) {
        errorTypeEl.textContent = ERROR_TYPE_LABELS[result.errorType] || result.errorType;
        errorTypeEl.parentElement.classList.remove('hidden');
      } else {
        errorTypeEl.parentElement.classList.add('hidden');
      }

      if (result.fixSuggestion) {
        fixCmdEl.textContent = result.fixSuggestion;
        const risk = RISK_LABELS[result.riskLevel] || RISK_LABELS.caution;
        fixRiskEl.textContent = risk.text;
        fixRiskEl.className = `analyze-risk-badge ${risk.cls}`;
        fixInsertBtnEl.classList.toggle('hidden', result.riskLevel === 'danger');
        fixSectionEl.classList.remove('hidden');
      } else {
        fixSectionEl.classList.add('hidden');
      }

      fixInsertConfirmEl.classList.add('hidden');
    }

    // ── 分析请求 ─────────────────────────────────────────────────────

    async function runAnalysis(selectedText) {
      if (isAnalyzing) return;
      currentSelectedText = selectedText;

      openPanel();
      renderPreview(selectedText);
      setLoading(true);

      try {
        const customConfig = window.__aiApiConfig || {};
        const recentCommands = getRecentCommands?.() || [];
        const body = {
          ...getHostPayload(),
          selectedText,
          recentCommands,
        };
        if (customConfig.apiBase) body.apiBase = customConfig.apiBase;
        if (customConfig.apiKey) body.apiKey = customConfig.apiKey;
        if (customConfig.model) body.model = customConfig.model;

        const result = await requestJson('/api/ai/terminal/analyze-selection', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        renderResult(result);
      } catch (error) {
        renderResult({
          summary: `分析失败：${error.message}`,
          errorType: null,
          fixSuggestion: null,
          riskLevel: null,
        });
      } finally {
        setLoading(false);
      }
    }

    // ── 触发入口（FAB / 右键菜单 共用） ──────────────────────────────

    function triggerAnalysis() {
      const text = currentSelectedText.trim();
      if (text.length >= 3) {
        runAnalysis(currentSelectedText).catch(showErrorMessage);
      }
    }

    // ── 插入命令 ─────────────────────────────────────────────────────

    function insertCommand() {
      if (!lastResult?.fixSuggestion) return;
      const sessionTerminal = getSessionTerminal();
      if (!sessionTerminal) return;
      sessionTerminal.sendSessionInput(lastResult.fixSuggestion);
      closePanel();
      sessionTerminal.focusTerminal?.();
    }

    function handleInsertClick() {
      if (!lastResult?.fixSuggestion) return;
      if (lastResult.riskLevel === 'caution') {
        fixInsertConfirmEl.classList.remove('hidden');
        return;
      }
      insertCommand();
    }

    async function copyCommand() {
      if (!lastResult?.fixSuggestion) return;
      await navigator.clipboard.writeText(lastResult.fixSuggestion);
    }

    // ── 选区轮询 ─────────────────────────────────────────────────────

    function pollSelection() {
      const term = getSessionTerminal()?.getTerminal?.();
      if (!term) return;

      if (typeof term.hasSelection === 'function' && term.hasSelection()) {
        const selected = typeof term.getSelection === 'function' ? term.getSelection() : '';
        if (selected && selected.trim().length >= 3) {
          currentSelectedText = selected;
          showFab();
          return;
        }
      }

      hideFab();
    }

    // ── 修复2：lifecycle 驱动的延迟绑定，解决竞态问题 ────────────────

    function bindSelectionEvents() {
      if (selectionBound) return;
      const sessionTerminal = getSessionTerminal();
      const term = sessionTerminal?.getTerminal?.();
      if (!term) return;

      selectionBound = true;

      // 选区变化 → FAB 显隐
      if (typeof term.onSelectionChange === 'function') {
        term.onSelectionChange(() => {
          clearTimeout(selectionCheckTimer);
          selectionCheckTimer = setTimeout(pollSelection, 80);
        });
      }

      // 右键菜单绑定到 xterm 的 DOM 容器
      const xtermViewport = term.element;
      if (xtermViewport) {
        xtermViewport.addEventListener('contextmenu', (event) => {
          const term2 = getSessionTerminal()?.getTerminal?.();
          const hasSelection = typeof term2?.hasSelection === 'function' && term2.hasSelection();
          const selected = hasSelection && typeof term2.getSelection === 'function'
            ? term2.getSelection()
            : '';

          if (selected && selected.trim().length >= 3) {
            event.preventDefault();
            currentSelectedText = selected;
            showCtxMenu(event.clientX, event.clientY);
          } else {
            hideCtxMenu();
          }
        });
      }
    }

    function tryBindSelectionEvents() {
      if (selectionBound) return;
      // 延迟一帧确保 term.element 已挂载
      requestAnimationFrame(() => bindSelectionEvents());
    }

    // ── 初始化 ───────────────────────────────────────────────────────

    function initialize() {
      if (initialized) return;
      initialized = true;

      // 修复2：监听 lifecycle，session-ready 后再绑定选区事件
      const sessionTerminal = getSessionTerminal();
      if (sessionTerminal) {
        sessionTerminal.onLifecycle(({ type }) => {
          if (type === 'socket-connect' || type === 'session-change' || type === 'clear') {
            tryBindSelectionEvents();
          }
        });
      }

      // 也尝试立即绑定（应对已连接场景）
      tryBindSelectionEvents();

      // FAB 点击
      fabEl.addEventListener('click', triggerAnalysis);

      // 右键菜单：分析按钮
      ctxAnalyzeBtnEl.addEventListener('click', () => {
        hideCtxMenu();
        triggerAnalysis();
      });

      // 点击其他地方关闭右键菜单
      document.addEventListener('click', (event) => {
        if (!ctxMenuEl.classList.contains('hidden') && !ctxMenuEl.contains(event.target)) {
          hideCtxMenu();
        }
      });

      // 滚动 / 键盘关闭右键菜单
      document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') hideCtxMenu();
      });
      document.addEventListener('scroll', hideCtxMenu, { passive: true, capture: true });

      // 面板按钮
      panelCloseBtnEl.addEventListener('click', closePanel);
      analyzeAgainBtnEl.addEventListener('click', triggerAnalysis);
      previewToggleEl.addEventListener('click', togglePreview);

      fixCopyBtnEl.addEventListener('click', () => {
        copyCommand().catch(showErrorMessage);
      });

      fixInsertBtnEl.addEventListener('click', handleInsertClick);

      fixInsertConfirmYesEl.addEventListener('click', () => {
        fixInsertConfirmEl.classList.add('hidden');
        insertCommand();
      });

      fixInsertConfirmNoEl.addEventListener('click', () => {
        fixInsertConfirmEl.classList.add('hidden');
      });
    }

    return {
      closePanel,
      initialize,
    };
  }

  window.createTerminalAnalyzeModule = createTerminalAnalyzeModule;
})();
