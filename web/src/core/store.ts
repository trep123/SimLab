/**
 * @File : web/src/core/store.ts
 * @Time : 2026-10-05 06:45
 * @Author : Cetrp
 * @Description : 应用状态仓库（zustand）：运行时选择、设备与线缆镜像、选中态、视图模式、
 *               事件流、无线状态与 ping 结果，供 React 界面与三维场景共同消费。
 */

import { create } from 'zustand';

import { bus } from './bus';
import { CABLE_TYPE, DEVICE_STATE, EVENT_TYPE, utils } from './constants';
import { LocalRuntime } from './local_runtime';
import type { ApRadioSettings } from './radio_model';
import { plan_runtime_node_names } from './runtime_node_names';
import { RemoteRuntime } from './remote_runtime';
import {
  bind_desktop_runtime,
  delete_desktop_runtime,
  destroy_bound_desktop_runtime,
  fetch_desktop_runtimes,
  power_desktop_runtime,
  provision_desktop_runtime,
  release_desktop_runtimes,
  unbind_desktop_runtime
} from './desktop_runtime_bridge';
import {
  bind_g0_pc as request_g0_pc_binding,
  fetch_g0_pc_binding,
  power_g0_pc as request_g0_pc_power,
  unbind_g0_pc as request_g0_pc_unbind
} from './g0_pc_bridge';

import type { PortRef, RuntimeClient } from './runtime_types';
import type { G0PcBinding } from './g0_pc_bridge';
import type {
  DesktopRuntimeInstance,
  DesktopRuntimeProfile,
  DesktopRuntimeSpec,
  VendorImageCandidate
} from './desktop_runtime_bridge';
import type { CableRecord, PingResult, SimlabEvent, WirelessSnapshot } from '../data/types';
import type { OpticalSnapshot } from './optical_model';
import type { DeviceTemplate, PartParams, PartSpec } from '../devices/template_types';
import { get_registry } from '../data/assets';
import { clear_thumbnail_cache } from '../devices/thumbnailer';
import {
  clone_template,
  delete_user_template,
  ensure_templates_loaded,
  get_template,
  list_templates,
  save_user_template
} from '../devices/registry';
import {
  create_experiment_id,
  delete_saved_experiment as delete_legacy_experiment,
  list_saved_experiments as list_legacy_experiments,
  load_saved_experiment as load_legacy_experiment
} from './experiment_storage';
import {
  create_server_experiment,
  delete_server_experiment,
  list_server_experiments,
  load_server_experiment,
  save_server_experiment
} from './server_api';
import { DEFAULT_RENDER_SETTINGS, normalize_render_settings } from './render_settings';
import {
  desktop_port_aliases, desktop_port_keys, desktop_runtime_port_keys
} from './desktop_ports';
import { get_part_definition } from '../devices/parts';
import { is_ethernet_port_module } from '../devices/port_module_expansion';

function next_ethernet_module_name(parts: PartSpec[]): string {
  const used = new Set(
    parts
      .filter(is_ethernet_port_module)
      .map((part) => String(part.params.short_name || '').trim())
      .filter(Boolean)
  );
  let index = 0;
  while (used.has(`eth${index}`)) index += 1;
  return `eth${index}`;
}
import type { SavedExperiment } from './experiment_storage';
import type { ExperimentRole, ServerExperimentSummary } from './server_api';
import type { RenderSettings } from './render_settings';

/** 工坊撤销/重做栈上限。 */
const HISTORY_LIMIT = 60;

/**
 * 撤销/重做后决定仍选中的部件：原部件仍在则保留，否则回退到首个部件。
 *
 * @param {DeviceTemplate} template 目标模板。
 * @param {string | null} current 当前选中部件 ID。
 * @returns {string | null} 新的选中部件 ID。
 */
function resolve_part_id(template: DeviceTemplate, current: string | null): string | null {
  if (current && template.parts.some((part) => part.part_id === current)) {
    return current;
  }

  return template.parts.length > 0 ? template.parts[0].part_id : null;
}

/** 事件流保留条数。 */
const MAX_EVENTS = 200;

/** 视图预设。 */
export type ViewPreset = 'front' | 'iso' | 'top' | 'back' | 'close';

/** 显示模式。 */
export type DisplayMode = 'shell' | 'xray' | 'explode';

/** 等待用户选择后端虚拟机或填写新建参数的前端设备。 */
export interface PendingRuntimeDevice {
  model_id: string;
  hostname?: string;
  position?: { x: number; y: number; z: number };
}

/** 可绑定真实 QEMU 实例的前端设备类型。 */
export function is_runtime_model(model_id: string): boolean {
  const manifest = get_registry().manifest(model_id);
  return ['pc', 'laptop', 'switch', 'l3switch', 'router', 'firewall'].includes(
    manifest?.device_type || ''
  );
}

/** 将后端错误转换成包含稳定错误码与处理建议的用户提示。 */
function runtime_action_error(
  error: unknown,
  fallback_code: string,
  fallback_message: string
): string {
  const explicit_code =
    error && typeof error === 'object' && 'code' in error
      ? String((error as { code: unknown }).code)
      : '';
  const code = explicit_code ||
    (error instanceof Error && error.name && error.name !== 'Error'
      ? error.name
      : fallback_code);
  const message = error instanceof Error && error.message ? error.message : fallback_message;
  return `${code}：${message}。请检查 Host Agent 与 Django 服务状态后重试。`;
}

/** 应用状态。 */
export interface AppState {
  /** 运行时适配器。 */
  runtime: RuntimeClient | null;

  /** 运行时类型。 */
  runtime_mode: 'local' | 'remote';

  /** 后端地址（远端模式）。 */
  api_base: string | null;

  /** 是否已连接后端。 */
  connected: boolean;

  /** 设备 ID 列表（镜像变更计数以便 React 刷新）。 */
  device_ids: string[];

  /** 线缆列表。 */
  cables: CableRecord[];

  cloud_uplinks: Record<string, string>;
  set_cloud_uplink: (device_id: string, bridge: string) => Promise<void>;

  /** 当前选中的设备。 */
  selected_device_id: string | null;

  /** 当前选中的端口。 */
  selected_port: string | null;

  /** 固定真实虚拟机 simlab-g0-pc1 的前端绑定与观测状态。 */
  g0_binding: G0PcBinding | null;

  /** G0 绑定或电源操作正在执行。 */
  g0_busy: boolean;

  /** 最近一次 G0 操作错误。 */
  g0_error: string | null;

  /** 可供 PC/笔记本绑定的后端虚拟机资源池。 */
  desktop_runtimes: DesktopRuntimeInstance[];

  /** 后端批准的镜像与资源参数范围。 */
  desktop_profiles: DesktopRuntimeProfile[];
  vendor_image_candidates: VendorImageCandidate[];
  vendor_image_scan_error: { code: string; message: string } | null;

  /** 通用虚拟机资源池操作正在执行。 */
  desktop_runtime_busy: boolean;

  /** 最近一次通用虚拟机资源池错误。 */
  desktop_runtime_error: string | null;

  /** 新增 PC/笔记本时等待完成的 Runtime 配置。 */
  pending_runtime_device: PendingRuntimeDevice | null;

  /** 连线模式起点。 */
  link_source: PortRef | null;

  /** 视图预设。 */
  view: ViewPreset;

  /** 显示模式。 */
  display_mode: DisplayMode;

  /** 是否显示转发路径。 */
  flow_enabled: boolean;

  /** 是否自动旋转。 */
  auto_rotate: boolean;

  /** 当前本地实验 ID 与名称。 */
  experiment_id: string;
  experiment_name: string;

  /** 浏览器实验库与保存状态。 */
  saved_experiments: ServerExperimentSummary[];
  current_experiment_role: ExperimentRole;
  experiment_manager_open: boolean;
  experiment_busy: boolean;
  experiment_error: string | null;
  last_saved_at: string | null;

  /** 三维画质与灯光设置。 */
  render_settings: RenderSettings;
  visual_settings_open: boolean;

  /** 事件流（最近 200 条）。 */
  events: SimlabEvent[];

  /** 无线状态。 */
  wireless: WirelessSnapshot | null;

  /** 需要随服务器实验文档保存的无线模型关联。 */
  wireless_associations: Record<string, string>;
  ap_radio_configs: Record<string, ApRadioSettings>;

  /** 光链路状态。 */
  optical: OpticalSnapshot | null;

  /** 线缆栏选中的线缆类型（拖拽连线时使用）。 */
  pending_cable_kind: string | null;

  /** 设备工坊：是否打开。 */
  workshop_open: boolean;

  /** 设备工坊：正在编辑的模板（深拷贝，保存后写回注册表）。 */
  workshop_template: DeviceTemplate | null;

  /** 设备工坊：选中部件 ID。 */
  workshop_part_id: string | null;

  /** 设备工坊：爆炸系数。 */
  workshop_explode: number;

  /** 设备工坊：Gizmo 模式。 */
  workshop_gizmo: 'translate' | 'rotate' | 'scale' | 'none';

  /** 设备工坊：吸附步长（毫米，0 = 关闭）。 */
  workshop_snap_mm: number;

  /** 设备工坊：显示模式。 */
  workshop_display: 'shaded' | 'wireframe' | 'edged';

  /** 设备工坊：是否显示网格与参考面。 */
  workshop_grid: boolean;

  /** 设备工坊：撤销栈。 */
  workshop_history: DeviceTemplate[];

  /** 设备工坊：重做栈。 */
  workshop_future: DeviceTemplate[];

  /** 右键菜单（null 表示未打开）。 */
  context_menu: {
    kind: 'device' | 'port' | 'cable' | 'background';
    device_id?: string;
    port?: string;
    cable_id?: string;
    x: number;
    y: number;
  } | null;

  /** 最近一次 ping 结果。 */
  ping_result: PingResult | null;

  /** 线缆标签编辑框（null 表示未打开）。 */
  label_editor: {
    cable_id: string;
    side: 'from' | 'to';
    text: string;
    x: number;
    y: number;
  } | null;

  /** 用户自定义线缆标签（cable_id → 两端文本）。 */
  cable_labels: Record<string, { from: string; to: string }>;

  /** 用户拉动过的线缆走线控制点（cable_id → 世界坐标数组）。 */
  cable_waypoints: Record<string, [number, number, number][]>;

  /** 状态版本号（用于强制刷新）。 */
  revision: number;

  /** 初始化运行时并进入空白实验；URL 显式提供 models 时才装载演示设备。 */
  init: (api_base?: string | null) => Promise<void>;

  /** 重新读取设备与线缆镜像。 */
  refresh: () => void;

  /** 打开标签编辑框。 */
  open_label_editor: (
    cable_id: string,
    side: 'from' | 'to',
    text: string,
    x: number,
    y: number
  ) => void;

  /** 关闭标签编辑框。 */
  close_label_editor: () => void;

  /** 保存标签文本（空串恢复默认编号）。 */
  save_label_text: (cable_id: string, side: 'from' | 'to', text: string) => void;

  /** 记录线缆走线控制点（用户拉动线缆后调用）。 */
  set_cable_waypoints: (cable_id: string, points: [number, number, number][]) => void;

  /** 拖动线缆端点改插到新端口。 */
  reconnect_cable: (
    cable_id: string,
    side: 'from' | 'to',
    device_id: string,
    port: string
  ) => Promise<void>;

  /** 创建设备。 */
  create_device: (model_id: string, hostname?: string) => Promise<string | null>;

  /** 删除设备。 */
  delete_device: (device_id: string) => Promise<void>;

  /** 选择设备。 */
  select_device: (device_id: string | null) => void;

  /** 选择端口。 */
  select_port: (device_id: string, port: string | null) => void;

  /** 进入连线模式。 */
  start_link: (source: PortRef) => void;

  /** 取消连线模式。 */
  cancel_link: () => void;

  /** 完成连线（目标端口）。 */
  complete_link: (target: PortRef) => Promise<void>;

