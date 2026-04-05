(() => {
  'use strict';

  function createTerminalAiModule({
    getActiveHost,
    getSessionTerminalModule,
    requestJson,
  }) {
    const overlayEl = document.getElementById('terminal-ai-overlay');
    const ghostTextEl = document.getElementById('terminal-ghost-text');
    const ghostHintEl = document.getElementById('terminal-ghost-hint');
    const DEBOUNCE_MS = 600;
    const MIN_INPUT_LENGTH = 3;
    // SSH 回显延迟可能较高，放宽到 1.5 秒
    const OUTPUT_ECHO_GRACE_MS = 1500;
    const state = {
      initialized: false,
      bound: false,
      inputBuffer: '',
      pendingTimer: null,
      latestRequestId: 0,
      activeRequestId: 0,
      ghostText: '',
      hasSelection: false,
      lastUserInputAt: 0,
      pendingEcho: '',
      outputEchoBuffer: '',
      recentCommands: [],
      // 追踪是否在 ANSI 转义序列中
      inEscapeSequence: false,
    };

    function getSessionTerminal() {
      return getSessionTerminalModule?.() || null;
    }

    function getTerminal() {
      return getSessionTerminal()?.getTerminal?.() || null;
    }

    function getHostPayload() {
      const host = getActiveHost?.() || {};
      return {
        hostId: host.id || 'local',
        shellType: 'bash',
        platform: host.type === 'local' ? 'local' : 'linux',
        arch: '',
        cwd: '',
      };
    }

    function resetTimer() {
      if (!state.pendingTimer) return;
      clearTimeout(state.pendingTimer);
      state.pendingTimer = null;
    }

    function clearGhostText() {
      state.ghostText = '';
      overlayEl.classList.add('hidden');
      overlayEl.setAttribute('aria-hidden', 'true');
      ghostTextEl.textContent = '';
      ghostHintEl.textContent = '';
    }

    function invalidatePending(reason = '') {
      resetTimer();
      state.activeRequestId = 0;
      if (reason !== 'echo-buffer-only') {
        clearGhostText();
      }
      if (reason === 'selection') {
        state.hasSelection = true;
      }
    }

    function resetInputState() {
      state.inputBuffer = '';
      state.hasSelection = false;
      state.pendingEcho = '';
      state.outputEchoBuffer = '';
      invalidatePending();
    }

    function rememberCommittedCommand(rawCommand) {
      const command = String(rawCommand || '').trim();
      if (!command) return;
      state.recentCommands = [...state.recentCommands, command].slice(-5);
    }

    function applyPrintableChunk(text) {
      if (!text) return;
      state.inputBuffer += text;
      state.pendingEcho += text;
      state.hasSelection = false;
      invalidatePending('echo-buffer-only');
      scheduleCompletion();
    }

    function applyBackspace(count) {
      if (!count) return;
      state.inputBuffer = state.inputBuffer.slice(0, -count);
      state.pendingEcho = state.pendingEcho.slice(0, -count);
      invalidatePending('echo-buffer-only');
      scheduleCompletion();
    }

    /**
     * 解析用户输入数据，正确处理 ANSI 转义序列。
     *
     * 关键修复：方向键等控制序列发送 ESC + [ + 字母，
     * 旧实现只识别 ESC 字节，后续的 [ 和字母被误判为可打印字符。
     */
    function splitControlSequence(data) {
      if (!data) {
        return { printableText: '', backspaceCount: 0, hasControl: false, submitted: false, cleared: false };
      }

      let printableText = '';
      let backspaceCount = 0;
      let hasControl = false;
      let submitted = false;
      let cleared = false;
      let inEsc = false;
      let inCsi = false; // CSI: ESC [

      const chars = String(data);
      for (let i = 0; i < chars.length; i++) {
        const char = chars[i];
        const code = chars.charCodeAt(i);

        // 正在处理 CSI 序列：ESC [ ... 终止字符（@-~, 0x40-0x7E）
        if (inCsi) {
          if (code >= 0x40 && code <= 0x7E) {
            // CSI 序列结束
            inCsi = false;
          }
          // CSI 序列中的所有字符都跳过
          continue;
        }

        // 正在处理 ESC 后的第一个字符
        if (inEsc) {
          inEsc = false;
          if (char === '[') {
            // 进入 CSI 序列
            inCsi = true;
            continue;
          }
          // 其他 ESC 序列（如 ESC O x），跳过这一个字符
          continue;
        }

        // ESC 字节
        if (code === 0x1B) {
          hasControl = true;
          inEsc = true;
          continue;
        }

        // 回车/换行 → 提交
        if (char === '\r' || char === '\n') {
          hasControl = true;
          submitted = true;
          continue;
        }

        // Ctrl+C / Ctrl+D / Ctrl+U → 清除
        if (code === 0x03 || code === 0x04 || code === 0x15) {
          hasControl = true;
          cleared = true;
          continue;
        }

        // Ctrl+L → 清屏但不清除 input
        if (code === 0x0C) {
          hasControl = true;
          continue;
        }

        // DEL (退格)
        if (code === 0x7F) {
          hasControl = true;
          backspaceCount += 1;
          continue;
        }

        // Tab
        if (code === 0x09) {
          hasControl = true;
          continue;
        }

        // 其他控制字符跳过
        if (code < 0x20) {
          hasControl = true;
          continue;
        }

        // 可打印字符
        printableText += char;
      }

      return { printableText, backspaceCount, hasControl, submitted, cleared };
    }

    function handleInputMirror(data) {
      if (!data) return;
      state.lastUserInputAt = Date.now();

      const parsed = splitControlSequence(data);

      if (parsed.cleared) {
        state.inputBuffer = '';
        state.pendingEcho = '';
        state.outputEchoBuffer = '';
        invalidatePending();
      }

      if (parsed.backspaceCount) {
        applyBackspace(parsed.backspaceCount);
      }

      if (parsed.printableText) {
        applyPrintableChunk(parsed.printableText);
      }

      if (parsed.submitted) {
        rememberCommittedCommand(state.inputBuffer);
        state.inputBuffer = '';
        state.pendingEcho = '';
        state.outputEchoBuffer = '';
        invalidatePending();
      }

      // 纯控制序列（如方向键）只清除 ghost，不干扰 inputBuffer
      if (parsed.hasControl && !parsed.backspaceCount && !parsed.printableText && !parsed.submitted && !parsed.cleared) {
        invalidatePending();
      }
    }

    /**
     * 判断终端输出是否为本地回显。
     *
     * 改进：
     * 1. 放宽时间窗口到 1.5 秒（SSH 高延迟场景）
     * 2. 用子串包含 + 前缀匹配双重策略
     * 3. 输出为纯空白（光标移动等）时不触发 invalidate
     */
    function normalizeTerminalOutput(output) {
      return String(output || '')
        .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/gu, '')
        .replace(/\u001b[@-_]/gu, '')
        .replace(/\u001b\].*?(?:\u0007|\u001b\\)/gu, '') // OSC 序列
        .replace(/\r/g, '')
        .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
    }

    function isLikelyLocalEcho(output) {
      if (!output) return false;

      const normalizedOutput = normalizeTerminalOutput(output);

      // 纯空白输出（光标移动、颜色重置等）不应触发 invalidate
      if (!normalizedOutput.trim()) return true;

      // 无等待回显时，检查是否是 prompt 刷新
      if (!state.pendingEcho) {
        // 如果最近刚输入且输出很短（< 10字符），可能是 prompt 部分刷新
        if (Date.now() - state.lastUserInputAt < OUTPUT_ECHO_GRACE_MS && normalizedOutput.length < 10) {
          return true;
        }
        return false;
      }

      if (Date.now() - state.lastUserInputAt > OUTPUT_ECHO_GRACE_MS) return false;

      // 累积输出缓冲区
      state.outputEchoBuffer = `${state.outputEchoBuffer}${normalizedOutput}`.slice(
        -Math.max(512, state.pendingEcho.length * 4)
      );

      // 策略1：缓冲区包含等待回显的完整文本
      if (state.outputEchoBuffer.includes(state.pendingEcho)) {
        state.pendingEcho = '';
        state.outputEchoBuffer = '';
        return true;
      }

      // 策略2：等待回显以输出结尾（逐字符回显场景）
      if (state.pendingEcho.endsWith(normalizedOutput)) {
        return true;
      }

      // 策略3：输出是等待回显的前缀或子串（部分回显）
      if (state.pendingEcho.includes(normalizedOutput)) {
        return true;
      }

      return false;
    }

    function acceptGhostText() {
      const sessionTerminal = getSessionTerminal();
      if (!sessionTerminal || !state.ghostText) return false;

      const accepted = state.ghostText;
      const ok = sessionTerminal.sendSessionInput(accepted, { source: 'terminal-ai-ghost' });
      if (!ok) return false;

      state.inputBuffer += accepted;
      clearGhostText();
      return true;
    }

    function shouldRequestCompletion() {
      if (state.hasSelection) return false;
      if (state.ghostText) return false;
      if (state.inputBuffer.trim().length < MIN_INPUT_LENGTH) return false;

      const term = getTerminal();
      if (!term) return false;
      if (typeof term.hasSelection === 'function' && term.hasSelection()) return false;
      return true;
    }

    function renderGhostText(completion) {
      state.ghostText = completion;
      ghostTextEl.textContent = completion;
      ghostHintEl.textContent = 'Tab / → 采纳，Esc 拒绝';
      overlayEl.classList.remove('hidden');
      overlayEl.setAttribute('aria-hidden', 'false');
    }

    async function requestInlineCompletion(requestId, inputSnapshot) {
      try {
        const response = await requestJson('/api/ai/terminal/complete-inline', {
          method: 'POST',
          body: JSON.stringify({
            ...getHostPayload(),
            currentInput: inputSnapshot,
            cursorIndex: inputSnapshot.length,
            recentCommands: state.recentCommands,
          }),
        });

        // 竞态检查：请求返回时，用户可能已有新输入
        if (requestId !== state.activeRequestId) return;
        if (inputSnapshot !== state.inputBuffer) return;

        const completion = String(response.completion || '');
        if (!completion) {
          clearGhostText();
          return;
        }

        renderGhostText(completion);
      } catch (_) {
        if (requestId === state.activeRequestId) {
          clearGhostText();
        }
      }
    }

    function scheduleCompletion() {
      resetTimer();
      if (!shouldRequestCompletion()) return;

      state.pendingTimer = setTimeout(() => {
        state.pendingTimer = null;

        if (!shouldRequestCompletion()) return;
        const inputSnapshot = state.inputBuffer;
        const requestId = state.latestRequestId + 1;
        state.latestRequestId = requestId;
        state.activeRequestId = requestId;
        requestInlineCompletion(requestId, inputSnapshot);
      }, DEBOUNCE_MS);
    }

    function syncSelectionState() {
      const term = getTerminal();
      if (!term || typeof term.hasSelection !== 'function') return;

      state.hasSelection = term.hasSelection();
      if (state.hasSelection) {
        invalidatePending('selection');
      }
    }

    function attachKeyboardInterception() {
      const term = getTerminal();
      if (!term || typeof term.attachCustomKeyEventHandler !== 'function') return;

      term.attachCustomKeyEventHandler((event) => {
        if (!state.ghostText) return true;

        if (event.type !== 'keydown') return true;

        if (event.key === 'Tab' || event.key === 'ArrowRight') {
          event.preventDefault();
          return !acceptGhostText();
        }

        if (event.key === 'Escape') {
          clearGhostText();
          event.preventDefault();
          return false;
        }

        if (event.key === 'ArrowLeft' || event.key === 'ArrowUp' || event.key === 'ArrowDown') {
          invalidatePending();
        }

        return true;
      });
    }

    function tryBind() {
      if (state.bound) return;

      const sessionTerminal = getSessionTerminal();
      const term = getTerminal();
      if (!sessionTerminal || !term) return;

      state.bound = true;

      sessionTerminal.onInput(({ data, meta }) => {
        if (meta?.source === 'terminal-ai-ghost') return;
        handleInputMirror(String(data || ''));
      });

      sessionTerminal.onOutput(({ data }) => {
        if (isLikelyLocalEcho(String(data || ''))) {
          return;
        }
        // 收到非回显输出意味着有新内容（命令结果），清除补全
        invalidatePending();
      });

      sessionTerminal.onLifecycle(({ type }) => {
        if (['clear', 'reset', 'session-change', 'host-switch-start', 'socket-disconnect', 'session-error'].includes(type)) {
          resetInputState();
        }
      });

      if (typeof term.onSelectionChange === 'function') {
        term.onSelectionChange(() => syncSelectionState());
      }

      attachKeyboardInterception();
    }

    function initialize() {
      if (state.initialized) return;
      state.initialized = true;
      clearGhostText();
      tryBind();

      // 如果初始化时终端尚未就绪，延迟重试绑定
      if (!state.bound) {
        const retryInterval = setInterval(() => {
          tryBind();
          if (state.bound) clearInterval(retryInterval);
        }, 500);
        // 最多重试 20 秒
        setTimeout(() => clearInterval(retryInterval), 20000);
      }
    }

    return {
      clearGhostText,
      getRecentCommands: () => [...state.recentCommands],
      initialize,
      resetInputState,
    };
  }

  window.createTerminalAiModule = createTerminalAiModule;
})();
