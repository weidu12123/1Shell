(() => {
  'use strict';

  // 常见命令字典（按优先级排序，靠前的优先匹配）
  const COMMON_COMMANDS = [
    // 高频 Linux/Mac 工具
    'git', 'docker', 'kubectl', 'sudo', 'ssh', 'curl', 'wget',
    'ls', 'cat', 'grep', 'find', 'ps', 'kill', 'mkdir', 'rm', 'cp', 'mv',
    'echo', 'cd', 'pwd', 'touch', 'ln', 'chmod', 'chown', 'stat', 'df', 'du',
    'vim', 'nano', 'vi', 'less', 'more', 'man',
    'systemctl', 'journalctl', 'service',
    'apt', 'apt-get', 'yum', 'dnf', 'pacman', 'brew',
    'npm', 'npx', 'yarn', 'pnpm', 'pip', 'pip3',
    'python', 'python3', 'node', 'go', 'java', 'ruby', 'php',
    'rustc', 'cargo', 'make', 'cmake', 'gradle', 'mvn',
    'helm', 'terraform', 'ansible', 'vagrant',
    // 文本处理
    'sed', 'awk', 'sort', 'uniq', 'cut', 'head', 'tail',
    'wc', 'tr', 'xargs', 'tee', 'diff', 'patch',
    // 网络
    'ping', 'netstat', 'ss', 'ip', 'ifconfig', 'nmap',
    'dig', 'host', 'nslookup', 'traceroute', 'scp', 'rsync', 'nc',
    // 压缩归档
    'tar', 'zip', 'unzip', 'gzip', 'gunzip', 'bzip2', 'xz',
    // 系统监控
    'top', 'htop', 'free', 'vmstat', 'iostat', 'sar',
    'lsof', 'strace', 'ltrace', 'perf',
    // 系统信息
    'uname', 'hostname', 'uptime', 'who', 'whoami', 'id', 'w',
    'which', 'whereis', 'type', 'env', 'export', 'alias', 'history',
    // 进程/会话
    'screen', 'tmux', 'nohup', 'at', 'crontab', 'watch',
    // 权限/挂载
    'mount', 'umount', 'lsblk', 'fdisk', 'blkid', 'chroot',
    'useradd', 'usermod', 'userdel', 'groupadd', 'passwd',
    // 其他 Shell
    'bash', 'sh', 'zsh', 'fish', 'dash',
    // 数据库客户端
    'mysql', 'psql', 'redis-cli', 'mongo', 'sqlite3',
    // 安全/加密
    'openssl', 'ssh-keygen', 'gpg', 'base64',
    // 云/容器
    'aws', 'az', 'gcloud', 'doctl', 'minikube', 'kind', 'podman',
    // 其他常用
    'jq', 'yq', 'fzf', 'bat', 'fd', 'rg', 'ripgrep', 'eza',
    'nginx', 'apache2', 'httpd', 'php-fpm',
    'composer', 'gem', 'conda', 'pipenv', 'poetry',
    'svn', 'hg',
    // Windows 常用
    'dir', 'copy', 'del', 'move', 'ren', 'md', 'rd', 'rmdir',
    'ipconfig', 'tasklist', 'taskkill', 'powershell', 'where',
    'cls', 'attrib', 'chkdsk', 'sfc', 'reg', 'sc', 'runas',
    'shutdown', 'systeminfo', 'robocopy', 'xcopy', 'findstr', 'notepad',
    'diskpart', 'format', 'net', 'netsh',
  ];

  const COMMON_COMMANDS_SET = new Set(COMMON_COMMANDS);

  function createTerminalAiModule({
    escapeHtml,
    getActiveHost,
    getSessionTerminalModule,
    requestJson,
  }) {
    const overlayEl = document.getElementById('terminal-ai-overlay');
    const ghostTextEl = document.getElementById('terminal-ghost-text');
    const ghostHintEl = document.getElementById('terminal-ghost-hint');
    const inlinePreviewEl = document.getElementById('terminal-inline-preview');
    const suggestionBoxEl = document.getElementById('terminal-inline-suggestion-box');
    const suggestionTextEl = document.getElementById('terminal-inline-suggestion-text');
    const DEBOUNCE_MS = 600;
    // SSH 回显延迟可能较高，放宽到 1.5 秒
    const OUTPUT_ECHO_GRACE_MS = 1500;
    const state = {
      initialized: false,
      bound: false,
      inputBuffer: '',
      pendingTimer: null,
      latestRequestId: 0,
      activeRequestId: 0,
      activeRequestInput: '',
      pendingAcceptanceRequestId: 0,
      ghostText: '',
      hasSelection: false,
      lastUserInputAt: 0,
      pendingEcho: '',
      outputEchoBuffer: '',
      recentCommands: [],
      lastGhostRenderedAt: 0,
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
      if (inlinePreviewEl) {
        inlinePreviewEl.textContent = '';
        inlinePreviewEl.classList.add('hidden');
      }
      updateSuggestionBox();
    }

    function invalidatePending(reason = '') {
      resetTimer();
      state.activeRequestId = 0;
      state.activeRequestInput = '';
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

    function updateSuggestionBox() {
      const el = document.getElementById('terminal-inline-suggestion-text');
      if (!el) return;
      if (state.ghostText) {
        el.textContent = state.inputBuffer + state.ghostText;
      } else {
        el.textContent = '等待输入…';
      }
    }

    // 本地字典补全：取输入行最后一个词（sudo/env 等前缀后的实际命令也能匹配）
    function tryLocalCompletion(input) {
      const trimmed = input.trim();
      if (!trimmed) return '';
      // 取最后一个以空格分隔的词作为待补全片段
      const words = trimmed.split(/\s+/);
      const lastWord = words[words.length - 1];
      if (!lastWord) return '';
      const match = COMMON_COMMANDS.find(
        (cmd) => cmd.startsWith(lastWord) && cmd.length > lastWord.length
      );
      if (!match) return '';
      return match.slice(lastWord.length);
    }

    function applyPrintableChunk(text) {
      if (!text) return;
      state.inputBuffer += text;
      state.pendingEcho += text;
      state.hasSelection = false;
      // 取消未发出的 AI 请求计时器，重置请求 ID
      resetTimer();
      state.activeRequestId = 0;
      state.activeRequestInput = '';

      const local = tryLocalCompletion(state.inputBuffer);
      if (local) {
        renderGhostText(local);
        return;
      }
      clearGhostText();
      scheduleCompletion();
    }

    function applyBackspace(count) {
      if (!count) return;
      state.inputBuffer = state.inputBuffer.slice(0, -count);
      state.pendingEcho = state.pendingEcho.slice(0, -count);
      resetTimer();
      state.activeRequestId = 0;
      state.activeRequestInput = '';

      const local = tryLocalCompletion(state.inputBuffer);
      if (local) {
        renderGhostText(local);
        return;
      }
      clearGhostText();
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
        return { printableText: '', backspaceCount: 0, hasControl: false, submitted: false, cleared: false, hasTab: false };
      }

      let printableText = '';
      let backspaceCount = 0;
      let hasControl = false;
      let submitted = false;
      let cleared = false;
      let hasTab = false;
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
          hasTab = true;
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

      return { printableText, backspaceCount, hasControl, submitted, cleared, hasTab };
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
      // Tab 无 ghost text 时由 shell 处理，不取消 AI 请求，让建议框继续更新
      if (parsed.hasControl && !parsed.hasTab && !parsed.backspaceCount && !parsed.printableText && !parsed.submitted && !parsed.cleared) {
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
      const trimmedOutput = normalizedOutput.trim();
      const now = Date.now();

      // 纯空白输出（光标移动、颜色重置等）不应触发 invalidate
      if (!trimmedOutput) return true;

      // ghost 刚渲染后，短时间内的短输出大概率是 prompt 刷新/光标移动，不应立刻清空
      if (state.ghostText && now - state.lastGhostRenderedAt < 1200 && normalizedOutput.length <= 16) {
        return true;
      }

      // 无等待回显时，检查是否是 prompt 刷新
      if (!state.pendingEcho) {
        if (now - state.lastUserInputAt < OUTPUT_ECHO_GRACE_MS && normalizedOutput.length < 10) {
          return true;
        }
        return false;
      }

      if (now - state.lastUserInputAt > OUTPUT_ECHO_GRACE_MS) return false;

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

      // 策略4：已显示 ghost 时，短输出如果是当前输入或补全文本的前缀，也视为局部回显
      if (state.ghostText && normalizedOutput.length <= Math.max(16, state.inputBuffer.length + state.ghostText.length)) {
        const currentLine = `${state.inputBuffer}${state.ghostText}`;
        if (currentLine.includes(trimmedOutput) || currentLine.startsWith(trimmedOutput)) {
          return true;
        }
      }

      return false;
    }

    function acceptGhostText() {
      const sessionTerminal = getSessionTerminal();
      if (!sessionTerminal || !state.ghostText) return false;

      const accepted = state.ghostText;
      const requestId = state.activeRequestId;
      const requestInput = state.activeRequestInput;
      const ok = sessionTerminal.sendSessionInput(accepted, { source: 'terminal-ai-ghost' });
      if (!ok) return false;

      state.inputBuffer += accepted;
      clearGhostText();

      if (requestId && requestInput) {
        state.pendingAcceptanceRequestId = requestId;
        state.activeRequestId = 0;
        state.activeRequestInput = '';
      }

      return true;
    }

    function shouldRequestCompletion() {
      if (state.hasSelection) return false;
      if (state.ghostText) return false;

      // 只对已知命令 + 参数（含空格）才调 AI，纯命令名前缀由本地字典处理
      const trimmed = state.inputBuffer.trim();
      if (!trimmed.includes(' ')) return false;
      const baseCmd = trimmed.split(/\s+/)[0];
      if (!COMMON_COMMANDS_SET.has(baseCmd)) return false;

      const term = getTerminal();
      if (!term) return false;
      if (typeof term.hasSelection === 'function' && term.hasSelection()) return false;
      return true;
    }

    function renderGhostText(completion) {
      state.ghostText = completion;
      state.lastGhostRenderedAt = Date.now();
      ghostTextEl.textContent = completion;
      ghostHintEl.textContent = 'Tab / → 采纳，Esc 拒绝';
      overlayEl.classList.remove('hidden');
      overlayEl.setAttribute('aria-hidden', 'false');
      updateSuggestionBox();
    }

    async function requestInlineCompletion(requestId, inputSnapshot) {
      try {
        const customConfig = window.__aiApiConfig || {};
        const body = {
          ...getHostPayload(),
          currentInput: inputSnapshot,
          cursorIndex: inputSnapshot.length,
          recentCommands: state.recentCommands,
        };
        if (customConfig.apiBase) body.apiBase = customConfig.apiBase;
        if (customConfig.apiKey) body.apiKey = customConfig.apiKey;
        if (customConfig.model) body.model = customConfig.model;

        const response = await requestJson('/api/ai/terminal/complete-inline', {
          method: 'POST',
          body: JSON.stringify(body),
        });

        // 竞态检查：请求返回时，用户可能已有新输入
        if (requestId === state.pendingAcceptanceRequestId && inputSnapshot === state.inputBuffer) {
          state.pendingAcceptanceRequestId = 0;
          return;
        }
        if (requestId !== state.activeRequestId) return;
        if (inputSnapshot !== state.inputBuffer) return;

        const completion = String(response.completion || '');
        if (!completion) {
          clearGhostText();
          return;
        }

        renderGhostText(completion);
      } catch (e) {
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
        state.activeRequestInput = inputSnapshot;
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
        const output = String(data || '');
        if (isLikelyLocalEcho(output)) {
          return;
        }
        if (state.ghostText && Date.now() - state.lastGhostRenderedAt < 1200) {
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