  /** 接向模拟对端。 */
  connect_peer: (source: PortRef) => Promise<void>;

  /** 断开端口上的线缆。 */
  disconnect_port: (device_id: string, port: string) => Promise<void>;

  /** 开关机。 */
  toggle_power: (device_id: string) => Promise<void>;

  /** 刷新 simlab-g0-pc1 的真实状态与当前绑定。 */
  refresh_g0_binding: () => Promise<void>;

  /** 将 simlab-g0-pc1 绑定到指定的前端 PC。 */
  bind_g0_pc: (device_id: string) => Promise<void>;

  /** 解除 simlab-g0-pc1 的前端投影，不改变虚拟机电源。 */
  unbind_g0_pc: () => Promise<void>;

  /** 刷新已有和平台创建的桌面虚拟机。 */
  refresh_desktop_runtimes: () => Promise<void>;

  /** 取消新增计算设备。 */
  cancel_runtime_device_creation: () => void;

  /** 使用已有虚拟机完成前端计算设备创建。 */
  create_device_with_existing_runtime: (runtime_id: string) => Promise<string | null>;

  /** 创建后端虚拟机并完成前端计算设备创建。 */
  create_device_with_new_runtime: (spec: DesktopRuntimeSpec, count?: number, node_name?: string) => Promise<string | null>;

  /** 仅创建前端计算设备，暂不绑定或创建后端虚拟机。 */
  create_device_without_runtime: (count?: number, node_name?: string) => Promise<string | null>;

  /** 将已有资源池虚拟机绑定到场景中的 PC 或笔记本。 */
  bind_desktop_to_device: (device_id: string, runtime_id: string) => Promise<void>;

  /** 为场景中的 PC 或笔记本新建并绑定后端虚拟机。 */
  provision_desktop_for_device: (
    device_id: string,
    spec: DesktopRuntimeSpec
  ) => Promise<void>;

  /** 解除前端设备和后端虚拟机的映射。 */
  unbind_desktop_from_device: (device_id: string) => Promise<void>;

  /** 删除一台已停止且未绑定的平台创建虚拟机。 */
  delete_managed_desktop_runtime: (runtime_id: string) => Promise<void>;

  /** 实验关闭前正常关闭并解绑当前场景中的桌面虚拟机。 */
  release_experiment_desktops: (keepalive?: boolean) => Promise<boolean>;

  /** 移动设备。 */
  move_device: (device_id: string, position: { x: number; y: number; z: number }) => Promise<void>;

  /** 端口配置。 */
  configure_port: (
    device_id: string,
    port: string,
    changes: Record<string, unknown>
  ) => Promise<void>;

  /** 故障注入。 */
  inject_fault: (device_id: string, port: string | null, fault_type: string) => Promise<void>;

  /** 保存配置。 */
  save_config: (device_id: string) => Promise<void>;

  /** 设置视图预设。 */
  set_view: (view: ViewPreset) => void;

  /** 设置显示模式。 */
  set_display_mode: (mode: DisplayMode) => void;

  /** 切换转发路径显示。 */
  toggle_flow: () => void;

  /** 切换自动旋转。 */
  toggle_auto_rotate: () => void;

  /** 新建空白实验。 */
  new_experiment: (name?: string) => Promise<void>;

  /** 保存当前实验到浏览器。 */
  save_experiment: (name?: string) => Promise<void>;

  /** 从浏览器实验库载入实验。 */
  load_experiment: (experiment_id: string) => Promise<void>;

  /** 删除实验库中的实验。 */
  delete_saved_experiment: (experiment_id: string) => Promise<void>;

  /** 刷新实验库列表。 */
  refresh_experiment_library: () => Promise<void>;

  /** 打开或关闭实验管理窗口。 */
  set_experiment_manager_open: (open: boolean) => void;

  /** 更新画质与光照设置。 */
  update_render_settings: (changes: Partial<RenderSettings>) => void;

  /** 打开或关闭画质设置窗口。 */
  set_visual_settings_open: (open: boolean) => void;

  /** 端到端 ping。 */
  ping: (source_device_id: string, target: { device_id?: string; ip?: string }) => Promise<void>;

  /** 刷新无线状态。 */
  refresh_wireless: () => Promise<void>;

  /** 关联 AP。 */
  associate: (sta_device_id: string, ap_device_id?: string) => Promise<void>;

  /** 解除无线关联。 */
  disassociate: (sta_device_id: string) => Promise<void>;
  configure_ap_radio: (device_id: string, settings: ApRadioSettings) => Promise<void>;

  /** 刷新光链路状态。 */
  refresh_optical: () => Promise<void>;

  /** 变更 ONU 光纤参数。 */
  set_optical_fiber: (
    onu_device_id: string,
    options: {
      fiber_length_m?: number;
      splitter_ratio?: number;
      connectors?: number;
      splices?: number;
      broken?: boolean;
    }
  ) => Promise<void>;

  /** 设置 ONU 业务负载。 */
  set_optical_traffic: (
    onu_device_id: string,
    traffic: { downstream_mbps?: number; upstream_mbps?: number }
  ) => Promise<void>;

  /** 打开设备工坊（不带型号表示新建空白设备）。 */
  open_workshop: (model_id?: string | null) => Promise<void>;

  /** 关闭设备工坊。 */
  close_workshop: () => void;

  /** 选中工坊里的部件。 */
  select_workshop_part: (part_id: string | null) => void;

  /** 更新部件参数。 */
  update_workshop_part: (part_id: string, params: PartParams) => void;

  /** 新增部件。 */
  add_workshop_part: (kind: string) => void;

  /** 删除部件。 */
  remove_workshop_part: (part_id: string) => void;

  /** 调整部件顺序（装配顺序）。 */
  move_workshop_part: (part_id: string, delta: number) => void;

  /** 更新模板元信息（型号/名称/厂商/尺寸等）。 */
  update_workshop_meta: (patch: Partial<DeviceTemplate>) => void;

  /** 设置爆炸系数。 */
  set_workshop_explode: (amount: number) => void;
  /** 更新部件变换（位置米 / 旋转弧度 / 缩放倍数）。 */
  update_workshop_transform: (
    part_id: string,
    transform: {
      position: [number, number, number];
      rotation: [number, number, number];
      scale: [number, number, number];
    }
  ) => void;

  /** 复位部件变换。 */
  reset_workshop_transform: (part_id: string) => void;

  /** 复制部件（带 2 cm 偏移，便于立即拖动）。 */
  duplicate_workshop_part: (part_id: string) => void;

  /** 设置 Gizmo 模式。 */
  set_workshop_gizmo: (mode: 'translate' | 'rotate' | 'scale' | 'none') => void;

  /** 设置吸附步长（毫米，0 = 关闭）。 */
  set_workshop_snap: (millimeters: number) => void;

  /** 设置显示模式。 */
  set_workshop_display: (mode: 'shaded' | 'wireframe' | 'edged') => void;

  /** 开关网格与参考面。 */
  set_workshop_grid: (visible: boolean) => void;

  /** 撤销上一次工坊编辑。 */
  undo_workshop: () => void;

  /** 重做工坊编辑。 */
  redo_workshop: () => void;

  /** 保存工坊模板到设备栏。 */
  save_workshop: () => DeviceTemplate | null;

  /** 删除某个用户模板。 */
  delete_template: (model_id: string) => void;

  /** 模板版本号（工坊保存/删除后自增，用于刷新缩略图与场景几何）。 */
  template_revision: number;

  /** 设备栏模板列表（内置 + 用户）。 */
  template_list: () => DeviceTemplate[];

  /** 打开右键菜单。 */
  open_context_menu: (menu: {
    kind: 'device' | 'port' | 'cable' | 'background';
    device_id?: string;
    port?: string;
    cable_id?: string;
    x: number;
    y: number;
  }) => void;

  /** 关闭右键菜单。 */
  close_context_menu: () => void;

  /** 打开某设备的 CLI 调试（切换控制台到该设备）。 */
  open_console: (device_id: string) => void;

  /** 请求创建冷快照（后端虚拟化接口预留：POST /devices/{id}/snapshots/）。 */
  request_snapshot: (device_id: string) => void;

  /** 控制台当前聚焦的设备。 */
  console_device_id: string | null;

  /** 每次右键打开 CLI 都递增，使关闭后再次打开同一设备仍能响应。 */
  console_request_seq: number;

  /** 设置线缆栏选中的线缆类型。 */
  set_pending_cable_kind: (cable_kind: string | null) => void;

  /** 在指定落点创建设备（设备栏拖入场景）。 */
  create_device_at: (model_id: string, x: number, z: number) => Promise<string | null>;

  /** 线缆栏拖入场景：从最近端口按指定线缆类型开始连线。 */
  begin_cable_from_kind: (cable_kind: string, x: number, z: number) => Promise<void>;

  /** 重命名设备。 */
  rename_device: (device_id: string, hostname: string) => Promise<void>;

  /** 复制设备（在同一位置附近创建同型号设备）。 */
  duplicate_device: (device_id: string) => Promise<void>;

  /** 写入事件并刷新界面。 */
  push_event: (event: SimlabEvent) => void;
}

/**
 * 读取 URL 查询参数。
 *
 * @param {string} name 参数名。
 * @returns {string | null} 参数值。
 */
function cable_type_for_kind(cable_kind: string | null): string {
  if (!cable_kind) {
    return CABLE_TYPE.ETHERNET_COPPER;
  }
  if (cable_kind.indexOf('fiber') === 0 || cable_kind === 'dac_sfp') {
    return CABLE_TYPE.OPTICAL_FIBER;
  }
  if (cable_kind.indexOf('power') === 0 || cable_kind === 'ground') {
    return CABLE_TYPE.POWER_AC;
  }
  if (cable_kind === 'console') {
    return CABLE_TYPE.CONSOLE;
  }

  return CABLE_TYPE.ETHERNET_COPPER;
}

/**
 * 查询 URL 参数。
 *
 * @param {string} name 参数名。
 * @returns {string | null} 参数值。
 */
function query_parameter(name: string): string | null {
  const matched = new RegExp('[?&]' + name + '=([^&]+)').exec(window.location.search);
  return matched ? decodeURIComponent(matched[1]) : null;
}

/** 首次登录时把旧版浏览器实验逐个迁移到当前账户的服务器实验库。 */
async function migrate_legacy_experiments(): Promise<void> {
  let legacy_summaries: ReturnType<typeof list_legacy_experiments>;
  try {
    legacy_summaries = list_legacy_experiments();
  } catch (error) {
    void error;
    return;
  }
  for (const summary of legacy_summaries) {
    const legacy = load_legacy_experiment(summary.experiment_id);
    const created = await create_server_experiment(legacy.name);
    const migrated: SavedExperiment = {
      ...legacy,
      experiment_id: created.experiment_id,
      name: created.name
    };
    await save_server_experiment(migrated, created.config_revision);
    delete_legacy_experiment(summary.experiment_id);
  }
}

