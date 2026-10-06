/**
 * @File : web/src/App.tsx
 * @Time : 2026-10-05 11:40
 * @Author : Cetrp
 * @Description : 应用外壳：三维场景挂载、面板布局、工具栏、设备标签与事件到场景的投影。
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import type { FormEvent, JSX } from 'react';

import { use_store } from './core/store';
import { EVENT_TYPE, DEVICE_STATE } from './core/constants';
import { SceneManager } from './scene/scene_manager';
import {
  CatalogPanel,
  DeviceListPanel,
  InspectorPanel,
  OpticalPanel,
  StatusBar,
  TopologyMiniMap,
  WirelessPanel
} from './ui/panels';
import { ConsoleDock } from './ui/console_dock';
import { AssemblyWorkbench } from './ui/AssemblyWorkbench';
import { ContextMenu } from './ui/ContextMenu';
import { LabelEditor } from './ui/LabelEditor';
import { CablePanel } from './ui/CablePanel';
import { RuntimeDeviceDialog } from './ui/RuntimeDeviceDialog';
import { ExperimentManagerDialog, VisualSettingsDialog } from './ui/PlatformDialogs';
import {
  bootstrap_csrf,
  fetch_current_user,
  login_user,
  logout_user,
  ServerApiError
} from './core/server_api';

import type { PortState } from './data/types';
import type { SceneSyncOptions } from './scene/scene_manager';
import type { ServerUser } from './core/server_api';

/** 设备标签数据。 */
interface DeviceLabel {
  device_id: string;
  name: string;
  x: number;
  y: number;
  state: string;
  wireless: boolean;
}

/** 规范化 noVNC 页面地址；预览和放大复用同一个持续会话。 */
function vnc_frame_url(url: string): string {
  if (!url) {
    return '';
  }
  const parsed = new URL(url, window.location.origin);
  return parsed.pathname + parsed.search + parsed.hash;
}

/** 服务器账户登录页。 */
function LoginScreen(props: {
  initial_error: string;
  on_authenticated: (user: ServerUser) => Promise<void>;
}): JSX.Element {
  const [username, set_username] = useState('');
  const [password, set_password] = useState('');
  const [busy, set_busy] = useState(false);
  const [error, set_error] = useState(props.initial_error);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    set_busy(true);
    set_error('');
    try {
      const user = await login_user(username.trim(), password);
      await props.on_authenticated(user);
    } catch (reason) {
      const code = reason instanceof ServerApiError ? reason.code : 'LOGIN_FAILED';
      const message = reason instanceof Error ? reason.message : '登录失败';
      set_error(`${code}：${message}。请核对账户密码和 Django 服务状态。`);
      set_busy(false);
    }
  };

  return (
    <main className="login-page">
      <div className="login-grid" />
      <section className="login-card">
        <div className="login-brand">SIMLAB</div>
        <h1>三维网络实验平台</h1>
        <p>登录后进入服务器实验库。每个实验按所有者、编辑者和查看者权限隔离。</p>
        <form onSubmit={(event) => void submit(event)}>
          <label>
            <span>用户名</span>
            <input
              value={username}
              autoComplete="username"
              autoFocus
              onChange={(event) => set_username(event.target.value)}
            />
          </label>
          <label>
            <span>密码</span>
            <input
              type="password"
              value={password}
              autoComplete="current-password"
              onChange={(event) => set_password(event.target.value)}
            />
          </label>
          {error && <div className="login-error">{error}</div>}
          <button type="submit" disabled={busy || !username.trim() || !password}>
            {busy ? '正在登录并载入实验…' : '登录'}
          </button>
        </form>
      </section>
    </main>
  );
}

/**
 * 应用根组件。
 *
 * @returns {JSX.Element} 组件。
 */
