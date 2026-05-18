import { onBeforeUnmount, shallowRef, markRaw } from 'vue';
import { Terminal, type ITerminalOptions, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';

export interface UseTerminalOptions {
  fontFamily?: string;
  fontSize?: number;
  theme?: ITheme;
  cursorBlink?: boolean;
  scrollback?: number;
}

const DEFAULT_FONT =
  '"Cascadia Code", "JetBrains Mono", "Fira Code", Consolas, monospace';

export function useTerminal(opts: UseTerminalOptions = {}) {
  const term = shallowRef<Terminal | null>(null);
  const fitAddon = shallowRef<FitAddon | null>(null);
  let disposed = false;

  function mount(container: HTMLElement): Terminal {
    if (disposed) throw new Error('useTerminal: instance already disposed');
    const terminalOpts: ITerminalOptions = {
      fontFamily: opts.fontFamily ?? DEFAULT_FONT,
      fontSize: opts.fontSize ?? 13,
      cursorBlink: opts.cursorBlink ?? true,
      scrollback: opts.scrollback ?? 5000,
      theme: opts.theme,
      allowTransparency: true,
    };
    const t = markRaw(new Terminal(terminalOpts));
    const fa = markRaw(new FitAddon());
    const wa = markRaw(new WebLinksAddon());
    t.loadAddon(fa);
    t.loadAddon(wa);
    t.open(container);
    queueMicrotask(() => {
      try { fa.fit(); } catch { /* container not yet sized */ }
    });
    term.value = t;
    fitAddon.value = fa;
    return t;
  }

  function fit(): void {
    try { fitAddon.value?.fit(); } catch { /* ignore */ }
  }

  function write(data: string): void {
    term.value?.write(data);
  }

  function clear(): void {
    term.value?.clear();
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    try { term.value?.dispose(); } catch { /* ignore */ }
    term.value = null;
    fitAddon.value = null;
  }

  onBeforeUnmount(dispose);

  return { term, mount, fit, write, clear, dispose };
}