/** 全局仓库。 */
export const use_store = create<AppState>((set, get) => {
  /** 订阅事件总线（只订阅一次）。 */
  let subscribed = false;

  /**
   * 确保事件订阅已建立。
   *
   * @returns {void}
   */
  const ensure_subscription = (): void => {
    if (subscribed) {
      return;
    }
    subscribed = true;
    bus.subscribe('*', (event) => get().push_event(event));
  };

  /** 创建前端计算设备，并用调用方提供的后端动作完成绑定；失败时回滚前端设备。 */
  const finish_runtime_device_creation = async (
    attach: ((target: {
      experiment_id: string;
      device_id: string;
      model_id: string;
      display_name: string;
      device_type: string;
      nic_aliases: string[];
      port_keys: string[];
    }, node_name: string) => Promise<DesktopRuntimeInstance>) | null,
    requested_hostname?: string,
    count = 1
  ): Promise<string | null> => {
    const pending = get().pending_runtime_device;
    const runtime = get().runtime;
    if (!pending || !runtime) {
      return null;
    }
    const device_type = get_registry().manifest(pending.model_id)?.device_type || 'node';
    const prefix = device_type === 'l3switch' ? 'switch' : device_type;
    const existing_count = runtime.list_devices().length;
    const base_position = pending.position || {
      x: -4 + (existing_count % 5) * 1.8,
      y: 0,
      z: -2 + Math.floor(existing_count / 5) * 1.6
    };
    let names: string[];
    try {
      names = plan_runtime_node_names(
        requested_hostname || pending.hostname || `${prefix}1`, count,
        runtime.list_devices().map((device) => device.hostname)
      );
    } catch (error) {
      set({ desktop_runtime_error: error instanceof Error ? error.message : 'NODE_NAME_INVALID：节点名称无效。' });
      return null;
    }
    set({ desktop_runtime_busy: true, desktop_runtime_error: null });
    const created: string[] = [];
    let failure: string | null = null;
    for (const [index, node_name] of names.entries()) {
      let device_id: string | null = null;
      try {
        const result = await runtime.create_device(
          pending.model_id, node_name, undefined, desktop_port_keys(pending.model_id)
        );
        const raw_device_id = result.data?.device_id;
        device_id = result.success && raw_device_id ? String(raw_device_id) : null;
        if (!device_id) throw new Error(`${result.error_code || 'DEVICE_CREATE_FAILED'}：${result.message || '前端设备创建失败。'}`);
        const device = runtime.get_device(device_id);
        if (!device) throw new Error('DEVICE_NOT_FOUND：无法读取新建设备；请刷新实验。');
        const moved = await runtime.move_device(device_id, {
          x: base_position.x + (index % 4) * 1.8,
          y: base_position.y,
          z: base_position.z + Math.floor(index / 4) * 1.6
        });
        if (!moved.success) throw new Error(`${moved.error_code || 'DEVICE_MOVE_FAILED'}：${moved.message || '设备摆放失败。'}`);
        if (attach) {
          await attach({
            experiment_id: get().experiment_id,
            device_id: device.device_id,
            model_id: device.model_id,
            display_name: device.hostname,
            device_type: device.device_type,
            nic_aliases: desktop_port_aliases(device.model_id),
            port_keys: desktop_runtime_port_keys(device.model_id)
          }, node_name);
        }
        created.push(device_id);
      } catch (error) {
        if (device_id) await runtime.delete_device(device_id).catch(() => undefined);
        failure = error instanceof Error ? error.message : 'BATCH_CREATE_FAILED：节点创建失败；请检查 Runtime 状态。';
        break;
      }
    }
    if (created.length) {
      set({ selected_device_id: created.at(-1) || null, selected_port: null });
      get().refresh();
      try {
        await get().refresh_desktop_runtimes();
        await get().save_experiment();
      } catch (error) {
        failure = `BATCH_SAVE_FAILED：设备已创建，但资源池或实验保存失败；${
          error instanceof Error ? error.message : '请刷新实验并核对已创建节点'
        }`;
      }
    }
    set({
      desktop_runtime_busy: false,
      desktop_runtime_error: failure ?
        `BATCH_CREATE_PARTIAL：已创建 ${created.length}/${names.length} 台；${failure}。请核对已创建节点后重试。` : null,
      pending_runtime_device: created.length === names.length ? null : pending
    });
    return created.at(-1) || null;
  };

  return {
    runtime: null,
    runtime_mode: 'local',
    api_base: null,
    connected: false,
    device_ids: [],
    cables: [],
    cloud_uplinks: {},
    selected_device_id: null,
    selected_port: null,
    g0_binding: null,
    g0_busy: false,
    g0_error: null,
    desktop_runtimes: [],
    desktop_profiles: [],
    vendor_image_candidates: [],
    vendor_image_scan_error: null,
    desktop_runtime_busy: false,
    desktop_runtime_error: null,
    pending_runtime_device: null,
    link_source: null,
    view: 'iso',
    display_mode: 'shell',
    flow_enabled: true,
    auto_rotate: false,
    experiment_id: create_experiment_id(),
    experiment_name: '未命名实验',
    saved_experiments: [],
    current_experiment_role: 'OWNER',
    experiment_manager_open: false,
    experiment_busy: false,
    experiment_error: null,
    last_saved_at: null,
    render_settings: { ...DEFAULT_RENDER_SETTINGS },
    visual_settings_open: false,
    events: [],
    wireless: null,
    wireless_associations: {},
    ap_radio_configs: {},
    optical: null,
    pending_cable_kind: null,
    workshop_open: false,
    workshop_template: null,
    workshop_part_id: null,
    workshop_explode: 0,
    workshop_gizmo: 'translate',
    workshop_snap_mm: 0,
    workshop_display: 'shaded',
    workshop_grid: true,
    workshop_history: [],
    workshop_future: [],
    context_menu: null,
    console_device_id: null,
    console_request_seq: 0,
    cable_waypoints: {},
    label_editor: null,
    cable_labels: {},
    template_revision: 0,
    ping_result: null,
    revision: 0,

    init: async (api_base) => {
      ensure_subscription();
      /* 设备模板（按型号懒加载）必须先就绪，三维设备才能按模板装配。 */
      await ensure_templates_loaded();
      await migrate_legacy_experiments();
      let server_experiments = await list_server_experiments();
      const requested_experiment_id = query_parameter('experiment');
      let selected_experiment = requested_experiment_id
        ? server_experiments.find((item) => item.experiment_id === requested_experiment_id)
        : server_experiments[0];
      if (!selected_experiment) {
        selected_experiment = await create_server_experiment('未命名实验');
        server_experiments = [selected_experiment, ...server_experiments];
      }
      const requested = api_base || query_parameter('api');
      const experiment_id = selected_experiment.experiment_id;
      let runtime: RuntimeClient;
      let mode: 'local' | 'remote' = 'local';
      if (requested) {
        const remote = new RemoteRuntime({
          base_url: requested,
          bus: bus,
          experiment_id: experiment_id
        });
        const ok = await remote.connect();
        if (ok) {
          runtime = remote;
          mode = 'remote';
        } else {
          console.warn('远端控制平面不可用，回退到本地模拟运行时：' + requested);
          runtime = new LocalRuntime({
            bus: bus,
            experiment_id: experiment_id,
            device_id_namespace: experiment_id
          });
          await runtime.connect();
        }
      } else {
        runtime = new LocalRuntime({
          bus: bus,
          experiment_id: experiment_id,
          device_id_namespace: experiment_id
        });
        await runtime.connect();
      }

      set({
        runtime: runtime,
        runtime_mode: mode,
        api_base: mode === 'remote' ? requested : null,
        connected: mode === 'remote',
        experiment_id: experiment_id,
        experiment_name: selected_experiment.name,
        current_experiment_role: selected_experiment.role,
        saved_experiments: server_experiments
      });

      /* 默认进入空实验台。只有显式提供 ?models= 时才创建演示设备，便于自动化验收。 */
      const model_ids = (query_parameter('models') || '')
        .split(',')
        .filter((item) => item.length > 0);
      const sequence = model_ids;
      const created: string[] = [];
      for (const model_id of sequence) {
        /* 初始演示拓扑只恢复前端设备；真实桌面绑定由资源池按稳定 dev-NNN 恢复。 */
        const result = await runtime.create_device(model_id);
        const device_id =
          result.success && result.data?.device_id ? String(result.data.device_id) : null;
        if (device_id) {
          created.push(device_id);
        }
      }
      get().refresh();

      /* 自动接线：交换机 GE0/0/1 ↔ 路由器 GE1/0/1，交换机 GE0/0/2 ↔ AP 上联口。 */
      if (created.length >= 3 && query_parameter('cables') !== '0') {
        const switcher = runtime.get_device(created[0]);
        const router = runtime.get_device(created[1]);
        const ap = runtime.get_device(created[2]);
        if (switcher && router) {
          const switch_port = switcher.ports.find((port) => port.kind === 'rj45');
          const router_port = router.ports.find((port) => port.kind === 'rj45');
          if (switch_port && router_port) {
            await runtime.connect_cable(
              { device_id: switcher.device_id, port: switch_port.short_name },
              { device_id: router.device_id, port: router_port.short_name }
            );
          }
        }
        if (switcher && ap) {
          const switch_port = switcher.ports.filter((port) => port.kind === 'rj45')[1];
          const ap_port = ap.ports[0];
          if (switch_port && ap_port) {
            await runtime.connect_cable(
              { device_id: switcher.device_id, port: switch_port.short_name },
              { device_id: ap.device_id, port: ap_port.short_name }
            );
          }
        }
      }

      /* 光接入网自动布线：OLT 的 PON 口 ↔ ONU 的 GPON 口（光纤线缆）。 */
      if (created.length >= 8 && query_parameter('cables') !== '0') {
        const olt = runtime.get_device(created[5]);
        const onus = [runtime.get_device(created[6]), runtime.get_device(created[7])];
        if (olt) {
          const pon_ports = olt.ports.filter((port) => port.kind === 'sfp');
          onus.forEach((onu, index) => {
            if (!onu || !pon_ports[index]) {
              return;
            }
            const onu_port = onu.ports.find((port) => port.kind === 'sfp');
            if (!onu_port) {
              return;
            }
            void runtime.connect_cable(
              { device_id: olt.device_id, port: pon_ports[index].short_name },
              { device_id: onu.device_id, port: onu_port.short_name },
              'OPTICAL_FIBER'
            );
          });
        }
      }

      /* 上电并等待启动完成，然后让无线客户端自动关联。 */
      for (const device_id of created) {
        const device = runtime.get_device(device_id);
        if (device && !is_runtime_model(device.model_id)) {
          await runtime.power(device_id, true);
        }
      }
      await get().refresh_desktop_runtimes();
      if (created.length >= 5 && query_parameter('cables') !== '0') {
        window.setTimeout(() => {
          void get().associate(created[3], created[2]);
          void get().associate(created[4], created[2]);
        }, 5200);
      }
      /* 光链路演示负载：两台 ONU 各 300/120 Mbps，便于观察 DBA 分配。 */
      if (created.length >= 8 && query_parameter('cables') !== '0') {
        window.setTimeout(() => {
          const state = get();
          void state.set_optical_traffic(created[6], { downstream_mbps: 300, upstream_mbps: 120 });
          void state.set_optical_traffic(created[7], { downstream_mbps: 300, upstream_mbps: 120 });
          void state.refresh_optical();
        }, 6000);
      }

      const first = created[0] || null;
      set({ selected_device_id: first, experiment_id: experiment_id });
      get().refresh();
      await get().refresh_experiment_library();
      if (
        mode === 'local' &&
        created.length === 0 &&
        selected_experiment.has_document
      ) {
        await get().load_experiment(experiment_id);
      }
      if (runtime.type() === 'remote') {
        await get().refresh_wireless();
        await get().refresh_optical();
      }
      /* 远端模式：拓扑由事件驱动，定期兜底刷新。 */
      window.setInterval(() => {
        const state = get();
        state.refresh();
        if (state.runtime_mode === 'local') {
          void state.refresh_wireless();
          void state.refresh_optical();
        }
      }, 3000);
    },

    refresh: () => {
      const runtime = get().runtime;
      if (!runtime) {
        return;
      }
      set((state) => ({
        device_ids: runtime.list_devices().map((device) => device.device_id),
        cables: runtime.cables_snapshot(),
        revision: state.revision + 1
      }));
    },

    create_device: async (model_id, hostname) => {
      if (get().current_experiment_role === 'VIEWER') return null;
      const runtime = get().runtime;
      if (!runtime) {
        return null;
      }
      if (is_runtime_model(model_id)) {
        set({
          pending_runtime_device: { model_id: model_id, hostname: hostname },
          desktop_runtime_error: null
        });
        return null;
      }
      const result = await runtime.create_device(model_id, hostname);
      if (!result.success) {
        console.warn('创建设备失败：' + result.message);
        return null;
      }
      const device_id = result.data && result.data.device_id ? result.data.device_id : null;
      get().refresh();
      if (device_id) {
        await runtime.power(device_id, true);
        get().refresh();
      }
      return device_id ? String(device_id) : null;
    },

    delete_device: async (device_id) => {
      if (get().current_experiment_role === 'VIEWER') return;
      const runtime = get().runtime;
      if (!runtime) {
        return;
      }
      const cloud_uplink = get().cloud_uplinks[device_id];
      if (cloud_uplink) {
        const previous_uplinks = get().cloud_uplinks;
        set({ cloud_uplinks: { ...previous_uplinks, [device_id]: '' } });
        await get().save_experiment();
        if (get().experiment_error) {
          set({ cloud_uplinks: previous_uplinks });
          return;
        }
      }
      const desktop_binding = get().desktop_runtimes.find(
        (item) => item.bound_device_id === device_id
      );
      if (desktop_binding) {
        set({ desktop_runtime_busy: true, desktop_runtime_error: null });
        try {
          await destroy_bound_desktop_runtime(desktop_binding.id, device_id);
        } catch (error) {
          set({
            desktop_runtime_busy: false,
            desktop_runtime_error: runtime_action_error(
              error,
              'RUNTIME_DESTROY_FAILED',
              '后端虚拟机销毁失败，前端设备未删除'
            )
          });
          return;
        }
        set({ desktop_runtime_busy: false, desktop_runtime_error: null });
        await get().refresh_desktop_runtimes();
      } else if (get().g0_binding?.bound_device_id === device_id) {
        set({ g0_busy: true, g0_error: null });
        const binding = await request_g0_pc_power(device_id, false);
        if (!binding.success) {
          set({
            g0_busy: false,
            g0_error: `${binding.error_code || 'G0_RELEASE_FAILED'}：${
              binding.message || '后端虚拟机关闭和解绑失败，前端设备未删除'
            }。请检查 Host Agent 与 Django 服务状态后重试。`
          });
          return;
        }
        set({ g0_binding: binding, g0_busy: false, g0_error: null });
      }
      await runtime.delete_device(device_id);
      set((state) => ({
        wireless_associations: Object.fromEntries(
          Object.entries(state.wireless_associations).filter(
            ([client_id, ap_id]) => client_id !== device_id && ap_id !== device_id
          )
        ),
        ap_radio_configs: Object.fromEntries(
          Object.entries(state.ap_radio_configs).filter(([ap_id]) => ap_id !== device_id)
        )
      }));
      if (get().selected_device_id === device_id) {
        set({ selected_device_id: null, selected_port: null });
      }
      get().refresh();
      if (get().desktop_runtimes.some((item) => item.bound_device_id) ||
          Object.prototype.hasOwnProperty.call(get().cloud_uplinks, device_id)) {
        set((state) => {
          const cloud_uplinks = { ...state.cloud_uplinks };
          delete cloud_uplinks[device_id];
          return { cloud_uplinks };
        });
        await get().save_experiment();
      }
    },

    set_cloud_uplink: async (device_id, bridge) => {
      if (get().current_experiment_role === 'VIEWER') return;
      if (get().runtime?.get_device(device_id)?.model_id !== 'generic-cloud-bridge') return;
      const previous = get().cloud_uplinks;
      set({ cloud_uplinks: { ...previous, [device_id]: bridge } });
      await get().save_experiment();
      if (get().experiment_error) set({ cloud_uplinks: previous });
    },

    select_device: (device_id) => set({ selected_device_id: device_id, selected_port: null }),

    select_port: (device_id, port) => set({ selected_device_id: device_id, selected_port: port }),

    start_link: (source) => {
      if (get().current_experiment_role === 'VIEWER') return;
      set({ link_source: source, selected_port: source.port });
    },

    cancel_link: () => set({ link_source: null }),

    complete_link: async (target) => {
      if (get().current_experiment_role === 'VIEWER') return;
      const runtime = get().runtime;
      const source = get().link_source;
      if (!runtime || !source) {
        return;
      }
      /* 线缆栏选中的线缆类型决定线缆种类（网线/光纤/电源线/Console 线）。 */
      const cable_type = cable_type_for_kind(get().pending_cable_kind);
      const result = await runtime.connect_cable(source, target, cable_type);
      if (!result.success) {
        console.warn('连线失败：' + result.message);
      }
      set({ link_source: null, pending_cable_kind: get().pending_cable_kind });
      get().refresh();
      if (result.success && (get().desktop_runtimes.some((item) => item.bound_device_id) ||
          Object.values(get().cloud_uplinks).some(Boolean))) {
        await get().save_experiment();
      }
    },

    connect_peer: async (source) => {
      if (get().current_experiment_role === 'VIEWER') return;
      const runtime = get().runtime;
      if (!runtime) {
        return;
      }
      const result = await runtime.connect_cable(source);
      if (!result.success) {
        console.warn('连线失败：' + result.message);
      }
      set({ link_source: null });
      get().refresh();
      if (result.success && (get().desktop_runtimes.some((item) => item.bound_device_id) ||
          Object.values(get().cloud_uplinks).some(Boolean))) {
        await get().save_experiment();
      }
    },

    reconnect_cable: async (cable_id, side, target_device_id, target_port) => {
      if (get().current_experiment_role === 'VIEWER') return;
      const runtime = get().runtime;
      if (!runtime) {
        return;
      }
      const record = runtime.cables_snapshot().find((item) => item.cable_id === cable_id);
      if (!record) {
        return;
      }
      const moving = { device_id: target_device_id, port: target_port };
      const keep = side === 'from' ? record.target : record.source;
      const vacated = side === 'from' ? record.source : record.target;
      if (!keep || !vacated) {
        return;
      }
      if (moving.device_id === vacated.device_id && moving.port === vacated.port) {
        return;
      }
      /* 目标端口被别的线缆占用 → 与它"换位"（真机可换口，不必先拔）。 */
      const target_device = runtime.get_device(target_device_id);
      const occupied = target_device ? target_device.find_port(target_port) : null;
      const occupant = occupied && occupied.cable ? occupied.cable : null;
      const occupant_record = occupant
        ? runtime.cables_snapshot().find((item) => item.cable_id === occupant.cable_id) || null
        : null;
      /* 落点是"另一端所在设备"时自动换位：把另一端挪到本端刚腾出的端口，
         这样线缆仍然连接两台设备（真机上就是把插头换到新口）。 */
      const swapping_ends = moving.device_id === keep.device_id;
      /* 落点端始终是用户拖到的目标端口；换位时"另一端"改挂到本端刚腾出的端口。 */
      const anchor_end = swapping_ends ? vacated : keep;
      const dropped_end = moving;
      await runtime.disconnect_cable(cable_id);
      if (occupant_record) {
        await runtime.disconnect_cable(occupant_record.cable_id);
      }
      const result = await runtime.connect_cable(dropped_end, anchor_end, record.cable_type);
      if (!result.success) {
        console.warn('改插失败，已回滚：' + result.message);
        const rollback = await runtime.connect_cable(
          record.source,
          record.target || undefined,
          record.cable_type
        );
        if (occupant_record) {
          const occupant_rollback = await runtime.connect_cable(
            occupant_record.source,
            occupant_record.target || undefined,
            occupant_record.cable_type
          );
          if (!occupant_rollback.success) {
            console.warn('换位回滚失败：' + occupant_rollback.message);
          }
        }
        if (!rollback.success) {
          console.warn('回滚失败：' + rollback.message);
        }
        get().refresh();
        return;
      }
      if (occupant_record) {
        /* 占用方被换到本端刚腾出的端口上（两个插头互换位置）。 */
        const swap = await runtime.connect_cable(
          occupant_record.source.device_id === target_device_id
            ? vacated
            : occupant_record.source,
          occupant_record.source.device_id === target_device_id
            ? occupant_record.target
            : vacated,
          occupant_record.cable_type
        );
        if (!swap.success) {
          console.warn('换位未完成：' + swap.message);
        }
      }
      /* 改插后原走线不再适用（线缆 ID 可能变化），清掉旧的控制点记录。 */
      const waypoints = { ...get().cable_waypoints };
      delete waypoints[cable_id];
      set({ cable_waypoints: waypoints });
      get().refresh();
      if (get().desktop_runtimes.some((item) => item.bound_device_id) ||
          Object.values(get().cloud_uplinks).some(Boolean)) {
        await get().save_experiment();
      }
    },

    disconnect_port: async (device_id, port) => {
      if (get().current_experiment_role === 'VIEWER') return;
      const runtime = get().runtime;
      if (!runtime) {
        return;
      }
      const device = runtime.get_device(device_id);
      const port_state = device ? device.find_port(port) : null;
      if (!port_state || !port_state.cable) {
        return;
      }
      await runtime.disconnect_cable(port_state.cable.cable_id);
      get().refresh();
      if (get().desktop_runtimes.some((item) => item.bound_device_id) ||
          Object.values(get().cloud_uplinks).some(Boolean)) {
        await get().save_experiment();
      }
    },

    toggle_power: async (device_id) => {
      if (get().current_experiment_role === 'VIEWER') return;
      const runtime = get().runtime;
      if (!runtime) {
        return;
      }
      const device = runtime.get_device(device_id);
      if (!device) {
        return;
      }
      if (is_runtime_model(device.model_id)) {
        const binding = get().desktop_runtimes.find(
          (item) => item.bound_device_id === device_id
        );
        if (!binding) {
          const legacy_binding = get().g0_binding;
          if (legacy_binding?.bound_device_id === device_id) {
            const is_running = legacy_binding.power_state === 'RUNNING';
            set({ g0_busy: true, g0_error: null });
            const next = await request_g0_pc_power(device_id, !is_running);
            if (!next.success) {
              set({
                g0_busy: false,
                g0_error: next.message || '虚拟机电源操作失败'
              });
              return;
            }
            device.power_state =
              next.power_state === 'RUNNING' ? DEVICE_STATE.RUNNING : DEVICE_STATE.OFF;
            set((state) => ({
              g0_binding: next,
              g0_busy: false,
              g0_error: null,
              revision: state.revision + 1
            }));
            return;
          }
          set({ desktop_runtime_error: '请先为这台设备绑定或创建后端虚拟机' });
          return;
        }
        const is_running = binding.power_state === 'RUNNING';
        set({ desktop_runtime_busy: true, desktop_runtime_error: null });
        let next: DesktopRuntimeInstance;
        try {
          next = await power_desktop_runtime(binding.id, device_id, !is_running);
          device.power_state =
            next.power_state === 'RUNNING' ? DEVICE_STATE.RUNNING : DEVICE_STATE.OFF;
        } catch (error) {
          set({
            desktop_runtime_busy: false,
            desktop_runtime_error: error instanceof Error ? error.message : '虚拟机电源操作失败'
          });
          return;
        }
        set((state) => ({
          desktop_runtime_busy: false,
          desktop_runtime_error: null,
          desktop_runtimes: state.desktop_runtimes.map((item) =>
            item.id === next.id ? next : item
          ),
          revision: state.revision + 1
        }));
        await get().refresh_desktop_runtimes();
        return;
      }
      const is_running =
        device.power_state === 'RUNNING' ||
        device.power_state === 'POWERING_ON' ||
        device.power_state === 'BOOTING';
      await runtime.power(device_id, !is_running);
      get().refresh();
      if (device.device_type === 'ap' && is_running &&
          get().desktop_runtimes.some((item) =>
            item.bound_device_id && get().wireless_associations[item.bound_device_id] === device_id)) {
        await get().save_experiment();
      }
    },

    refresh_g0_binding: async () => {
      const binding = await fetch_g0_pc_binding();
      const runtime = get().runtime;
      if (runtime && binding.success) {
        for (const candidate of runtime.list_devices()) {
          if (candidate.model_id === 'generic-atx-pc') {
            candidate.power_state = DEVICE_STATE.OFF;
          }
        }
        if (binding.bound_device_id) {
          const device = runtime.get_device(binding.bound_device_id);
          if (device?.model_id === 'generic-atx-pc') {
            device.power_state =
              binding.power_state === 'RUNNING' ? DEVICE_STATE.RUNNING : DEVICE_STATE.OFF;
          }
        }
      }
      set((state) => ({
        g0_binding: binding,
        g0_error: binding.success ? null : binding.message || 'G0 PC1 控制接口不可用',
        revision: state.revision + 1
      }));
    },

    bind_g0_pc: async (device_id) => {
      const runtime = get().runtime;
      const device = runtime?.get_device(device_id);
      if (!device || device.model_id !== 'generic-atx-pc') {
        set({ g0_error: '只能选择前端创建的通用 PC' });
        return;
      }
      set({ g0_busy: true, g0_error: null });
      const binding = await request_g0_pc_binding(
        get().experiment_id,
        device.device_id,
        device.model_id,
        device.hostname
      );
      if (binding.success) {
        for (const candidate of runtime.list_devices()) {
          if (candidate.model_id === 'generic-atx-pc') {
            candidate.power_state = DEVICE_STATE.OFF;
          }
        }
        device.power_state =
          binding.power_state === 'RUNNING' ? DEVICE_STATE.RUNNING : DEVICE_STATE.OFF;
      }
      set((state) => ({
        g0_binding: binding,
        g0_busy: false,
        g0_error: binding.success ? null : binding.message || '绑定 simlab-g0-pc1 失败',
        selected_device_id: binding.success ? device_id : state.selected_device_id,
        selected_port: binding.success ? null : state.selected_port,
        revision: state.revision + 1
      }));
    },

    unbind_g0_pc: async () => {
      set({ g0_busy: true, g0_error: null });
      const binding = await request_g0_pc_unbind();
      const runtime = get().runtime;
      if (binding.success && runtime) {
        for (const candidate of runtime.list_devices()) {
          if (candidate.model_id === 'generic-atx-pc') {
            candidate.power_state = DEVICE_STATE.OFF;
          }
        }
      }
      set((state) => ({
        g0_binding: binding,
        g0_busy: false,
        g0_error: binding.success ? null : binding.message || '解除 G0 PC1 绑定失败',
        revision: state.revision + 1
      }));
    },

    refresh_desktop_runtimes: async () => {
      const inventory = await fetch_desktop_runtimes();
      const runtime = get().runtime;
      if (!inventory.success) {
        set({
          desktop_runtime_error: inventory.message || '桌面虚拟机资源池不可用'
        });
        return;
      }
      if (runtime) {
        for (const candidate of runtime.list_devices()) {
          if (is_runtime_model(candidate.model_id)) {
            candidate.power_state = DEVICE_STATE.OFF;
          }
        }
        for (const binding of inventory.instances) {
          if (!binding.bound_device_id) {
            continue;
          }
          const device = runtime.get_device(binding.bound_device_id);
          if (device && is_runtime_model(device.model_id)) {
            device.power_state =
              binding.power_state === 'RUNNING' ? DEVICE_STATE.RUNNING : DEVICE_STATE.OFF;
          }
        }
      }
      set((state) => ({
        desktop_runtimes: inventory.instances,
        desktop_profiles: inventory.profiles,
        vendor_image_candidates: inventory.vendor_image_candidates || [],
        vendor_image_scan_error: inventory.vendor_image_scan_error || null,
        desktop_runtime_error: null,
        revision: state.revision + 1
      }));
    },

    cancel_runtime_device_creation: () => {
      if (!get().desktop_runtime_busy) {
        set({ pending_runtime_device: null, desktop_runtime_error: null });
      }
    },

    create_device_with_existing_runtime: async (runtime_id) =>
      finish_runtime_device_creation((target) => {
        const existing = get().desktop_runtimes.find((item) => item.id === runtime_id);
        const aliases = existing?.available_nic_aliases?.length
          ? existing.available_nic_aliases : target.nic_aliases;
        return bind_desktop_runtime(runtime_id, {
          ...target,
          nic_aliases: aliases,
          port_keys: desktop_runtime_port_keys(target.model_id, aliases.length)
        });
      }),

    create_device_with_new_runtime: async (spec, count = 1, node_name) =>
      finish_runtime_device_creation(
        (target, name) => provision_desktop_runtime(target, {
          ...spec,
          vm_name: name.toLowerCase(),
          nic_aliases: desktop_port_aliases(target.model_id)
        }),
        node_name || spec.vm_name,
        count
      ),

    create_device_without_runtime: async (count = 1, node_name) =>
      finish_runtime_device_creation(null, node_name, count),

    bind_desktop_to_device: async (device_id, runtime_id) => {
      const runtime = get().runtime;
      const device = runtime?.get_device(device_id);
      if (!device || !is_runtime_model(device.model_id)) {
        set({ desktop_runtime_error: '当前设备类型不支持绑定后端虚拟机' });
        return;
      }
      set({ desktop_runtime_busy: true, desktop_runtime_error: null });
      try {
        const existing = get().desktop_runtimes.find((item) => item.id === runtime_id);
        const aliases = existing?.available_nic_aliases?.length
          ? existing.available_nic_aliases : desktop_port_aliases(device.model_id);
        await bind_desktop_runtime(runtime_id, {
          experiment_id: get().experiment_id,
          device_id: device.device_id,
          model_id: device.model_id,
          display_name: device.hostname,
          device_type: device.device_type,
          nic_aliases: aliases,
          port_keys: desktop_runtime_port_keys(device.model_id, aliases.length)
        });
      } catch (error) {
        set({
          desktop_runtime_busy: false,
          desktop_runtime_error: error instanceof Error ? error.message : '绑定后端虚拟机失败'
        });
        return;
      }
      set({ desktop_runtime_busy: false, desktop_runtime_error: null });
      await get().refresh_desktop_runtimes();
    },

    provision_desktop_for_device: async (device_id, spec) => {
      const runtime = get().runtime;
      const device = runtime?.get_device(device_id);
      if (!device || !is_runtime_model(device.model_id)) {
        set({ desktop_runtime_error: '当前设备类型不支持创建后端虚拟机' });
        return;
      }
      set({ desktop_runtime_busy: true, desktop_runtime_error: null });
      try {
        await provision_desktop_runtime(
          {
            experiment_id: get().experiment_id,
            device_id: device.device_id,
            model_id: device.model_id,
            display_name: device.hostname,
            device_type: device.device_type,
            nic_aliases: desktop_port_aliases(device.model_id),
            port_keys: desktop_runtime_port_keys(device.model_id)
          },
          { ...spec, nic_aliases: desktop_port_aliases(device.model_id) }
        );
      } catch (error) {
        set({
          desktop_runtime_busy: false,
          desktop_runtime_error: error instanceof Error ? error.message : '创建后端虚拟机失败'
        });
        return;
      }
      set({ desktop_runtime_busy: false, desktop_runtime_error: null });
      await get().refresh_desktop_runtimes();
    },

    unbind_desktop_from_device: async (device_id) => {
      const binding = get().desktop_runtimes.find(
        (item) => item.bound_device_id === device_id
      );
      if (!binding) {
        return;
      }
      set({ desktop_runtime_busy: true, desktop_runtime_error: null });
      try {
        await unbind_desktop_runtime(binding.id);
      } catch (error) {
        set({
          desktop_runtime_busy: false,
          desktop_runtime_error: error instanceof Error ? error.message : '解除虚拟机绑定失败'
        });
        return;
      }
      const device = get().runtime?.get_device(device_id);
      if (device) {
        device.power_state = DEVICE_STATE.OFF;
      }
      set({ desktop_runtime_busy: false, desktop_runtime_error: null });
      await get().refresh_desktop_runtimes();
    },

    delete_managed_desktop_runtime: async (runtime_id) => {
      set({ desktop_runtime_busy: true, desktop_runtime_error: null });
      try {
        await delete_desktop_runtime(runtime_id);
      } catch (error) {
        set({
          desktop_runtime_busy: false,
          desktop_runtime_error: error instanceof Error ? error.message : '删除后端虚拟机失败'
        });
        return;
      }
      set({ desktop_runtime_busy: false, desktop_runtime_error: null });
      await get().refresh_desktop_runtimes();
    },

    release_experiment_desktops: async (keepalive = false) => {
      if (get().current_experiment_role === 'VIEWER') return true;
      const runtime = get().runtime;
      const active_device_ids = new Set(
        runtime?.list_devices().map((device) => device.device_id) || []
      );
      const bound_device_ids = get()
        .desktop_runtimes.map((item) => item.bound_device_id)
        .filter(
          (device_id): device_id is string =>
            typeof device_id === 'string' && active_device_ids.has(device_id)
        );
      const legacy_device_id = get().g0_binding?.bound_device_id;
      const release_legacy =
        typeof legacy_device_id === 'string' &&
        active_device_ids.has(legacy_device_id) &&
        !bound_device_ids.includes(legacy_device_id);
      if (bound_device_ids.length === 0 && !release_legacy) {
        return true;
      }
      set({ desktop_runtime_busy: true, desktop_runtime_error: null });
      let next_g0_binding: G0PcBinding | null = null;
      try {
        if (bound_device_ids.length > 0) {
          await release_desktop_runtimes(get().experiment_id, bound_device_ids, keepalive);
        }
        if (release_legacy && legacy_device_id) {
          next_g0_binding = await request_g0_pc_power(legacy_device_id, false, keepalive);
          if (!next_g0_binding.success) {
            const error = new Error(
              next_g0_binding.message || '固定 G0 虚拟机关闭和解绑失败'
            );
            error.name = next_g0_binding.error_code || 'G0_RELEASE_FAILED';
            throw error;
          }
        }
      } catch (error) {
        set({
          desktop_runtime_busy: false,
          desktop_runtime_error: runtime_action_error(
            error,
            'RUNTIME_RELEASE_FAILED',
            '实验关闭时虚拟机关闭和解绑失败'
          )
        });
        return false;
      }
      for (const device_id of bound_device_ids) {
        const device = runtime?.get_device(device_id);
        if (device) {
          device.power_state = DEVICE_STATE.OFF;
        }
      }
      if (release_legacy && legacy_device_id) {
        const legacy_device = runtime?.get_device(legacy_device_id);
        if (legacy_device) {
          legacy_device.power_state = DEVICE_STATE.OFF;
        }
      }
      set((state) => ({
        desktop_runtime_busy: false,
        desktop_runtime_error: null,
        g0_binding: next_g0_binding || state.g0_binding,
        desktop_runtimes: state.desktop_runtimes.map((item) =>
          item.bound_device_id && bound_device_ids.includes(item.bound_device_id)
            ? {
                ...item,
                bound_device_id: null,
                model_id: null,
                display_name: null,
                power_state: 'STOPPED',
                novnc_url: ''
              }
            : item
        ),
        revision: state.revision + 1
      }));
      if (!keepalive) {
        await get().refresh_desktop_runtimes();
      }
      return true;
    },

    move_device: async (device_id, position) => {
      if (get().current_experiment_role === 'VIEWER') return;
      const runtime = get().runtime;
      if (!runtime) {
        return;
      }
      await runtime.move_device(device_id, position);
      set((state) => ({ revision: state.revision + 1 }));
    },

    configure_port: async (device_id, port, changes) => {
      if (get().current_experiment_role === 'VIEWER') return;
      const runtime = get().runtime;
      if (!runtime) {
        return;
      }
      const result = await runtime.configure_port(device_id, port, changes);
      if (!result.success) {
        console.warn('端口配置失败：' + result.message);
      }
      get().refresh();
    },

    inject_fault: async (device_id, port, fault_type) => {
      if (get().current_experiment_role === 'VIEWER') return;
      const runtime = get().runtime;
      if (!runtime) {
        return;
      }
      await runtime.inject_fault(device_id, port, fault_type);
      get().refresh();
    },

    save_config: async (device_id) => {
      if (get().current_experiment_role === 'VIEWER') return;
      const runtime = get().runtime;
      if (!runtime) {
        return;
      }
      await runtime.save_config(device_id);
      get().refresh();
    },

    set_view: (view) => set({ view: view }),

    set_display_mode: (mode) => set({ display_mode: mode }),

    toggle_flow: () => set((state) => ({ flow_enabled: !state.flow_enabled })),

    toggle_auto_rotate: () => set((state) => ({ auto_rotate: !state.auto_rotate })),

    new_experiment: async (name) => {
      set({ experiment_busy: true, experiment_error: null });
      if (!(await get().release_experiment_desktops())) {
        set({
          experiment_busy: false,
          experiment_error: 'EXP_RUNTIME_RELEASE_FAILED：虚拟机关闭或解绑失败，当前实验保持打开。'
        });
        return;
      }
      let server_experiment: ServerExperimentSummary;
      try {
        server_experiment = await create_server_experiment(
          (name || '').trim() || '未命名实验'
        );
      } catch (error) {
        set({
          experiment_busy: false,
          experiment_error: runtime_action_error(
            error,
            'EXP_CREATE_FAILED',
            '无法在服务器创建实验'
          )
        });
        return;
      }
      const experiment_id = server_experiment.experiment_id;
      const runtime = new LocalRuntime({
        bus: bus,
        experiment_id: experiment_id,
        device_id_namespace: experiment_id
      });
      await runtime.connect();
      get().runtime?.dispose();
      set({
        runtime: runtime,
        runtime_mode: 'local',
        api_base: null,
        connected: false,
        experiment_id: experiment_id,
        experiment_name: server_experiment.name,
        current_experiment_role: server_experiment.role,
        saved_experiments: [
          server_experiment,
          ...get().saved_experiments.filter(
            (item) => item.experiment_id !== server_experiment.experiment_id
          )
        ],
        device_ids: [],
        cables: [],
        cloud_uplinks: {},
        selected_device_id: null,
        selected_port: null,
        link_source: null,
        events: [],
        wireless: null,
        wireless_associations: {},
        ap_radio_configs: {},
        optical: null,
        cable_labels: {},
        cable_waypoints: {},
        last_saved_at: null,
        experiment_busy: false,
        experiment_manager_open: false,
        revision: get().revision + 1
      });
      await get().refresh_desktop_runtimes();
    },

    save_experiment: async (name) => {
      const state = get();
      if (state.current_experiment_role === 'VIEWER') {
        set({ experiment_error: 'PERMISSION_DENIED：当前账户只有查看权限，请联系实验所有者授予编辑权限。' });
        return;
      }
      const runtime = state.runtime;
      if (!runtime) {
        set({ experiment_error: 'EXP_RUNTIME_MISSING：运行时尚未初始化，请稍后重试。' });
        return;
      }
      const experiment_name = (name || state.experiment_name).trim();
      if (!experiment_name) {
        set({ experiment_error: 'EXP_NAME_REQUIRED：请输入实验名称。' });
        return;
      }
      set({ experiment_busy: true, experiment_error: null });
      try {
        const now = new Date().toISOString();
        const summary = state.saved_experiments.find(
          (item) => item.experiment_id === state.experiment_id
        );
        if (!summary) {
          throw new Error('服务器实验记录不存在，请刷新实验库后重试');
        }
        const document: SavedExperiment = {
          schema_version: '1.0',
          experiment_id: state.experiment_id,
          name: experiment_name,
          created_at: summary.created_at,
          updated_at: now,
          devices: runtime.list_devices().map((device) => ({
            device_id: device.device_id,
            model_id: device.model_id,
            device_type: get_template(device.model_id)?.device_type || device.manifest.device_class,
            hostname: device.hostname,
            position: { ...device.position },
            power_on: device.power_state !== DEVICE_STATE.OFF,
            ...(device.model_id === 'generic-cloud-bridge'
              ? { cloud_uplink: state.cloud_uplinks[device.device_id] || '' } : {}),
            ...(state.ap_radio_configs[device.device_id]
              ? { ap_radio: { ...state.ap_radio_configs[device.device_id] } } : {}),
            ports: device.ports.map((port) => ({
              short_name: port.short_name,
              admin_up: port.admin_up,
              vlan: port.vlan,
              speed_mode: port.speed_mode,
              duplex: port.duplex,
              poe_enabled: port.poe_enabled,
              description: port.description
            }))
          })),
          cables: runtime.cables_snapshot().map((cable) => ({
            ...cable,
            source: { ...cable.source },
            target: cable.target ? { ...cable.target } : null
          })),
          wireless_associations: Object.entries(state.wireless_associations).map(
            ([sta_device_id, ap_device_id]) => ({ sta_device_id, ap_device_id })
          ),
          cable_labels: structuredClone(state.cable_labels),
          cable_waypoints: structuredClone(state.cable_waypoints),
          scene: {
            view: state.view,
            display_mode: state.display_mode,
            flow_enabled: state.flow_enabled,
            auto_rotate: state.auto_rotate,
            render: { ...state.render_settings }
          }
        };
        const updated = await save_server_experiment(document, summary.config_revision);
        const saved_experiments = (await list_server_experiments()).map((item) =>
          item.experiment_id === updated.experiment_id ? updated : item
        );
        set({
          experiment_name: experiment_name,
          current_experiment_role: updated.role,
          last_saved_at: updated.updated_at,
          saved_experiments: saved_experiments,
          experiment_busy: false
        });
        if (get().desktop_runtimes.some((item) => item.bound_device_id)) {
          await get().refresh_desktop_runtimes();
        }
      } catch (error) {
        const code =
          error && typeof error === 'object' && 'code' in error
            ? String((error as { code: unknown }).code)
            : 'EXP_SAVE_FAILED';
        set({
          experiment_busy: false,
          experiment_error:
            code + '：' + (error instanceof Error ? error.message : '实验保存失败，请重试。')
        });
      }
    },

    load_experiment: async (experiment_id) => {
      set({ experiment_busy: true, experiment_error: null });
      let replacement_runtime: LocalRuntime | null = null;
      try {
        const document = await load_server_experiment(experiment_id);
        if (get().experiment_id !== experiment_id &&
            !(await get().release_experiment_desktops())) {
          set({
            experiment_busy: false,
            experiment_error: 'EXP_RUNTIME_RELEASE_FAILED：虚拟机关闭或解绑失败，当前实验保持打开。'
          });
          return;
        }
        const runtime = new LocalRuntime({
          bus: bus,
          experiment_id: document.experiment_id,
          device_id_namespace: document.experiment_id
        });
        replacement_runtime = runtime;
        await runtime.connect();
        for (const saved_device of document.devices) {
          const created = await runtime.create_device(
            saved_device.model_id,
            saved_device.hostname,
            saved_device.device_id
          );
          if (!created.success) {
            throw new Error(created.message || '无法恢复设备 ' + saved_device.device_id);
          }
          const moved = await runtime.move_device(saved_device.device_id, saved_device.position);
          if (!moved.success) {
            throw new Error(moved.message || '无法恢复设备位置 ' + saved_device.device_id);
          }
          for (const port of saved_device.ports) {
            if (is_runtime_model(saved_device.model_id) &&
                !runtime.get_device(saved_device.device_id)?.find_port(port.short_name)) {
              /* 旧 Manifest 曾叠加出无实体插座的端口；恢复时丢弃该幽灵端口配置。 */
              continue;
            }
            const configured = await runtime.configure_port(saved_device.device_id, port.short_name, {
              admin_up: port.admin_up,
              vlan: port.vlan,
              speed: port.speed_mode,
              duplex: port.duplex,
              poe_enabled: port.poe_enabled,
              description: port.description
            });
            if (!configured.success) {
              throw new Error(configured.message || '无法恢复端口 ' + port.short_name);
            }
          }
        }
        for (const cable of document.cables) {
          const connected = await runtime.connect_cable(
            cable.source,
            cable.target || undefined,
            cable.cable_type,
            cable.cable_id
          );
          if (!connected.success) {
            throw new Error(connected.message || '无法恢复线缆 ' + cable.cable_id);
          }
        }
        for (const saved_device of document.devices) {
          if (saved_device.ap_radio) {
            const configured = await runtime.configure_ap(
              saved_device.device_id, saved_device.ap_radio
            );
            if (!configured.success) {
              throw new Error(configured.message || '无法恢复 AP 射频配置');
            }
          }
        }
        for (const saved_device of document.devices) {
          if (saved_device.power_on && !is_runtime_model(saved_device.model_id)) {
            await runtime.power(saved_device.device_id, true);
          }
        }
        get().runtime?.dispose();
        set({
          runtime: runtime,
          runtime_mode: 'local',
          api_base: null,
          connected: false,
          experiment_id: document.experiment_id,
          experiment_name: document.name,
          current_experiment_role:
            get().saved_experiments.find((item) => item.experiment_id === experiment_id)?.role ||
            'VIEWER',
          device_ids: runtime.list_devices().map((device) => device.device_id),
          cables: runtime.cables_snapshot(),
          cloud_uplinks: Object.fromEntries(
            document.devices.filter((item) => item.model_id === 'generic-cloud-bridge')
              .map((item) => [item.device_id, item.cloud_uplink || ''])
          ),
          selected_device_id: null,
          selected_port: null,
          link_source: null,
          events: [],
          cable_labels: structuredClone(document.cable_labels || {}),
          wireless_associations: Object.fromEntries(
            (document.wireless_associations || []).map(
              (link) => [link.sta_device_id, link.ap_device_id]
            )
          ),
          ap_radio_configs: Object.fromEntries(
            document.devices.filter((item) => item.ap_radio)
              .map((item) => [item.device_id, item.ap_radio!])
          ),
          cable_waypoints: structuredClone(document.cable_waypoints || {}),
          view: document.scene.view,
          display_mode: document.scene.display_mode,
          flow_enabled: document.scene.flow_enabled,
          auto_rotate: document.scene.auto_rotate,
          render_settings: normalize_render_settings(document.scene.render),
          last_saved_at: document.updated_at,
          experiment_busy: false,
          experiment_manager_open: false,
          revision: get().revision + 1
        });
        replacement_runtime = null;
        await get().refresh_desktop_runtimes();
        for (const [client_id, ap_id] of Object.entries(get().wireless_associations)) {
          if (runtime.get_device(client_id)?.power_state === DEVICE_STATE.RUNNING &&
              runtime.get_device(ap_id)?.power_state === DEVICE_STATE.RUNNING) {
            await runtime.associate(client_id, ap_id);
          }
        }
        await get().refresh_wireless();
        await get().refresh_optical();
      } catch (error) {
        replacement_runtime?.dispose();
        const code =
          error && typeof error === 'object' && 'code' in error
            ? String((error as { code: unknown }).code)
            : 'EXP_LOAD_FAILED';
        set({
          experiment_busy: false,
          experiment_error:
            code + '：' + (error instanceof Error ? error.message : '实验载入失败，请重试。')
        });
      }
    },

    delete_saved_experiment: async (experiment_id) => {
      if (experiment_id === get().experiment_id) {
        set({ experiment_error: 'EXP_DELETE_ACTIVE：请先载入或新建其他实验，再删除当前实验。' });
        return;
      }
      set({ experiment_busy: true, experiment_error: null });
      try {
        await delete_server_experiment(experiment_id);
        set({
          saved_experiments: await list_server_experiments(),
          experiment_busy: false,
          experiment_error: null
        });
      } catch (error) {
        set({
          experiment_busy: false,
          experiment_error:
            'EXP_DELETE_FAILED：' +
            (error instanceof Error ? error.message : '无法删除已保存实验。')
        });
      }
    },

    refresh_experiment_library: async () => {
      try {
        set({ saved_experiments: await list_server_experiments(), experiment_error: null });
      } catch (error) {
        set({
          experiment_error:
            'EXP_LIST_FAILED：' + (error instanceof Error ? error.message : '无法读取实验库。')
        });
      }
    },

    set_experiment_manager_open: (open) => {
      set({ experiment_manager_open: open, experiment_error: null });
      if (open) {
        void get().refresh_experiment_library();
      }
    },

    update_render_settings: (changes) =>
      set((state) => ({ render_settings: normalize_render_settings({ ...state.render_settings, ...changes }) })),

    set_visual_settings_open: (open) => set({ visual_settings_open: open }),

    ping: async (source_device_id, target) => {
      const runtime = get().runtime;
      if (!runtime) {
        return;
      }
      const result = await runtime.ping(source_device_id, target, 4);
      set({ ping_result: result });
    },

    refresh_wireless: async () => {
      const runtime = get().runtime;
      if (!runtime) {
        return;
      }
      const snapshot = await runtime.wireless_snapshot();
      if (snapshot && snapshot.success !== false) {
        set({ wireless: snapshot });
      }
    },

    associate: async (sta_device_id, ap_device_id) => {
      if (get().current_experiment_role === 'VIEWER') {
        set({ experiment_error: 'PERMISSION_DENIED：当前账户只有查看权限，请联系实验所有者。' });
        return;
      }
      const runtime = get().runtime;
      if (!runtime) {
        return;
      }
      const binding = get().desktop_runtimes.find(
        (item) => item.bound_device_id === sta_device_id
      );
      if (binding && !binding.port_bindings?.some(
        (port) => port.frontend_port_key === 'RADIO0' && port.runtime_alias === 'eth1'
      )) {
        set({ experiment_error:
          'WIRELESS_NIC_MISSING：此笔记本没有独立射频虚拟网卡 eth1；请绑定双网卡实例。' });
        return;
      }
      const previous_ap_id = get().wireless_associations[sta_device_id];
      const result = await runtime.associate(sta_device_id, ap_device_id);
      if (!result.success) {
        set({ experiment_error: `${result.error_code || 'WIRELESS_ASSOC_FAILED'}：${result.message ||
          '关联失败，请确认笔记本和 AP 已开机且位于覆盖范围内。'}` });
      } else {
        const association = (await runtime.wireless_snapshot()).associations.find(
          (item) => item.sta_device_id === sta_device_id
        );
        if (association) {
          set((state) => ({ wireless_associations: {
            ...state.wireless_associations,
            [sta_device_id]: association.ap_device_id
          } }));
          await get().save_experiment();
          if (get().experiment_error) {
            if (previous_ap_id) {
              await runtime.associate(sta_device_id, previous_ap_id);
            } else {
              await runtime.disassociate(sta_device_id);
            }
            set((state) => {
              const wireless_associations = { ...state.wireless_associations };
              if (previous_ap_id) wireless_associations[sta_device_id] = previous_ap_id;
              else delete wireless_associations[sta_device_id];
              return { wireless_associations };
            });
          }
        }
      }
      await get().refresh_wireless();
    },

    disassociate: async (sta_device_id) => {
      if (get().current_experiment_role === 'VIEWER') {
        set({ experiment_error: 'PERMISSION_DENIED：当前账户只有查看权限，请联系实验所有者。' });
        return;
      }
      const runtime = get().runtime;
      if (!runtime) {
        return;
      }
      const previous_ap_id = get().wireless_associations[sta_device_id];
      await runtime.disassociate(sta_device_id);
      set((state) => {
        const wireless_associations = { ...state.wireless_associations };
        delete wireless_associations[sta_device_id];
        return { wireless_associations };
      });
      await get().save_experiment();
      if (get().experiment_error && previous_ap_id) {
        await runtime.associate(sta_device_id, previous_ap_id);
        set((state) => ({ wireless_associations: {
          ...state.wireless_associations,
          [sta_device_id]: previous_ap_id
        } }));
      }
      await get().refresh_wireless();
    },

    configure_ap_radio: async (device_id, settings) => {
      if (get().current_experiment_role === 'VIEWER') {
        set({ experiment_error: 'PERMISSION_DENIED：当前账户只有查看权限，请联系实验所有者。' });
        return;
      }
      const runtime = get().runtime;
      if (!(runtime instanceof LocalRuntime)) {
        set({ experiment_error: 'AP_RADIO_UNAVAILABLE：无线模型未就绪，请刷新实验后重试。' });
        return;
      }
      const before_snapshot = await runtime.wireless_snapshot();
      const previous = before_snapshot.aps.find(
        (item) => item.device_id === device_id
      );
      const previous_configs = get().ap_radio_configs;
      const previous_associations = get().wireless_associations;
      const result = await runtime.configure_ap(device_id, settings);
      if (!result.success) {
        set({ experiment_error: `${result.error_code || 'AP_RADIO_INVALID'}：${result.message}` });
        return;
      }
      const still_associated = new Set(
        (await runtime.wireless_snapshot()).associations.map((item) => item.sta_device_id)
      );
      set((state) => ({
        ap_radio_configs: {
          ...state.ap_radio_configs, [device_id]: { ...settings, ssid: settings.ssid.trim() }
        },
        wireless_associations: Object.fromEntries(
          Object.entries(state.wireless_associations).filter(
            ([client_id, ap_id]) => ap_id !== device_id || still_associated.has(client_id)
          )
        )
      }));
      await get().refresh_wireless();
      await get().save_experiment();
      if (get().experiment_error && previous) {
        await runtime.configure_ap(device_id, previous);
        for (const association of before_snapshot.associations) {
          if (association.ap_device_id === device_id) {
            await runtime.associate(association.sta_device_id, device_id);
          }
        }
        set({ ap_radio_configs: previous_configs,
          wireless_associations: previous_associations });
        await get().refresh_wireless();
      }
    },

    refresh_optical: async () => {
      const runtime = get().runtime;
      if (!runtime) {
        return;
      }
      const snapshot = await runtime.optical_snapshot();
      if (snapshot) {
        set({ optical: snapshot });
      }
    },

    set_optical_fiber: async (onu_device_id, options) => {
      const runtime = get().runtime;
      if (!runtime) {
        return;
      }
      const result = await runtime.set_optical_fiber(onu_device_id, options);
      if (!result.success) {
        console.warn('光链路参数设置失败：' + result.message);
      }
      await get().refresh_optical();
    },

    set_optical_traffic: async (onu_device_id, traffic) => {
      const runtime = get().runtime;
      if (!runtime) {
        return;
      }
      const result = await runtime.set_optical_traffic(onu_device_id, traffic);
      if (!result.success) {
        console.warn('光链路业务负载设置失败：' + result.message);
      }
      await get().refresh_optical();
    },

    open_workshop: async (model_id) => {
      await ensure_templates_loaded();
      const source = model_id ? get_template(model_id) : null;
      const template = source
        ? clone_template(source.model_id, source.model_id, source.display_name) ||
          JSON.parse(JSON.stringify(source))
        : {
            model_id: 'user-device-' + Date.now().toString(36),
            vendor_id: 'custom',
            display_name: '自定义设备',
            device_type: 'switch',
            dimensions: { width: 0.442, height: 0.0436, depth: 0.22, u_height: 1 },
            rack_mountable: true,
            parts: [
              {
                part_id: 'chassis',
                kind: 'rack_chassis',
                category: 'chassis',
                label: '机箱',
                params: { width: 0.442, height: 0.0436, depth: 0.22 }
              },
              {
                part_id: 'panel',
                kind: 'front_panel',
                category: 'front_panel',
                label: '前面板',
                params: { width: 0.442, height: 0.0436, brand_line: 'CUSTOM DEVICE' },
                transform: { position: [0, 0, 0.1105] }
              },
              {
                part_id: 'ports',
                kind: 'port_row',
                category: 'port_module',
                label: '端口行',
                params: {
                  connector: 'rj45',
                  rows: 2,
                  columns: 12,
                  origin: [0.012, 0, 0.1105],
                  name_prefix: 'GE0/0/'
                }
              }
            ],
            ports: [],
            leds: [],
            version: 1,
            origin: 'user',
            description: '在设备工坊中组装'
          };
      /* 编辑用户模板时保留其身份：不改变 model_id。 */
      const draft: DeviceTemplate = {
        ...template,
        origin: source && source.origin === 'user' ? 'user' : 'user'
      };
      set({
        workshop_open: true,
        workshop_template: draft,
        workshop_part_id: draft.parts.length > 0 ? draft.parts[0].part_id : null,
        workshop_explode: 0
      });
    },

    close_workshop: () => {
      set({ workshop_open: false, workshop_template: null, workshop_part_id: null });
    },

    select_workshop_part: (part_id) => {
      set({ workshop_part_id: part_id });
    },

    update_workshop_part: (part_id, params) => {
      const template = get().workshop_template;
      if (!template) {
        return;
      }
      const parts: PartSpec[] = template.parts.map((part) =>
        part.part_id === part_id ? { ...part, params: { ...part.params, ...params } } : part
      );
      set({ workshop_template: { ...template, parts: parts } });
    },

    add_workshop_part: (kind) => {
      const template = get().workshop_template;
      if (!template) {
        return;
      }
      const part_id = kind + '_' + (template.parts.length + 1);
      const definition = get_part_definition(kind);
      const params = definition ? structuredClone(definition.defaults) : {};
      const candidate: PartSpec = {
        part_id: part_id,
        kind: kind,
        category: definition?.category || 'accessory',
        label: definition?.label || kind,
        params: params
      };
      if (is_ethernet_port_module(candidate)) {
        params.short_name = next_ethernet_module_name(template.parts);
      }
      const next: PartSpec = {
        part_id: part_id,
        kind: kind,
        category: definition?.category || 'accessory',
        label: definition?.label || kind,
        params: params
      };
      set({
        workshop_template: { ...template, parts: [...template.parts, next] },
        workshop_part_id: part_id
      });
    },

    remove_workshop_part: (part_id) => {
      const template = get().workshop_template;
      if (!template) {
        return;
      }
      const parts = template.parts.filter((part) => part.part_id !== part_id);
      set({
        workshop_template: { ...template, parts: parts },
        workshop_part_id: parts.length > 0 ? parts[0].part_id : null
      });
    },

    move_workshop_part: (part_id, delta) => {
      const template = get().workshop_template;
      if (!template) {
        return;
      }
      const parts = [...template.parts];
      const index = parts.findIndex((part) => part.part_id === part_id);
      const target = index + delta;
      if (index < 0 || target < 0 || target >= parts.length) {
        return;
      }
      const [item] = parts.splice(index, 1);
      parts.splice(target, 0, item);
      set({ workshop_template: { ...template, parts: parts } });
    },

    update_workshop_meta: (patch) => {
      const template = get().workshop_template;
      if (!template) {
        return;
      }
      set({ workshop_template: { ...template, ...patch } });
    },

    set_workshop_explode: (amount) => {
      set({ workshop_explode: amount });
    },

    set_workshop_gizmo: (mode) => {
      set({ workshop_gizmo: mode });
    },

    set_workshop_snap: (millimeters) => {
      set({ workshop_snap_mm: Math.max(0, millimeters) });
    },

    set_workshop_display: (mode) => {
      set({ workshop_display: mode });
    },

    set_workshop_grid: (visible) => {
      set({ workshop_grid: visible });
    },

    update_workshop_transform: (part_id, transform) => {
      const template = get().workshop_template;
      if (!template) {
        return;
      }
      const parts = template.parts.map((part) =>
        part.part_id === part_id
          ? {
              ...part,
              transform: {
                position: transform.position,
                rotation: transform.rotation,
                scale: transform.scale
              }
            }
          : part
      );
      /* 一次拖拽只入栈一次（拖拽过程中不调用本动作）。 */
      set({
        workshop_history: [...get().workshop_history, template].slice(-HISTORY_LIMIT),
        workshop_future: [],
        workshop_template: { ...template, parts: parts }
      });
    },

    reset_workshop_transform: (part_id) => {
      const template = get().workshop_template;
      if (!template) {
        return;
      }
      const parts = template.parts.map((part) =>
        part.part_id === part_id ? { ...part, transform: undefined } : part
      );
      set({
        workshop_history: [...get().workshop_history, template].slice(-HISTORY_LIMIT),
        workshop_future: [],
        workshop_template: { ...template, parts: parts }
      });
    },

    duplicate_workshop_part: (part_id) => {
      const template = get().workshop_template;
      if (!template) {
        return;
      }
      const source = template.parts.find((part) => part.part_id === part_id);
      if (!source) {
        return;
      }
      const used = new Set(template.parts.map((part) => part.part_id));
      let index = 2;
      let next_id = source.part_id + '_copy' + index;
      while (used.has(next_id)) {
        index += 1;
        next_id = source.part_id + '_copy' + index;
      }
      const source_transform = source.transform || {};
      const offset = source_transform.position || [0, 0, 0];
      const clone_params = { ...source.params };
      if (is_ethernet_port_module(source)) {
        clone_params.short_name = next_ethernet_module_name(template.parts);
      }
      const clone = {
        ...source,
        part_id: next_id,
        params: clone_params,
        transform: {
          position: [offset[0] + 0.02, offset[1], offset[2]] as [number, number, number],
          rotation: source_transform.rotation || ([0, 0, 0] as [number, number, number]),
          scale: source_transform.scale || ([1, 1, 1] as [number, number, number])
        }
      };
      set({
        workshop_history: [...get().workshop_history, template].slice(-HISTORY_LIMIT),
        workshop_future: [],
        workshop_template: { ...template, parts: [...template.parts, clone] },
        workshop_part_id: next_id
      });
    },

    undo_workshop: () => {
      const history = get().workshop_history;
      const template = get().workshop_template;
      if (history.length === 0 || !template) {
        return;
      }
      const previous = history[history.length - 1];
      set({
        workshop_history: history.slice(0, -1),
        workshop_future: [...get().workshop_future, template].slice(-HISTORY_LIMIT),
        workshop_template: previous,
        workshop_part_id: resolve_part_id(previous, get().workshop_part_id)
      });
    },

    redo_workshop: () => {
      const future = get().workshop_future;
      const template = get().workshop_template;
      if (future.length === 0 || !template) {
        return;
      }
      const next = future[future.length - 1];
      set({
        workshop_future: future.slice(0, -1),
        workshop_history: [...get().workshop_history, template].slice(-HISTORY_LIMIT),
        workshop_template: next,
        workshop_part_id: resolve_part_id(next, get().workshop_part_id)
      });
    },

    save_workshop: () => {
      const template = get().workshop_template;
      if (!template) {
        return null;
      }
      const saved = save_user_template(template);
      /* 模板已变更：清空缩略图缓存、提高版本号，主场景据此重建几何。 */
      clear_thumbnail_cache();
      ensure_templates_loaded();
      set({
        workshop_template: saved,
        template_revision: get().template_revision + 1,
        revision: get().revision + 1
      });

      return saved;
    },

    delete_template: (model_id) => {
      delete_user_template(model_id);
      clear_thumbnail_cache();
      set({
        template_revision: get().template_revision + 1,
        revision: get().revision + 1
      });
    },

    template_list: () => list_templates(),

    open_context_menu: (menu) => {
      set({ context_menu: menu });
    },

    close_context_menu: () => {
      set({ context_menu: null });
    },

    open_label_editor: (cable_id, side, text, x, y) => {
      set({ label_editor: { cable_id: cable_id, side: side, text: text, x: x, y: y } });
    },

    close_label_editor: () => {
      set({ label_editor: null });
    },

    save_label_text: (cable_id, side, text) => {
      const current = get().cable_labels[cable_id] || { from: '', to: '' };
      const next = { from: current.from, to: current.to };
      next[side] = text.trim();
      set({
        cable_labels: { ...get().cable_labels, [cable_id]: next },
        label_editor: null
      });
    },

    set_cable_waypoints: (cable_id, points) => {
      set({ cable_waypoints: { ...get().cable_waypoints, [cable_id]: points } });
    },

    open_console: (device_id) => {
      set((state) => ({ console_device_id: device_id, console_request_seq: state.console_request_seq + 1 }));
    },

    request_snapshot: (device_id) => {
      const runtime = get().runtime;
      /* 后端虚拟化接口尚未接入：这里给出契约化提示，接口就绪后替换为真实调用。 */
      console.info(
        '[snapshot] 冷快照请求已排队（预留接口 POST /api/v1/devices/' + device_id + '/snapshots/）'
      );
      if (runtime) {
        get().refresh();
      }
    },

    set_pending_cable_kind: (cable_kind) => {
      set({ pending_cable_kind: cable_kind });
    },

    create_device_at: async (model_id, x, z) => {
      if (get().current_experiment_role === 'VIEWER') return null;
      if (is_runtime_model(model_id)) {
        set({
          pending_runtime_device: {
            model_id: model_id,
            position: { x: x, y: 0, z: z }
          },
          desktop_runtime_error: null
        });
        return null;
      }
      const device_id = await get().create_device(model_id);
      if (device_id) {
        await get().move_device(device_id, { x: x, y: 0, z: z });
        /* 拖入后立即高亮并打开检视信息，明确反馈设备已经落入实验场景。 */
        set({ selected_device_id: device_id, selected_port: null });
      }

      return device_id;
    },

    begin_cable_from_kind: async (cable_kind, x, z) => {
      if (get().current_experiment_role === 'VIEWER') return;
      const runtime = get().runtime;
      if (!runtime) {
        return;
      }
      /* 选取离落点最近的空闲端口作为起点，随后由用户点击目标端口完成连接。 */
      const devices = runtime.list_devices();
      let best: { device_id: string; port: string; distance: number; connector: string } | null =
        null;
      for (const device of devices) {
        for (const port of device.ports) {
          if (port.plugged) {
            continue;
          }
          const distance = Math.hypot(device.position.x - x, device.position.z - z);
          if (!best || distance < best.distance) {
            best = {
              device_id: device.device_id,
              port: port.short_name,
              distance: distance,
              connector: port.kind
            };
          }
        }
      }
      if (!best) {
        console.warn('附近没有可用端口可接线');
        return;
      }
      set({ pending_cable_kind: cable_kind });
      get().start_link({ device_id: best.device_id, port: best.port });
    },

    rename_device: async (device_id, hostname) => {
      if (get().current_experiment_role === 'VIEWER') return;
      const runtime = get().runtime;
      if (!runtime || !hostname) {
        return;
      }
      await runtime.rename_device(device_id, hostname);
      get().refresh();
    },

    duplicate_device: async (device_id) => {
      const runtime = get().runtime;
      if (!runtime) {
        return;
      }
      const source = runtime.get_device(device_id);
      if (!source) {
        return;
      }
      const created = await get().create_device(source.model_id);
      if (created) {
        /* 放在原设备旁边，避免完全重叠。 */
        await get().move_device(created, {
          x: source.position.x + 12,
          y: source.position.y,
          z: source.position.z + 8
        });
      }
    },

    push_event: (event) => {
      if (event.event_type === EVENT_TYPE.DEVICE_STATE_CHANGED &&
          event.data?.to === DEVICE_STATE.RUNNING) {
        const runtime = get().runtime;
        if (runtime && event.experiment_id === get().experiment_id) {
          for (const [client_id, ap_id] of Object.entries(get().wireless_associations)) {
            if (event.device_id !== client_id && event.device_id !== ap_id) continue;
            if (runtime.get_device(client_id)?.power_state === DEVICE_STATE.RUNNING &&
                runtime.get_device(ap_id)?.power_state === DEVICE_STATE.RUNNING) {
              void runtime.associate(client_id, ap_id).then(() => get().refresh_wireless());
            }
          }
          const device = runtime.get_device(event.device_id);
          if (device?.device_type === 'ap' &&
              get().desktop_runtimes.some((item) =>
                item.bound_device_id &&
                get().wireless_associations[item.bound_device_id] === event.device_id)) {
            void get().save_experiment();
          }
        }
      }
      if (event.event_type === EVENT_TYPE.WIRELESS_ASSOC_CHANGED &&
          event.data?.reason === 'OUT_OF_RANGE' &&
          event.experiment_id === get().experiment_id &&
          event.device_id && get().wireless_associations[event.device_id]) {
        const affected_id = event.device_id;
        set((state) => {
          const wireless_associations = { ...state.wireless_associations };
          delete wireless_associations[affected_id];
          return { wireless_associations };
        });
        if (get().desktop_runtimes.some((item) => item.bound_device_id === affected_id)) {
          void get().save_experiment();
        }
      }
      set((state) => {
        /* 无线关联变化（含关机导致的断开）立即回读快照，避免最多 3 秒的界面滞后。 */
        if (
          event.event_type === EVENT_TYPE.WIRELESS_ASSOC_CHANGED ||
          event.event_type === EVENT_TYPE.WIRELESS_METRICS_UPDATED
        ) {
          void get().refresh_wireless();
        }
        const events = state.events.concat([event]);
        const ping_result =
          event.event_type === EVENT_TYPE.PING_COMPLETED
            ? (event.data as unknown as PingResult)
            : state.ping_result;
        return {
          events: events.length > MAX_EVENTS ? events.slice(events.length - MAX_EVENTS) : events,
          ping_result: ping_result,
          revision: state.revision + 1
        };
      });
    }
  };
});

