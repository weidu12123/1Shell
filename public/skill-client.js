/**
 * SkillClient — 前端与 Skill Runner 通信的通用抽象层。
 *
 * 封装 Socket.IO 事件、runId 管理、回调分发。
 * 每个 Skill 页面创建自己的 SkillClient 实例，提供回调即可。
 *
 * 用法：
 *   const client = SkillClient.create({
 *     skillId: 'container-management',
 *     hostId: 'host-abc',
 *     onRender(payload) { ... },
 *     onAsk(payload, answer) { ... },
 *     onDone() { ... },
 *     onError(error) { ... },
 *     // 可选
 *     onThinking(turn) { ... },
 *     onThought(text) { ... },
 *     onExec(cmd) { ... },
 *     onExecResult(result) { ... },
 *   });
 *
 *   client.run({ action: 'list' });          // 启动
 *   client.stop();                             // 停止
 *   client.destroy();                          // 释放 socket
 */
(() => {
  'use strict';

  const CACHE_PREFIX = '1shell-skill-cache:';

  function create({
    skillId,
    hostId,
    onRender   = () => {},
    onAsk      = () => {},
    onDone     = () => {},
    onError    = () => {},
    onThinking = () => {},
    onThought  = () => {},
    onExec     = () => {},
    onExecResult = () => {},
    onCancelled  = () => {},
    onRunStarted = () => {},
  } = {}) {
    const socket = io({ transports: ['websocket', 'polling'] });

    let currentRunId = null;
    let running = false;
    let _hostId = hostId;
    let _destroyed = false;

    // ─── Socket 事件绑定 ────────────────────────────────────
    socket.on('skill:run-started', (msg) => {
      if (msg.runId !== currentRunId) return;
      running = true;
      onRunStarted(msg);
    });

    socket.on('skill:thinking', (msg) => {
      if (msg.runId !== currentRunId) return;
      onThinking(msg.turn || 0);
    });

    socket.on('skill:thought', (msg) => {
      if (msg.runId !== currentRunId) return;
      onThought(msg.text || '');
    });

    socket.on('skill:exec', (msg) => {
      if (msg.runId !== currentRunId) return;
      onExec({ toolUseId: msg.toolUseId, command: msg.command, timeout: msg.timeout });
    });

    socket.on('skill:exec-result', (msg) => {
      if (msg.runId !== currentRunId) return;
      onExecResult(msg);
    });

    socket.on('skill:render', (msg) => {
      if (msg.runId !== currentRunId) return;
      onRender(msg.payload || {}, msg.toolUseId);
    });

    socket.on('skill:ask', (msg) => {
      if (msg.runId !== currentRunId) return;
      // answer 回调：页面调用后自动提交到后端
      const answerFn = (answer) => {
        socket.emit('skill:continue', {
          runId: currentRunId,
          toolUseId: msg.toolUseId,
          answer,
        });
      };
      onAsk(msg.payload || {}, answerFn, msg.toolUseId);
    });

    socket.on('skill:done', (msg) => {
      if (msg?.runId && msg.runId !== currentRunId) return;
      running = false;
      currentRunId = null;
      onDone(msg);
    });

    socket.on('skill:error', (msg) => {
      if (msg?.runId && msg.runId !== currentRunId) return;
      running = false;
      currentRunId = null;
      onError(msg?.error || '执行出错');
    });

    socket.on('skill:cancelled', (msg) => {
      if (msg?.runId && msg.runId !== currentRunId) return;
      running = false;
      currentRunId = null;
      onCancelled();
    });

    // ─── 公开方法 ──────────────────────────────────────────
    function run(inputs = {}) {
      if (_destroyed) return;
      const runId = `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      currentRunId = runId;
      running = true;
      socket.emit('skill:run', {
        runId,
        skillId,
        hostId: _hostId,
        inputs,
      }, (res) => {
        if (!res.ok) {
          running = false;
          currentRunId = null;
          onError(res.error || '启动失败');
        }
      });
      return runId;
    }

    function stop() {
      if (!currentRunId) return;
      socket.emit('skill:stop', { runId: currentRunId });
      running = false;
      currentRunId = null;
    }

    function setHostId(id) {
      _hostId = id;
    }

    function isRunning() {
      return running;
    }

    function destroy() {
      _destroyed = true;
      stop();
      socket.disconnect();
    }

    // ─── 缓存工具 ──────────────────────────────────────────
    function cacheKey(action) {
      return `${CACHE_PREFIX}${skillId}:${_hostId}:${action}`;
    }

    function saveToCache(action, payload) {
      try {
        sessionStorage.setItem(cacheKey(action), JSON.stringify({
          ts: Date.now(),
          payload,
        }));
      } catch { /* quota exceeded — ignore */ }
    }

    function loadFromCache(action, maxAgeMs = 120000) {
      try {
        const raw = sessionStorage.getItem(cacheKey(action));
        if (!raw) return null;
        const { ts, payload } = JSON.parse(raw);
        if (Date.now() - ts > maxAgeMs) return null;
        return payload;
      } catch { return null; }
    }

    return Object.freeze({
      run,
      stop,
      setHostId,
      isRunning,
      destroy,
      saveToCache,
      loadFromCache,
    });
  }

  window.SkillClient = Object.freeze({ create });
})();