export function App(): JSX.Element {
  const container_ref = useRef<HTMLDivElement | null>(null);
  const scene_ref = useRef<SceneManager | null>(null);
  const [labels, set_labels] = useState<DeviceLabel[]>([]);
  const [ready, set_ready] = useState(false);
  const [session_user, set_session_user] = useState<ServerUser | null>(null);
  const [auth_checked, set_auth_checked] = useState(false);
  const [auth_error, set_auth_error] = useState('');
  const [console_collapsed, set_console_collapsed] = useState(false);
  const [left_collapsed, set_left_collapsed] = useState(false);
  const [right_collapsed, set_right_collapsed] = useState(false);
  const [right_tab, set_right_tab] = useState<'inspector' | 'wireless' | 'optical'>(() => {
    /* 支持 ?tab=wireless|optical 直接打开对应面板（演示与截图用）。 */
    const matched = /[?&]tab=([^&]+)/.exec(window.location.search);
    const tab = matched ? matched[1] : '';
    return tab === 'wireless' || tab === 'optical' ? tab : 'inspector';
  });

  const runtime = use_store((state) => state.runtime);
  const revision = use_store((state) => state.revision);
  const device_ids = use_store((state) => state.device_ids);
  const cables = use_store((state) => state.cables);
  const cable_waypoints = use_store((state) => state.cable_waypoints);
  const cable_labels = use_store((state) => state.cable_labels);
  const selected_device_id = use_store((state) => state.selected_device_id);
  const selected_port = use_store((state) => state.selected_port);
  const link_source = use_store((state) => state.link_source);
  const display_mode = use_store((state) => state.display_mode);
  const flow_enabled = use_store((state) => state.flow_enabled);
  const auto_rotate = use_store((state) => state.auto_rotate);
  const render_settings = use_store((state) => state.render_settings);
  const view = use_store((state) => state.view);
  const wireless = use_store((state) => state.wireless);
  const optical = use_store((state) => state.optical);
  const pending_cable_kind = use_store((state) => state.pending_cable_kind);
  const desktop_runtimes = use_store((state) => state.desktop_runtimes);
  const experiment_role = use_store((state) => state.current_experiment_role);
  const vnc_source_refs = useRef(new Map<string, HTMLIFrameElement>());
  const vnc_attached_device_ids = useRef(new Set<string>());
  const [vnc_expanded_device_id, set_vnc_expanded_device_id] = useState<string | null>(null);
  const expanded_binding = desktop_runtimes.find(
    (item) => item.bound_device_id === vnc_expanded_device_id
  );

  const initialize_authenticated = async (user: ServerUser): Promise<void> => {
    set_auth_error('');
    await use_store.getState().init();
    set_session_user(user);
    set_auth_checked(true);
  };

  /* 1. 恢复 Session 后初始化当前账户的服务器实验。 */
  useEffect(() => {
    let cancelled = false;
    void bootstrap_csrf()
      .then(fetch_current_user)
      .then(async (user) => {
        if (!cancelled) {
          await initialize_authenticated(user);
        }
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        if (error instanceof ServerApiError && error.code !== 'AUTH_REQUIRED') {
          set_auth_error(`${error.code}：${error.message}`);
        }
        set_auth_checked(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /* 页面关闭、刷新或离开实验时，使用 keepalive 请求关闭并解绑当前实验的桌面虚拟机。 */
  useEffect(() => {
    const release_runtime = (): void => {
      void use_store.getState().release_experiment_desktops(true);
    };
    window.addEventListener('pagehide', release_runtime);
    return () => window.removeEventListener('pagehide', release_runtime);
  }, [session_user]);

  /* 桌面虚拟机独立轮询，宿主开关机、资源新增或 VNC 端口变化会自动反映。 */
  useEffect(() => {
    if (!runtime) {
      return;
    }
    const handle = window.setInterval(() => {
      const state = use_store.getState();
      if (!state.desktop_runtime_busy) {
        void state.refresh_desktop_runtimes();
      }
    }, 5000);
    return () => window.clearInterval(handle);
  }, [runtime]);

  /* 2. 创建三维场景（仅一次）。 */
  useEffect(() => {
    if (!container_ref.current || scene_ref.current) {
      return;
    }
    const manager = new SceneManager({
      container: container_ref.current,
      callbacks: {
        on_port_click: (device_id: string, port: PortState) => {
          const state = use_store.getState();
          if (state.link_source) {
            if (
              state.link_source.device_id === device_id &&
              state.link_source.port === port.short_name
            ) {
              state.cancel_link();
              return;
            }
            void state.complete_link({ device_id: device_id, port: port.short_name });
            return;
          }
          if (port.plugged && port.cable) {
            /* 已接线端口：点击直接拔线（与原 HTML 实例的插拔手感一致）。 */
            void state.disconnect_port(device_id, port.short_name);
            state.select_port(device_id, port.short_name);
            return;
          }
          state.select_port(device_id, port.short_name);
          state.start_link({ device_id: device_id, port: port.short_name });
        },
        on_power_click: (device_id: string) => {
          void use_store.getState().toggle_power(device_id);
        },
        on_screen_click: (device_id: string) => {
          if (use_store.getState().current_experiment_role === 'VIEWER') return;
          const binding = use_store
            .getState()
            .desktop_runtimes.find((item) => item.bound_device_id === device_id);
          if (binding) {
            window.dispatchEvent(
              new CustomEvent('simlab:open-vnc', { detail: { device_id: device_id } })
            );
          }
        },
        on_device_select: (device_id: string) => {
          use_store.getState().select_device(device_id);
        },
        on_background_click: () => {
          use_store.getState().cancel_link();
          use_store.setState({ selected_device_id: null, selected_port: null });
        },
        on_device_move: (device_id: string, position: { x: number; y: number; z: number }) => {
          void use_store.getState().move_device(device_id, position);
        },
        on_label_click: (cable_id, side, current_text) => {
          use_store.getState().open_label_editor(cable_id, side, current_text, 0, 0);
        },
        on_cable_replug: (cable_id, side, device_id, port) => {
          void use_store.getState().reconnect_cable(cable_id, side, device_id, port);
        },
        on_hover: () => {
          /* 悬停提示由 CSS cursor 与标签覆盖层表达，这里无需额外状态。 */
        },
        on_context_menu: (target) => {
          use_store.getState().open_context_menu({
            kind: target.kind,
            device_id: target.device_id,
            port: target.port,
            cable_id: target.cable_id,
            x: target.client_x,
            y: target.client_y
          });
        },
        on_drop: (payload) => {
          /* 设备栏拖入 → 在该位置创建对应型号设备；线缆栏拖入 → 在最近端口开始连线。 */
          if (payload.type === 'device_template') {
            void use_store.getState().create_device_at(payload.value, payload.x, payload.z);
          }
          if (payload.type === 'cable_kind') {
            void use_store.getState().set_pending_cable_kind(payload.value);
            if (payload.hit_port) {
              /* 落点正好压在端口上：从该真实接口起线（半截线缆预览随之出现）。 */
              use_store
                .getState()
                .start_link({ device_id: payload.hit_port.device_id, port: payload.hit_port.port });
              return;
            }
            void use_store.getState().begin_cable_from_kind(payload.value, payload.x, payload.z);
          }
        }
      }
    });
    scene_ref.current = manager;
    /* 调试/自动化验收句柄。 */
    (window as unknown as { SL_SCENE_MANAGER?: SceneManager }).SL_SCENE_MANAGER = manager;
    manager.start((delta_seconds: number) => {
      use_store.getState().runtime?.tick(delta_seconds);
    });
    manager.set_view('iso');
    set_ready(true);

    const on_resize = (): void => manager.resize();
    window.addEventListener('resize', on_resize);
    return () => {
      window.removeEventListener('resize', on_resize);
      manager.dispose();
      scene_ref.current = null;
    };
  }, [session_user]);

  /* 3. 状态同步到三维场景。 */
  useEffect(() => {
    const manager = scene_ref.current;
    const state = use_store.getState();
    if (!manager || !state.runtime) {
      return;
    }
    const devices = state.device_ids
      .map((device_id) => state.runtime?.get_device(device_id) || null)
      .filter((device): device is NonNullable<typeof device> => Boolean(device));
    /* 已上电但未关联的无线客户端：场景里显示"搜索信号"脉冲。 */
    const associated = new Set(
      (state.wireless?.associations || []).map((item) => item.sta_device_id)
    );
    const waiting_sta = devices
      .filter((device) => {
        const wireless = device.manifest.wireless;
        return (
          wireless &&
          wireless.role === 'sta' &&
          device.power_state === DEVICE_STATE.RUNNING &&
          !associated.has(device.device_id)
        );
      })
      .map((device) => device.device_id);
    const options: SceneSyncOptions = {
      devices: devices as SceneSyncOptions['devices'],
      cables: state.cables,
      selected_device_id: state.selected_device_id,
      selected_port: state.selected_port,
      display_mode: state.display_mode,
      flow_enabled: state.flow_enabled,
      auto_rotate: state.auto_rotate,
      link_source: state.link_source,
      wireless: state.wireless,
      optical: state.optical,
      wireless_waiting_sta: waiting_sta,
      pending_cable_kind: state.pending_cable_kind,
      cable_waypoints: state.cable_waypoints,
      cable_labels: state.cable_labels
    };
    manager.sync(options);
  }, [
    revision,
    device_ids,
    cables,
    selected_device_id,
    selected_port,
    link_source,
    display_mode,
    flow_enabled,
    auto_rotate,
    wireless,
    optical,
    runtime,
    ready,
    cable_waypoints,
    cable_labels
  ]);

  /* 3.1 设备数量变化时自动取景（首次进入与新增设备）。 */
  const device_count = device_ids.length;
  useEffect(() => {
    if (device_count > 0) {
      window.setTimeout(() => scene_ref.current?.frame_all(), 260);
    }
  }, [device_count, ready]);

  /* 4. 视图预设。 */
  useEffect(() => {
    scene_ref.current?.set_view(view);
  }, [view, ready]);

  /* 4.1 画质、阴影与光照设置实时投影到 WebGL 渲染器。 */
  useEffect(() => {
    scene_ref.current?.set_render_settings(render_settings);
  }, [render_settings, ready]);

  /* 5. 事件 → 三维动画（转发路径与空中帧）。 */
  useEffect(() => {
    if (!runtime) {
      return;
    }
    return runtime.on_event((event) => {
      const manager = scene_ref.current;
      if (!manager) {
        return;
      }
      if (event.event_type === EVENT_TYPE.PACKET_FORWARDED) {
        const path = (event.data.path as string[]) || [];
        manager.play_forward(
          path,
          Number(event.data.hop_index || 0),
          (event.data.in_port as string) || null,
          (event.data.out_port as string) || null
        );
      }
      if (
        event.event_type === EVENT_TYPE.OPTICAL_METRICS_UPDATED ||
        event.event_type === EVENT_TYPE.OPTICAL_ALARM
      ) {
        /* 光链路事件到达时刷新快照，保证线缆着色与面板数值一致。 */
        void use_store.getState().refresh_optical();
      }
      if (event.event_type === EVENT_TYPE.WIRELESS_FRAME) {
        manager.play_wireless_frame(
          String(event.data.sta_id || ''),
          String(event.data.ap_id || ''),
          String(event.data.direction || 'uplink')
        );
      }
    });
  }, [runtime]);

  /* 6. 设备标签覆盖层（周期性投影到屏幕坐标）。 */
  useEffect(() => {
    let handle = 0;
    const update = (): void => {
      handle = window.setTimeout(update, 220);
      const manager = scene_ref.current;
      const state = use_store.getState();
      if (!manager || !state.runtime) {
        return;
      }
      const next: DeviceLabel[] = [];
      for (const device_id of state.device_ids) {
        const device = state.runtime.get_device(device_id);
        if (!device) {
          continue;
        }
        const point = manager.device_screen_position(device_id);
        if (!point.visible) {
          continue;
        }
        next.push({
          device_id: device_id,
          name: device.hostname,
          x: point.x,
          y: point.y,
          state: device.power_state === DEVICE_STATE.RUNNING ? '运行中' : '已关机',
          wireless: Boolean(device.manifest.wireless)
        });
      }
      set_labels(next);
    };
    update();
    return () => window.clearTimeout(handle);
  }, [ready]);

  /* 把每台已绑定计算设备的 noVNC Canvas 挂到各自 Three.js 屏幕。 */
  useEffect(() => {
    const manager = scene_ref.current;
    if (!manager) {
      return;
    }
    const active = desktop_runtimes.filter(
      (item) =>
        item.bound_device_id &&
        item.compatible_device_types.some((kind) => kind === 'pc' || kind === 'laptop') &&
        item.power_state === 'RUNNING' &&
        item.novnc_url &&
        item.bound_device_id !== vnc_expanded_device_id
    );
    const active_device_ids = new Set(
      active.flatMap((item) => (item.bound_device_id ? [item.bound_device_id] : []))
    );
    for (const device_id of vnc_attached_device_ids.current) {
      if (!active_device_ids.has(device_id)) {
        manager.clear_device_screen_canvas(device_id);
      }
    }
    vnc_attached_device_ids.current = active_device_ids;
    if (active.length === 0) {
      return;
    }
    let handle = 0;
    let cancelled = false;
    const attach_canvases = (): void => {
      if (cancelled) {
        return;
      }
      let waiting = false;
      for (const item of active) {
        const device_id = item.bound_device_id;
        if (!device_id) {
          continue;
        }
        const frame = vnc_source_refs.current.get(device_id);
        const canvas = frame?.contentDocument?.querySelector('canvas');
        if (!canvas || canvas.width <= 0 || canvas.height <= 0) {
          waiting = true;
          continue;
        }
        manager.set_device_screen_canvas(device_id, canvas);
      }
      if (waiting) {
        handle = window.setTimeout(attach_canvases, 120);
      }
    };
    attach_canvases();
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [ready, desktop_runtimes, vnc_expanded_device_id]);

  const link_hint = useMemo(() => {
    if (!link_source) {
      return null;
    }
    return '连线模式：点击目标设备的端口完成连接（Esc 取消）';
  }, [link_source]);

  /* 全览按钮事件。 */
  useEffect(() => {
    const handler = (): void => scene_ref.current?.frame_all();
    window.addEventListener('simlab:frame-all', handler);
    return () => window.removeEventListener('simlab:frame-all', handler);
  }, []);

  /* 检视面板和三维屏幕都通过同一事件打开交互式 VNC 大窗。 */
  useEffect(() => {
    const handler = (event: Event): void => {
      const device_id = (event as CustomEvent<{ device_id?: string }>).detail?.device_id;
      const state = use_store.getState();
      if (
        device_id &&
        state.desktop_runtimes.some((item) => item.bound_device_id === device_id)
      ) {
        state.select_device(device_id);
        set_vnc_expanded_device_id(device_id);
      }
    };
    window.addEventListener('simlab:open-vnc', handler);
    return () => window.removeEventListener('simlab:open-vnc', handler);
  }, []);

  useEffect(() => {
    if (
      vnc_expanded_device_id &&
      !desktop_runtimes.some((item) => item.bound_device_id === vnc_expanded_device_id)
    ) {
      set_vnc_expanded_device_id(null);
    }
  }, [desktop_runtimes, vnc_expanded_device_id]);

  /* 键盘快捷键。 */
  useEffect(() => {
    const on_key = (event: KeyboardEvent): void => {
      const state = use_store.getState();
      const target = event.target;
      if (target instanceof HTMLElement &&
          (target.closest('input, textarea, select, [contenteditable="true"], .xterm') ||
           target.isContentEditable)) {
        return;
      }
      if (event.key === 'Escape') {
        set_vnc_expanded_device_id(null);
        state.cancel_link();
      }
      const presets: Record<string, 'front' | 'iso' | 'top' | 'back' | 'close'> = {
        '1': 'front',
        '2': 'iso',
        '3': 'top',
        '4': 'back',
        '5': 'close'
      };
      if (presets[event.key]) {
        state.set_view(presets[event.key]);
      }
      if (event.key === ' ') {
        event.preventDefault();
        if (state.selected_device_id) {
          void state.toggle_power(state.selected_device_id);
        }
      }
      if (event.key === 'f' || event.key === 'F') {
        state.toggle_flow();
      }
    };
    window.addEventListener('keydown', on_key);
    return () => window.removeEventListener('keydown', on_key);
  }, []);

  if (!auth_checked) {
    return <div className="login-loading">正在连接服务器并读取账户实验…</div>;
  }
  if (!session_user) {
    return (
      <LoginScreen
        initial_error={auth_error}
        on_authenticated={initialize_authenticated}
      />
    );
  }

  return (
    <div className={[
      'app',
      experiment_role === 'VIEWER' ? 'viewer-mode' : '',
      left_collapsed ? 'sidebar-left-collapsed' : '',
      right_collapsed ? 'sidebar-right-collapsed' : ''
    ].filter(Boolean).join(' ')}>
      <div className="scene-host" ref={container_ref} />
      <div className="account-controls">
        <span>{session_user.username}</span>
        {experiment_role === 'VIEWER' && <span title="请联系实验所有者授予编辑权限">只读实验</span>}
        <button
          type="button"
          onClick={() => {
            void use_store.getState().release_experiment_desktops().finally(() => {
              void logout_user().finally(() => window.location.reload());
            });
          }}
        >
          退出
        </button>
      </div>

      {experiment_role !== 'VIEWER' && desktop_runtimes
        .filter(
          (item) =>
            item.bound_device_id &&
            item.power_state === 'RUNNING' &&
            item.novnc_url
        )
        .map((item) => {
          const expanded = item.bound_device_id === vnc_expanded_device_id;
          return (
            <div
              key={`${item.id}-${item.bound_device_id}`}
              className={`vnc-session${expanded ? ' vnc-modal is-expanded' : ''}`}
              role={expanded ? 'dialog' : undefined}
              aria-modal={expanded ? true : undefined}
              aria-label={expanded ? 'VNC 远程桌面' : undefined}
              aria-hidden={expanded ? undefined : true}
            >
              <div className="vnc-modal-window">
                <div className="vnc-modal-head">
                  <div>
                    <i className="online" />
                    <b>{item.display_name || item.domain_name}</b>
                    <span>{item.domain_name} · {item.power_state}</span>
                  </div>
                  <button type="button" onClick={() => set_vnc_expanded_device_id(null)}>
                    {item.compatible_device_types.some(
                      (kind) => kind === 'pc' || kind === 'laptop'
                    ) ? '缩小回设备屏幕 ×' : '关闭控制台 ×'}
                  </button>
                </div>
                <div className="vnc-modal-body">
                  <iframe
                    ref={(node) => {
                      if (!item.bound_device_id) {
                        return;
                      }
                      if (node) {
                        vnc_source_refs.current.set(item.bound_device_id, node);
                      } else {
                        vnc_source_refs.current.delete(item.bound_device_id);
                      }
                    }}
                    src={vnc_frame_url(item.novnc_url)}
                    title={`${item.domain_name || item.id} 交互式远程桌面`}
                    allow="clipboard-read; clipboard-write"
                    tabIndex={expanded ? 0 : -1}
                  />
                </div>
              </div>
            </div>
          );
        })}

      {experiment_role !== 'VIEWER' && vnc_expanded_device_id &&
        expanded_binding &&
        (expanded_binding.power_state !== 'RUNNING' || !expanded_binding.novnc_url) && (
        <div className="vnc-modal" role="dialog" aria-modal="true" aria-label="VNC 远程桌面">
          <div className="vnc-modal-window">
            <div className="vnc-modal-head">
              <div>
                <i className={expanded_binding.power_state === 'RUNNING' ? 'online' : ''} />
                <b>{expanded_binding.display_name || expanded_binding.domain_name}</b>
                <span>
                  {expanded_binding.domain_name} · {expanded_binding.power_state}
                </span>
              </div>
              <button type="button" onClick={() => set_vnc_expanded_device_id(null)}>
                缩小回设备屏幕 ×
              </button>
            </div>
            <div className="vnc-modal-body">
              <div className="vnc-modal-off">虚拟机已关机，请返回设备检视后开机。</div>
            </div>
          </div>
        </div>
        )}

      <RuntimeDeviceDialog can_upload_images={session_user.is_staff} />

      <StatusBar />

      <div className={left_collapsed ? 'panel-column left collapsed' : 'panel-column left'}>
        <div className="sidebar-controls">
          <button type="button" className="sidebar-toggle"
            aria-label={left_collapsed ? '展开左侧菜单' : '收起左侧菜单'}
            aria-expanded={!left_collapsed}
            title={left_collapsed ? '展开左侧菜单' : '收起左侧菜单'}
            onClick={() => set_left_collapsed((value) => !value)}>
            <span aria-hidden="true">{left_collapsed ? '›' : '‹'}</span>
            <span className="sidebar-toggle-label">{left_collapsed ? '' : '收起设备栏'}</span>
          </button>
        </div>
        {experiment_role !== 'VIEWER' && <CatalogPanel />}
        <DeviceListPanel />
        {experiment_role !== 'VIEWER' && <CablePanel />}
      </div>

      <div className={right_collapsed ? 'panel-column right collapsed' : 'panel-column right'}>
        <div className="sidebar-controls">
          <button type="button" className="sidebar-toggle"
            aria-label={right_collapsed ? '展开右侧菜单' : '收起右侧菜单'}
            aria-expanded={!right_collapsed}
            title={right_collapsed ? '展开右侧菜单' : '收起右侧菜单'}
            onClick={() => set_right_collapsed((value) => !value)}>
            <span className="sidebar-toggle-label">{right_collapsed ? '' : '收起检视栏'}</span>
            <span aria-hidden="true">{right_collapsed ? '‹' : '›'}</span>
          </button>
        </div>
        <div className="tabs right-tabs">
          <button
            type="button"
            className={right_tab === 'inspector' ? 'on' : ''}
            onClick={() => set_right_tab('inspector')}
          >
            设备检视
          </button>
          <button
            type="button"
            className={right_tab === 'wireless' ? 'on' : ''}
            onClick={() => set_right_tab('wireless')}
          >
            无线仿真
          </button>
          <button
            type="button"
            className={right_tab === 'optical' ? 'on' : ''}
            onClick={() => set_right_tab('optical')}
          >
            光链路
          </button>
        </div>
        {right_tab === 'inspector' && <InspectorPanel />}
        {right_tab === 'wireless' && <WirelessPanel />}
        {right_tab === 'optical' && <OpticalPanel />}
        <div className="panel mini-panel">
          <div className="panel-head">
            <h2>拓扑速览</h2>
          </div>
          <TopologyMiniMap />
        </div>
      </div>

      <ConsoleDock collapsed={console_collapsed} on_collapsed_change={set_console_collapsed} />

      <div className="labels">
        {labels.map((label) => (
          <div
            key={label.device_id}
            className={
              'device-label' +
              (label.device_id === selected_device_id ? ' selected' : '') +
              (label.wireless ? ' wireless' : '')
            }
            style={{ left: label.x, top: label.y }}
          >
            <b>{label.name}</b>
            <span>{label.state}</span>
          </div>
        ))}
      </div>

      <Toolbar console_collapsed={console_collapsed} />
      {link_hint && <div className="link-hint">{link_hint}</div>}
      {experiment_role !== 'VIEWER' && <AssemblyWorkbench />}
      {experiment_role !== 'VIEWER' && <LabelEditor />}
      {experiment_role !== 'VIEWER' && <ContextMenu />}
      <ExperimentManagerDialog />
      <VisualSettingsDialog />
    </div>
  );
}

/**
 * 底部工具栏。
 *
 * @returns {JSX.Element} 组件。
 */
function Toolbar({ console_collapsed }: { console_collapsed: boolean }): JSX.Element {
  const view = use_store((state) => state.view);
  const display_mode = use_store((state) => state.display_mode);
  const flow_enabled = use_store((state) => state.flow_enabled);
  const auto_rotate = use_store((state) => state.auto_rotate);
  const selected_device_id = use_store((state) => state.selected_device_id);
  const set_view = use_store((state) => state.set_view);
  const set_display_mode = use_store((state) => state.set_display_mode);
  const toggle_flow = use_store((state) => state.toggle_flow);
  const toggle_auto_rotate = use_store((state) => state.toggle_auto_rotate);
  const toggle_power = use_store((state) => state.toggle_power);
  const save_config = use_store((state) => state.save_config);
  const delete_device = use_store((state) => state.delete_device);
  const save_experiment = use_store((state) => state.save_experiment);
  const set_experiment_manager_open = use_store((state) => state.set_experiment_manager_open);
  const set_visual_settings_open = use_store((state) => state.set_visual_settings_open);
  const experiment_busy = use_store((state) => state.experiment_busy);
  const experiment_role = use_store((state) => state.current_experiment_role);

  const views: { key: 'front' | 'iso' | 'top' | 'back' | 'close'; label: string }[] = [
    { key: 'front', label: '正面' },
    { key: 'iso', label: '45°' },
    { key: 'top', label: '俯视' },
    { key: 'back', label: '背面' },
    { key: 'close', label: '近景' }
  ];
  const modes: { key: 'shell' | 'xray' | 'explode'; label: string }[] = [
    { key: 'shell', label: '外观' },
    { key: 'xray', label: '透视' },
    { key: 'explode', label: '爆炸图' }
  ];

  return (
    <div className={console_collapsed ? 'toolbar console-collapsed' : 'toolbar'}>
      <button type="button" onClick={() => set_experiment_manager_open(true)}>
        实验库
      </button>
      <button
        type="button"
        disabled={experiment_busy || experiment_role === 'VIEWER'}
        title={experiment_role === 'VIEWER' ? '当前账户只有查看权限' : undefined}
        onClick={() => void save_experiment()}
      >
        {experiment_busy ? '保存中…' : '保存实验'}
      </button>
      <button type="button" onClick={() => set_visual_settings_open(true)}>
        画质/光照
      </button>
      <span className="sep" />
      {views.map((item) => (
        <button
          key={item.key}
          type="button"
          className={view === item.key ? 'on' : ''}
          onClick={() => set_view(item.key)}
        >
          {item.label}
        </button>
      ))}
      <span className="sep" />
      {modes.map((item) => (
        <button
          key={item.key}
          type="button"
          className={display_mode === item.key ? 'on' : ''}
          onClick={() => set_display_mode(item.key)}
        >
          {item.label}
        </button>
      ))}
      <button type="button" className={flow_enabled ? 'on' : ''} onClick={toggle_flow}>
        转发路径
      </button>
      <span className="sep" />
      <button
        type="button"
        disabled={!selected_device_id || experiment_role === 'VIEWER'}
        onClick={() => selected_device_id && void toggle_power(selected_device_id)}
      >
        开关机
      </button>
      <button
        type="button"
        disabled={!selected_device_id || experiment_role === 'VIEWER'}
        onClick={() => selected_device_id && void save_config(selected_device_id)}
      >
        保存配置
      </button>
      <button
        type="button"
        className="warn"
        disabled={!selected_device_id || experiment_role === 'VIEWER'}
        onClick={() => selected_device_id && void delete_device(selected_device_id)}
      >
        删除设备
      </button>
      <button
        type="button"
        onClick={() => {
          /* 全览：把全部设备纳入视野。 */
          window.dispatchEvent(new CustomEvent('simlab:frame-all'));
        }}
      >
        全览
      </button>
      <button type="button" className={auto_rotate ? 'on' : ''} onClick={toggle_auto_rotate}>
        自动旋转
      </button>
    </div>
  );
}
