export interface DesktopSettings {
  isDesktop: boolean;
  runtime?: 'electron' | 'tauri';
  backgroundEnabled: boolean;
  autostartEnabled: boolean;
  autostartAvailable: boolean;
}

type TauriCore = {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
};

type OneShellDesktopBridge = {
  runtime?: string;
  platform?: string;
  getSettings?: () => Promise<DesktopSettings>;
  setBackgroundEnabled?: (enabled: boolean) => Promise<DesktopSettings>;
  setAutostartEnabled?: (enabled: boolean) => Promise<DesktopSettings>;
};

declare global {
  interface Window {
    __ONESHELL_RUNTIME__?: string;
    __TAURI__?: {
      core?: TauriCore;
    };
    oneShellDesktop?: OneShellDesktopBridge;
  }
}

function tauriCore(): TauriCore | null {
  return window.__TAURI__?.core || null;
}

function electronBridge(): OneShellDesktopBridge | null {
  return window.oneShellDesktop?.runtime === 'desktop' ? window.oneShellDesktop : null;
}

export function isTauriDesktop(): boolean {
  return Boolean(tauriCore());
}

export function isDesktopRuntime(): boolean {
  return Boolean(tauriCore() || electronBridge() || window.__ONESHELL_RUNTIME__ === 'desktop' || new URLSearchParams(window.location.search).get('runtime') === 'desktop');
}

export async function getDesktopSettings(): Promise<DesktopSettings> {
  const electron = electronBridge();
  if (electron?.getSettings) return electron.getSettings();

  const core = tauriCore();
  if (core) return core.invoke<DesktopSettings>('desktop_get_settings');

  return {
    isDesktop: false,
    backgroundEnabled: false,
    autostartEnabled: false,
    autostartAvailable: false,
  };
}

export async function setDesktopBackgroundEnabled(enabled: boolean): Promise<DesktopSettings> {
  const electron = electronBridge();
  if (electron?.setBackgroundEnabled) return electron.setBackgroundEnabled(enabled);

  const core = tauriCore();
  if (!core) throw new Error('当前不是桌面端');
  return core.invoke<DesktopSettings>('desktop_set_background_enabled', { enabled });
}

export async function setDesktopAutostartEnabled(enabled: boolean): Promise<DesktopSettings> {
  const electron = electronBridge();
  if (electron?.setAutostartEnabled) return electron.setAutostartEnabled(enabled);

  const core = tauriCore();
  if (!core) throw new Error('当前不是桌面端');
  return core.invoke<DesktopSettings>('desktop_set_autostart_enabled', { enabled });
}
