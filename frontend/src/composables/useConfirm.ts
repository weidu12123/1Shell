import { ref } from 'vue';

interface ConfirmRequest {
  title: string;
  message: string;
  okText: string;
  okClass: string;
  resolve: (ok: boolean) => void;
}

export interface ConfirmOptions {
  title?: string;
  message: string;
  okText?: string;
  /** 自定义 ok 按钮 class（默认红色危险按钮） */
  okClass?: string;
}

const currentRequest = ref<ConfirmRequest | null>(null);

const DEFAULT_OK_CLASS = 'bg-red-500 hover:bg-red-600 text-white';

export function useConfirm() {
  function confirm(options: ConfirmOptions): Promise<boolean> {
    return new Promise((resolve) => {
      currentRequest.value = {
        title:   options.title   || '确认操作',
        message: options.message,
        okText:  options.okText  || '确认',
        okClass: options.okClass || DEFAULT_OK_CLASS,
        resolve,
      };
    });
  }
  return { confirm };
}

/** 由 ConfirmModal 组件读取，渲染当前 pending 请求。null 表示不显示 */
export function useConfirmState() {
  return currentRequest;
}

/** 由 ConfirmModal 组件调用，传 true/false 回 Promise */
export function resolveConfirm(ok: boolean): void {
  const req = currentRequest.value;
  if (!req) return;
  currentRequest.value = null;
  req.resolve(ok);
}
