// useAgentXterm.ts — MainConsole 刀 5b · 嵌入式 xterm 多实例管理器
// 复用 21.1 节 ResizeObserver + RAF 模式，改成 per-instance multi-session 架构
// 与 useSessionTerminal 零耦合（方案 A Phase 0 拍板）

import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

export interface AgentXtermInstance {
  terminal: Terminal;
  fitAddon: FitAddon;
  containerEl: HTMLElement;
  resizeObserver: ResizeObserver;
}

export interface AgentXtermApi {
  createInstance(sessionKey: string, parentEl: HTMLElement): AgentXtermInstance;
  destroyInstance(sessionKey: string): void;
  switchToInstance(sessionKey: string): void;
  fitInstance(sessionKey: string): void;
  getAllKeys(): string[];
}

const instances = new Map<string, AgentXtermInstance>();

export function useAgentXterm(): AgentXtermApi {
  function createInstance(sessionKey: string, parentEl: HTMLElement): AgentXtermInstance {
    if (instances.has(sessionKey)) {
      throw new Error(`AgentXterm instance "${sessionKey}" already exists`);
    }

    // 1:1 复刻 agent-panel.js:68-90 — containerEl + Terminal + FitAddon
    const containerEl = document.createElement('div');
    containerEl.className = 'agent-session-term w-full h-full hidden rounded-lg overflow-hidden';
    containerEl.dataset.sessionKey = sessionKey;
    parentEl.appendChild(containerEl);

    const terminal = new Terminal({
      cursorBlink: true,
      cursorStyle: 'block',
      fontSize: 12,
      fontFamily: '"Cascadia Code", "JetBrains Mono", Consolas, monospace',
      lineHeight: 1.2,
      scrollback: 3000,
      theme: {
        background: '#09111f',
        foreground: '#dbeafe',
        cursor: '#7c3aed',
        selectionBackground: 'rgba(124, 58, 237, 0.28)',
      },
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(containerEl);

    // 21.1 节 ResizeObserver + RAF 模式（per-instance）
    // 复刻 useSessionTerminal.ts:mount 逻辑，但改成多实例
    const resizeObserver = new ResizeObserver(() => {
      // 只在当前实例可见时 fit（hidden 时跳过，避免 fit 报错）
      if (containerEl.classList.contains('hidden')) return;
      // RAF 延迟 fit，避免 ResizeObserver loop limit exceeded
      requestAnimationFrame(() => {
        try {
          fitAddon.fit();
        } catch {
          // 容器尺寸为 0 时 fit 会抛错，静默忽略
        }
      });
    });

    // 21.1 节修复：等容器高度非 0 后再 observe（避免初始 fit 报错）
    const waitForNonZeroHeight = () => {
      if (containerEl.clientHeight > 0) {
        resizeObserver.observe(containerEl);
        try {
          fitAddon.fit();
        } catch {
          /* 静默 */
        }
      } else {
        requestAnimationFrame(waitForNonZeroHeight);
      }
    };
    requestAnimationFrame(waitForNonZeroHeight);

    const instance: AgentXtermInstance = { terminal, fitAddon, containerEl, resizeObserver };
    instances.set(sessionKey, instance);
    return instance;
  }

  function destroyInstance(sessionKey: string): void {
    const inst = instances.get(sessionKey);
    if (!inst) return;
    inst.resizeObserver.disconnect();
    inst.terminal.dispose();
    inst.containerEl.remove();
    instances.delete(sessionKey);
  }

  function switchToInstance(sessionKey: string): void {
    // 1:1 复刻 agent-panel.js:135-155 — 切换 hidden class + fit + focus
    for (const [key, inst] of instances) {
      inst.containerEl.classList.toggle('hidden', key !== sessionKey);
    }
    const inst = instances.get(sessionKey);
    if (inst) {
      // 50ms 延迟 fit + focus（与老版 agent-panel.js:146-149 一致）
      setTimeout(() => {
        try {
          inst.fitAddon.fit();
        } catch {
          /* 静默 */
        }
        inst.terminal.focus();
      }, 50);
    }
  }

  function fitInstance(sessionKey: string): void {
    const inst = instances.get(sessionKey);
    if (!inst) return;
    try {
      inst.fitAddon.fit();
    } catch {
      /* 静默 */
    }
  }

  function getAllKeys(): string[] {
    return [...instances.keys()];
  }

  return {
    createInstance,
    destroyInstance,
    switchToInstance,
    fitInstance,
    getAllKeys,
  };
}
