/**
 * @File : web/src/main.tsx
 * @Time : 2026-10-05 09:20
 * @Author : Cetrp
 * @Description : 前端入口：挂载 React 应用，暴露调试句柄并兜底记录运行期异常。
 */

import { createRoot } from 'react-dom/client';

import { App } from './App';
import { use_store } from './core/store';
import './styles/app.css';

/** 运行期异常记录（供课堂现场与自动化验收定位问题）。 */
declare global {
  interface Window {
    SL_STORE?: typeof use_store;
    SL_ERRORS?: { message: string; source: string; at: string; stack?: string }[];
  }
}

/**
 * 记录运行期异常。
 *
 * @param {string} message 错误信息。
 * @param {string} source 来源。
 * @returns {void}
 */
function report_error(message: string, source: string, stack?: string): void {
  window.SL_ERRORS = window.SL_ERRORS || [];
  /* 同一错误只记录一次（渲染循环里的异常会每帧触发）。 */
  if (window.SL_ERRORS.some((item) => item.message === message)) {
    return;
  }
  if (window.SL_ERRORS.length >= 20) {
    return;
  }
  window.SL_ERRORS.push({
    message: message,
    source: source,
    at: new Date().toISOString(),
    stack: stack ? String(stack).split('\n').slice(0, 4).join(' | ') : undefined
  });
  document.title = 'ERR: ' + message;
  console.error('[simlab]', message, source);
}

window.addEventListener('error', (event) =>
  report_error(
    String(event.message || event),
    'window.error',
    event.error ? event.error.stack : undefined
  )
);
window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason as { message?: string } | undefined;
  report_error(String((reason && reason.message) || reason), 'unhandledrejection');
});

/* 暴露仓库句柄：便于浏览器控制台调试与自动化验收脚本读取状态。 */
window.SL_STORE = use_store;

/* 缩略图工具：便于在浏览器控制台与自动化验收中检查 3D 缩略图生成情况。 */
void import('./devices/thumbnailer').then((module) => {
  (window as unknown as { SL_THUMB?: unknown }).SL_THUMB = module;
});

const container = document.getElementById('root');
if (!container) {
  throw new Error('未找到 #root 容器');
}

createRoot(container).render(<App />);
