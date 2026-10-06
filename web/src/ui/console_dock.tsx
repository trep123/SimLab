/** 多设备 CLI 标签：每个标签独立维护终端、命令历史与串口连接。 */
import { useEffect, useRef, useState } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';

import type { JSX } from 'react';
import type { RuntimeClient } from '../core/runtime_types';
import type { DesktopRuntimeInstance } from '../core/desktop_runtime_bridge';
import type { SimlabEvent } from '../data/types';
import { EVENT_TYPE } from '../core/constants';
import { request_runtime_console } from '../core/desktop_runtime_bridge';
import { ServerApiError } from '../core/server_api';
import { use_store } from '../core/store';
import { EventPanel } from './panels';

interface DeviceTerminalProps {
  device_id: string;
  runtime: RuntimeClient;
  bound_runtime?: DesktopRuntimeInstance;
  visible: boolean;
  clear_seq: number;
}

function DeviceTerminal({ device_id, runtime, bound_runtime, visible, clear_seq }: DeviceTerminalProps): JSX.Element {
  const box_ref = useRef<HTMLDivElement | null>(null);
  const terminal_ref = useRef<Terminal | null>(null);
  const fit_ref = useRef<FitAddon | null>(null);
  const socket_ref = useRef<WebSocket | null>(null);
  const session_ref = useRef<string | null>(null);
  const buffer_ref = useRef('');
  const history_ref = useRef<string[]>([]);
  const history_index_ref = useRef(0);
  const busy_ref = useRef(false);
  const pending_ref = useRef<Array<string | Uint8Array>>([]);
  const pending_bytes_ref = useRef(0);
  const visible_ref = useRef(visible);
  const real_ref = useRef(!!bound_runtime);
  const [reconnect_seq, reconnect] = useState(0);
  const [closed, set_closed] = useState(false);
  visible_ref.current = visible;
  real_ref.current = !!bound_runtime;

  const write = (data: string | Uint8Array): void => {
    if (visible_ref.current && terminal_ref.current) {
      terminal_ref.current.write(data);
    } else {
      // 隐藏标签避免驱动零尺寸 xterm 视口，并限制后台输出内存。
      pending_bytes_ref.current += data.length;
      pending_ref.current.push(data);
      while (pending_bytes_ref.current > 524288 && pending_ref.current.length > 1) {
        pending_bytes_ref.current -= pending_ref.current.shift()!.length;
      }
    }
  };
  const line = (message: string): void => write(message.replace(/\r?\n/g, '\r\n') + '\r\n');
  const fit_and_flush = (): void => {
    if (!visible_ref.current || !box_ref.current?.clientWidth || !terminal_ref.current) return;
    try { fit_ref.current?.fit(); } catch (error) { console.warn('终端自适应失败', error); }
    for (const data of pending_ref.current) terminal_ref.current.write(data);
    pending_ref.current = [];
    pending_bytes_ref.current = 0;
  };

  useEffect(() => {
    if (!box_ref.current) return;
    const terminal = new Terminal({
      fontFamily: "'JetBrains Mono', Consolas, 'Courier New', monospace",
      fontSize: 12.5, lineHeight: 1.35, convertEol: true, cursorBlink: true, scrollback: 2000,
      theme: { background: 'rgba(8, 12, 18, 0)', foreground: '#cfe3f5',
        cursor: '#37e0c9', selectionBackground: 'rgba(55, 224, 201, 0.25)' }
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(box_ref.current);
    terminal_ref.current = terminal;
    fit_ref.current = fit;

    const on_data = async (data: string): Promise<void> => {
      if (real_ref.current) {
        if (socket_ref.current?.readyState === WebSocket.OPEN) socket_ref.current.send(data);
        return;
      }
      const session = session_ref.current;
      if (!session || busy_ref.current) return;
      if (data === '\r') {
        const command = buffer_ref.current;
        buffer_ref.current = '';
        write('\r\n');
        if (command.trim()) {
          history_ref.current.push(command);
          history_index_ref.current = history_ref.current.length;
        }
        busy_ref.current = true;
        try {
          const result = await runtime.console_write(session, command);
          if (session_ref.current !== session) return;
          if (result.success !== false) {
            for (const output of result.lines || []) line(output);
            write('\r\n' + (result.prompt || '>') + ' ');
          } else {
            line('% ' + (result.message || '执行失败'));
            write('\r\n> ');
          }
        } catch { line('CONSOLE_WRITE_FAILED：模拟命令失败；请重试。'); }
        finally { busy_ref.current = false; }
        return;
      }
      if (data === '\u007f') {
        if (buffer_ref.current) {
          buffer_ref.current = buffer_ref.current.slice(0, -1);
          write('\b \b');
        }
        return;
      }
      if (data === '\t') {
        try {
          const candidates = await runtime.console_complete(session, buffer_ref.current);
          if (session_ref.current !== session) return;
          if (candidates.length === 1) {
            const extra = candidates[0].slice(buffer_ref.current.length);
            buffer_ref.current = candidates[0];
            write(extra);
          } else if (candidates.length > 1) {
            write('\r\n');
            for (const candidate of candidates.slice(0, 12)) line('  ' + candidate);
            write('> ' + buffer_ref.current);
          }
        } catch { line('CONSOLE_COMPLETE_FAILED：补全失败；请重试。'); }
        return;
      }
      if (data === '\u001b[A' || data === '\u001b[B') {
        if (history_ref.current.length) {
          history_index_ref.current = Math.max(0, Math.min(history_ref.current.length,
            history_index_ref.current + (data === '\u001b[A' ? -1 : 1)));
          const value = history_ref.current[history_index_ref.current] || '';
          write('\r' + ' '.repeat(buffer_ref.current.length + 2) + '\r' + value);
          buffer_ref.current = value;
        }
        return;
      }
      if (data === '\u0003') { write('^C\r\n> '); buffer_ref.current = ''; return; }
      if (data >= ' ') { buffer_ref.current += data; write(data); }
    };
    const input = terminal.onData((data) => void on_data(data));
    const observer = new ResizeObserver(fit_and_flush);
    observer.observe(box_ref.current);
    requestAnimationFrame(fit_and_flush);
    return () => {
      observer.disconnect(); input.dispose(); terminal.dispose();
      terminal_ref.current = null; fit_ref.current = null;
    };
  }, [runtime]);

  useEffect(() => {
    if (visible) requestAnimationFrame(() => {
      fit_and_flush();
      terminal_ref.current?.focus();
    });
  }, [visible]);
  useEffect(() => { if (clear_seq) terminal_ref.current?.clear(); }, [clear_seq]);

  useEffect(() => {
    let cancelled = false;
    socket_ref.current?.close(); socket_ref.current = null;
    const previous = session_ref.current;
    session_ref.current = null;
    if (previous) void runtime.console_close(previous).catch(() => undefined);
    buffer_ref.current = '';
    busy_ref.current = false;
    set_closed(false);

    if (bound_runtime) {
      if (bound_runtime.power_state !== 'RUNNING') {
        line('CONSOLE_POWER_OFF：设备未开机；请先在实验中开机。');
        set_closed(true);
      } else {
        line(`=== ${runtime.get_device(device_id)?.hostname || device_id} · 真实客体串口 ===`);
        void (async () => {
          try {
            const ticket = await request_runtime_console(bound_runtime.id, device_id);
            if (cancelled) return;
            const url = new URL(ticket.console_url, window.location.href);
            url.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            const socket = new WebSocket(url);
            socket.binaryType = 'arraybuffer';
            socket_ref.current = socket;
            socket.onopen = () => { if (!cancelled) line('已连接真实串口；输入直接发送给客体系统。'); };
            socket.onmessage = (event: MessageEvent<string | ArrayBuffer>) => {
              if (!cancelled) write(typeof event.data === 'string'
                ? event.data : new Uint8Array(event.data));
            };
            socket.onerror = () => {
              if (!cancelled) line('CONSOLE_CONNECTION_FAILED：串口连接异常；请检查设备与 Host Agent。');
            };
            socket.onclose = () => {
              if (!cancelled) { set_closed(true); line('CONSOLE_CLOSED：串口已断开；点击“重连”重新连接。'); }
              if (socket_ref.current === socket) socket_ref.current = null;
            };
          } catch (error) {
            if (!cancelled) {
              set_closed(true);
              line(error instanceof ServerApiError ? `${error.code}：${error.message}`
                : 'CONSOLE_UNAVAILABLE：无法打开真实串口；请刷新设备状态后重试。');
            }
          }
        })();
      }
    } else {
      void (async () => {
        try {
          const info = await runtime.console_open(device_id);
          if (cancelled || !info.success || !info.session_id) {
            if (info.session_id) void runtime.console_close(info.session_id).catch(() => undefined);
            if (!cancelled) { set_closed(true); line(`CONSOLE_OPEN_FAILED：${info.message || '模拟 CLI 不可用；请重试。'}`); }
            return;
          }
          session_ref.current = info.session_id;
          line(`=== development_mock · 模拟 CLI：${runtime.get_device(device_id)?.hostname || device_id} ===`);
          write('> ' + (info.prompt || '<Device>') + ' ');
        } catch {
          if (!cancelled) { set_closed(true); line('CONSOLE_OPEN_FAILED：模拟 CLI 不可用；请重试。'); }
        }
      })();
    }
    return () => {
      cancelled = true;
      socket_ref.current?.close(); socket_ref.current = null;
      const session = session_ref.current;
      session_ref.current = null;
      if (session) void runtime.console_close(session).catch(() => undefined);
    };
  }, [runtime, device_id, bound_runtime?.id, bound_runtime?.power_state, reconnect_seq]);

  useEffect(() => runtime.on_event((event: SimlabEvent) => {
    if (real_ref.current || event.device_id !== device_id || !session_ref.current) return;
    if (event.event_type === EVENT_TYPE.DEVICE_BOOT_PROGRESS && event.data.line) line(String(event.data.line));
    if (event.event_type === EVENT_TYPE.DEVICE_STATE_CHANGED && event.data.to === 'RUNNING') {
      line('\x1b[32m% 设备已进入运行状态，可以开始调试。\x1b[0m');
    }
    if (event.event_type === EVENT_TYPE.DEVICE_STATE_CHANGED && event.data.to === 'OFF') {
      line('\x1b[31m% 设备已断电，控制台无响应。\x1b[0m');
    }
  }), [runtime, device_id]);

  return (
    <div className={visible ? 'terminal-host' : 'terminal-host hidden'}>
      <div ref={box_ref} className="terminal-box" />
      <div className="terminal-hint">
        {bound_runtime ? '真实串口输入直达客体；命令与登录凭据由客体镜像决定。'
          : 'development_mock · 模拟 CLI：Tab 补全 · ↑↓ 历史 · 输入 ? 查看帮助'}
        {closed && bound_runtime?.power_state === 'RUNNING' && (
          <button type="button" className="console-reconnect" onClick={() => reconnect((value) => value + 1)}>重连</button>
        )}
      </div>
    </div>
  );
}

/** 选中设备及右键“打开 CLI”都会打开可切换的设备标签。 */
export function ConsoleDock({
  collapsed,
  on_collapsed_change
}: {
  collapsed: boolean;
  on_collapsed_change: (collapsed: boolean) => void;
}): JSX.Element {
  const runtime = use_store((state) => state.runtime);
  const selected_device_id = use_store((state) => state.selected_device_id);
  const console_device_id = use_store((state) => state.console_device_id);
  const console_request_seq = use_store((state) => state.console_request_seq);
  const desktop_runtimes = use_store((state) => state.desktop_runtimes);
  const revision = use_store((state) => state.revision);
  const [page, set_page] = useState<'terminal' | 'events'>('terminal');
  const [device_ids, set_device_ids] = useState<string[]>([]);
  const [active_id, set_active_id] = useState<string | null>(null);
  const [clear_target, set_clear_target] = useState<{ id: string; seq: number }>({ id: '', seq: 0 });

  const open_device = (id: string): void => {
    if (!runtime?.get_device(id)) return;
    set_device_ids((current) => current.includes(id) ? current : [...current, id]);
    set_active_id(id);
    set_page('terminal');
    on_collapsed_change(false);
  };

  useEffect(() => { set_device_ids([]); set_active_id(null); }, [runtime]);
  useEffect(() => { if (selected_device_id) open_device(selected_device_id); }, [runtime, selected_device_id]);
  useEffect(() => { if (console_device_id) open_device(console_device_id); }, [runtime, console_request_seq]);
  useEffect(() => {
    if (!runtime) return;
    const existing = device_ids.filter((id) => runtime.get_device(id));
    if (existing.length !== device_ids.length) {
      set_device_ids(existing);
      if (active_id && !existing.includes(active_id)) set_active_id(existing.at(-1) || null);
    }
  }, [runtime, revision, device_ids, active_id]);

  const close_device = (id: string): void => {
    const next = device_ids.filter((device_id) => device_id !== id);
    set_device_ids(next);
    if (active_id === id) set_active_id(next.at(-1) || null);
  };

  return (
    <div className={collapsed ? 'console-dock collapsed' : 'console-dock'}>
      <div className="console-head">
        <div className="tabs">
          <button type="button" className={page === 'terminal' ? 'on' : ''}
            onClick={() => set_page('terminal')}>设备调试终端</button>
          <button type="button" className={page === 'events' ? 'on' : ''}
            onClick={() => set_page('events')}>事件流</button>
        </div>
        <div className="console-status">
          <button type="button" className="mini" disabled={!active_id || page !== 'terminal'}
            onClick={() => active_id && set_clear_target((value) => ({ id: active_id, seq: value.seq + 1 }))}>清空</button>
          <button type="button" className="mini" onClick={() => on_collapsed_change(!collapsed)}>
            {collapsed ? '展开' : '收起'}
          </button>
        </div>
      </div>
      {page === 'terminal' && device_ids.length > 0 && (
        <div className="console-device-tabs" role="tablist" aria-label="设备 CLI">
          {device_ids.map((id) => {
            const name = runtime?.get_device(id)?.hostname || id;
            const real = desktop_runtimes.some((item) => item.bound_device_id === id);
            return (
              <div key={id} className={id === active_id ? 'console-device-tab active' : 'console-device-tab'}>
                <button type="button" role="tab" aria-selected={id === active_id}
                  title={`${name} · ${real ? '真实串口' : 'development_mock · 模拟 CLI'}`}
                  onClick={() => set_active_id(id)}>
                  <span className={real ? 'console-tab-dot real' : 'console-tab-dot'} />
                  <span className="console-tab-label">{name}</span>
                </button>
                <button type="button" className="console-tab-close" aria-label={`关闭 ${name} CLI`}
                  title="关闭标签" onClick={() => close_device(id)}>×</button>
              </div>
            );
          })}
        </div>
      )}
      {device_ids.map((id) => runtime && (
        <DeviceTerminal key={id} device_id={id} runtime={runtime}
          bound_runtime={desktop_runtimes.find((item) => item.bound_device_id === id)}
          visible={page === 'terminal' && !collapsed && active_id === id}
          clear_seq={clear_target.id === id ? clear_target.seq : 0} />
      ))}
      {page === 'terminal' && device_ids.length === 0 && (
        <div className="console-empty">选择设备或右键点击设备打开 CLI 调试。</div>
      )}
      {page === 'events' && <EventPanel />}
    </div>
  );
}
