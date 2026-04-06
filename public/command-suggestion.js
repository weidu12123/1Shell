(() => {
  'use strict';

  function createCommandSuggestionModule({
    getActiveHost,
    getSessionTerminalModule,
    requestJson,
    showErrorMessage,
  }) {
    const cmdInlinePanelEl = document.getElementById('cmd-inline-panel');
    const cmdSuggestBtnEl = document.getElementById('cmd-suggest-btn');
    const cmdCloseBtnEl = document.getElementById('cmd-close-btn');
    const cmdPromptEl = document.getElementById('cmd-prompt');
    const cmdGenerateBtnEl = document.getElementById('cmd-generate-btn');
    const cmdResultEl = document.getElementById('cmd-result');
    const cmdResultCodeEl = document.getElementById('cmd-result-code');
    const cmdCopyBtnEl = document.getElementById('cmd-copy-btn');
    const cmdInsertBtnEl = document.getElementById('cmd-insert-btn');
    let initialized = false;
    let commandSuggestion = '';
    let isGenerating = false;

    function getSessionTerminal() {
      return getSessionTerminalModule?.() || null;
    }

    function resetResult() {
      commandSuggestion = '';
      cmdResultCodeEl.textContent = '';
      cmdResultEl.classList.add('hidden');
    }

    function setGenerating(flag) {
      isGenerating = flag;
      cmdGenerateBtnEl.disabled = flag;
      cmdGenerateBtnEl.textContent = flag ? '生成中…' : '生成命令';
    }

    function getHostPromptPrefix() {
      const host = getActiveHost?.() || null;
      if (!host) return '';
      if (host.type === 'local') {
        return '[当前主机: 本机 / 本地 Shell]\n';
      }
      return `[当前主机: ${host.name} / ${host.username}@${host.host}:${host.port}]\n`;
    }

    function openCmdModal() {
      cmdPromptEl.value = '';
      resetResult();
      cmdInlinePanelEl.classList.remove('hidden');
      cmdPromptEl.focus();
      // 面板展开后终端高度缩小，触发 refit 并滚到最新输出
      setTimeout(() => {
        window.dispatchEvent(new Event('resize'));
        getSessionTerminal()?.getTerminal?.()?.scrollToBottom?.();
      }, 60);
    }

    function closeCmdModal() {
      cmdInlinePanelEl.classList.add('hidden');
      // 面板收起后终端高度恢复，触发 refit
      setTimeout(() => window.dispatchEvent(new Event('resize')), 30);
    }

    async function generateCommandSuggestion() {
      const prompt = cmdPromptEl.value.trim();
      if (!prompt || isGenerating) return;

      resetResult();
      setGenerating(true);

      try {
        const customConfig = window.__aiApiConfig || {};
        const body = {
          prefix: `${getHostPromptPrefix()}${prompt}`,
          mode: 'command',
        };
        if (customConfig.apiBase) body.apiBase = customConfig.apiBase;
        if (customConfig.apiKey) body.apiKey = customConfig.apiKey;
        if (customConfig.model) body.model = customConfig.model;

        const response = await requestJson('/api/complete', {
          method: 'POST',
          body: JSON.stringify(body),
        });

        commandSuggestion = response.completion || '';
        cmdResultCodeEl.textContent = commandSuggestion || '未生成结果';
        cmdResultEl.classList.remove('hidden');
      } finally {
        setGenerating(false);
      }
    }

    async function copyCommandSuggestion() {
      if (!commandSuggestion) return;
      await navigator.clipboard.writeText(commandSuggestion);
    }

    function insertCommandSuggestion() {
      const sessionTerminalModule = getSessionTerminal();
      if (!commandSuggestion || !sessionTerminalModule) return;
      if (!sessionTerminalModule.sendSessionInput(commandSuggestion)) return;
      closeCmdModal();
      sessionTerminalModule.focusTerminal();
    }

    function initialize() {
      if (initialized) return;
      initialized = true;

      cmdSuggestBtnEl.addEventListener('click', openCmdModal);
      cmdCloseBtnEl.addEventListener('click', closeCmdModal);
      cmdGenerateBtnEl.addEventListener('click', () => {
        generateCommandSuggestion().catch(showErrorMessage);
      });
      cmdPromptEl.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          generateCommandSuggestion().catch(showErrorMessage);
        }
      });
      cmdCopyBtnEl.addEventListener('click', () => {
        copyCommandSuggestion().catch(showErrorMessage);
      });
      cmdInsertBtnEl.addEventListener('click', insertCommandSuggestion);
    }

    return {
      closeCmdModal,
      generateCommandSuggestion,
      initialize,
      openCmdModal,
    };
  }

  window.createCommandSuggestionModule = createCommandSuggestionModule;
})();
