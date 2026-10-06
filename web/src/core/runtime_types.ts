/**
 * @File : web/src/core/runtime_types.ts
 * @Time : 2026-10-05 05:35
 * @Author : Cetrp
 * @Description : 运行时适配器接口与共享类型：本地模拟运行时与远端（Django + DRF）运行时实现同一契约
 * 。
 */

import type { DeviceRuntime } from './device_runtime';

import type {
  CableRecord,
  CommandResult,
  DeviceSnapshot,
  PingResult,
  SimlabEvent,
  WirelessSnapshot
} from '../data/types';
import type { OpticalSnapshot } from './optical_model';

export type {
  CableRecord,
  CommandResult,
  DeviceSnapshot,
  PingResult,
  SimlabEvent,
  WirelessSnapshot,
  OpticalSnapshot
};

/** 端口引用。 */
export interface PortRef {
  device_id: string;
  port: string;
}

/** 控制台会话信息。 */
export interface ConsoleSessionInfo {
  success: boolean;
  session_id?: string;
  prompt?: string;
  mode?: string;
  message?: string;
}

/** 控制台回显。 */
export interface ConsoleOutput {
  success: boolean;
  lines: string[];
  prompt: string;
  mode: string;
  message?: string;
}

/**
 * 运行时适配器接口：多设备、设备间互连、转发仿真、无线与控制台。
 */
export interface RuntimeClient {
  /** 运行时类型。 */
  type(): 'local' | 'remote';

  /** 建立连接（本地直接成功，远端探测后端）。 */
  connect(): Promise<boolean>;

  /** 设备列表。 */
  list_devices(): DeviceRuntime[];

  /** 查询设备。 */
  get_device(device_id: string): DeviceRuntime | null;

  /** 设备快照（拓扑渲染用）。 */
  devices_snapshot(): DeviceSnapshot[];

  /** 线缆快照。 */
  cables_snapshot(): CableRecord[];

  /** 创建设备。 */
  create_device(model_id: string, hostname?: string, preferred_device_id?: string, port_names?: string[]): Promise<CommandResult>;

  /** 删除设备。 */
  delete_device(device_id: string): Promise<CommandResult>;

  /** 开关机。 */
  power(device_id: string, is_on: boolean): Promise<CommandResult>;

  /** 移动设备。 */
  move_device(
    device_id: string,
    position: { x: number; y: number; z: number }
  ): Promise<CommandResult>;

  /** 连线（target 省略表示接模拟对端）。 */
  connect_cable(
    source: PortRef,
    target?: PortRef,
    cable_type?: string,
    preferred_cable_id?: string
  ): Promise<CommandResult>;

  /** 拔线。 */
  disconnect_cable(cable_id: string): Promise<CommandResult>;

  /** 端口配置。 */
  configure_port(
    device_id: string,
    port: string,
    changes: Record<string, unknown>
  ): Promise<CommandResult>;

  /** 故障注入。 */
  inject_fault(device_id: string, port: string | null, fault_type: string): Promise<CommandResult>;

  /** 保存配置。 */
  save_config(device_id: string): Promise<CommandResult>;

  /** 打开控制台。 */
  console_open(device_id: string): Promise<ConsoleSessionInfo>;

  /** 控制台输入。 */
  console_write(session_id: string, input: string): Promise<ConsoleOutput>;

  /** 控制台补全。 */
  console_complete(session_id: string, input: string): Promise<string[]>;

  /** 关闭控制台。 */
  console_close(session_id: string): Promise<CommandResult>;

  /** 端到端连通性测试。 */
  ping(
    source_device_id: string,
    target: { device_id?: string; ip?: string },
    count?: number
  ): Promise<PingResult>;

  /** 无线状态快照。 */
  wireless_snapshot(): Promise<WirelessSnapshot>;

  /** 关联 AP。 */
  associate(sta_device_id: string, ap_device_id?: string): Promise<CommandResult>;

  /** 解除关联。 */
  disassociate(sta_device_id: string): Promise<CommandResult>;

  /** 重命名设备（主机名）。 */
  rename_device(device_id: string, hostname: string): Promise<CommandResult>;

  /** 光链路状态快照。 */
  optical_snapshot(): Promise<OpticalSnapshot>;

  /** 变更 ONU 光纤参数（长度 / 分光比）。 */
  set_optical_fiber(
    onu_device_id: string,
    options: {
      fiber_length_m?: number;
      splitter_ratio?: number;
      connectors?: number;
      splices?: number;
      broken?: boolean;
    }
  ): Promise<CommandResult>;

  /** 设置 ONU 业务负载（Mbps）。 */
  set_optical_traffic(
    onu_device_id: string,
    traffic: { downstream_mbps?: number; upstream_mbps?: number }
  ): Promise<CommandResult>;

  /** 时间推进。 */
  tick(delta_seconds: number): void;

  /** 订阅事件。 */
  on_event(handler: (event: SimlabEvent) => void): () => void;

  /** 销毁。 */
  dispose(): void;
}