/**
 * 生成事件日志文本。
 *
 * @param {SimlabEvent} event 事件。
 * @returns {string} 文本。
 */
export function describe_event(event: SimlabEvent): string {
  const data = event.data || {};
  switch (event.event_type) {
    case EVENT_TYPE.DEVICE_CREATED:
      return `创建设备 ${data.model_id}`;
    case EVENT_TYPE.DEVICE_STATE_CHANGED:
      return `设备状态 ${data.from || '-'} → ${data.to}`;
    case EVENT_TYPE.PORT_LINK_CHANGED:
      return `端口 ${data.port} 链路 ${data.from} → ${data.to}`;
    case EVENT_TYPE.PORT_CONFIG_CHANGED:
      return data.changes
        ? `端口 ${data.port} 配置更新 ${JSON.stringify(data.changes)}`
        : `端口配置更新`;
    case EVENT_TYPE.CABLE_CONNECTED:
      return `线缆接入 ${data.port || ''}${data.target_device_id ? ' → ' + data.target_device_id : ''}`;
    case EVENT_TYPE.CABLE_DISCONNECTED:
      return `线缆拔出 ${data.port || ''}`;
    case EVENT_TYPE.PACKET_FORWARDED:
      return `数据包转发 ${data.in_port || '-'} → ${data.out_port || '-'}（VLAN ${data.vlan}）`;
    case EVENT_TYPE.PING_COMPLETED:
      return `Ping 完成：${data.reachable ? '可达' : '不可达'}，路径 ${(data.path || []).join(' → ')}`;
    case EVENT_TYPE.WIRELESS_ASSOC_CHANGED: {
      const peer = data.ap_device_id ? '已连接 ' + data.ap_device_id : '已断开';
      return `链路 ${peer}`;
    }
    case EVENT_TYPE.WIRELESS_METRICS_UPDATED:
      return `无线速率 ${data.phy_rate_mbps} Mbps / 吞吐 ${data.throughput_mbps} Mbps`;
    case EVENT_TYPE.FAULT_INJECTED:
      return `注入故障 ${data.fault_type}`;
    case EVENT_TYPE.CONFIG_SAVED:
      return '配置已保存';
    case EVENT_TYPE.LOG_APPENDED:
      return String(data.text || '');
    default:
      return event.event_type;
  }
}

/**
 * 事件时间文本。
 *
 * @param {SimlabEvent} event 事件。
 * @returns {string} HH:MM:SS。
 */
export function event_time(event: SimlabEvent): string {
  return utils.format_datetime(new Date(event.timestamp)).slice(11);
}
