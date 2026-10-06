/**
 * @File : web/src/core/local_runtime.ts
 * @Time : 2026-10-05 05:10
 * @Author : Cetrp
 * @Description : 本地模拟运行时（离线模式的控制平面）：多设备、设备间线缆、二层/三层转发、
 *               端到端 ping、无线关联与漫游，全部与后端契约 v1/v2 同语义。
 */

import { CliSession } from '../cli/interpreter';
import { EVENT_TYPE, PORT_STATE, DEVICE_STATE, utils } from './constants';
import { DeviceRuntime } from './device_runtime';
import { LocalRadioModel } from './radio_model';
import type { ApRadioSettings } from './radio_model';
import { LocalOpticalModel } from './optical_model';
import { get_registry } from '../data/assets';
import { expand_ports } from '../data/spec_loader';
import { desktop_port_keys, desktop_port_layout } from './desktop_ports';

import type { OpticalAlarm, OpticalLink, OpticalOlt, OpticalSnapshot } from './optical_model';
import type {
  CableRecord,
  CommandResult,
  DeviceSnapshot,
  PingResult,
  PortRef,
  SimlabEvent,
  WirelessSnapshot
} from './runtime_types';
import type { DeviceManifest, PortState } from '../data/types';
import type { EventBus } from './event_bus';

/** 链路协商窗口（秒）。 */
const LINK_NEGOTIATION_DELAY = 0.9;

/** 开机日志逐行间隔（毫秒）。 */
const BOOT_LINE_INTERVAL_MS = 200;

/** 有线 / 无线链路时延（毫秒）。 */
const WIRED_LATENCY_MS = 0.02;
const WIRELESS_LATENCY_MS = 2.4;

/** 每跳转发时延（毫秒）。 */
const FORWARDING_DELAY_MS: Record<string, number> = {
  switch: 0.05,
  l3switch: 0.12,
  router: 0.28,
  firewall: 0.35,
  ap: 0.8,
  pc: 0.05,
  server: 0.05,
  laptop: 0.05,
  phone: 0.05
};

/** 无线状态上报周期（秒）。 */
const WIRELESS_STEP_INTERVAL = 0.5;

/** 光链路状态上报周期（秒）。 */
const OPTICAL_STEP_INTERVAL = 0.5;

/** 光缆长度系数：机房走线 / 盘留使实际光缆长于直线距离。 */
const FIBER_LENGTH_FACTOR = 1.25;

/** 默认分光比。 */
const DEFAULT_SPLITTER_RATIO = 8;

/**
 * 判断设备是否为无线 AP。
 *
 * @param {DeviceManifest} manifest 设备 Manifest。
 * @returns {boolean} 是否为 AP。
 */
export function is_wireless_ap(manifest: DeviceManifest): boolean {
  return manifest.device_type === 'ap' || (manifest.wireless && manifest.wireless.role === 'ap');
}

/**
 * 判断设备是否为无线客户端。
 *
 * @param {DeviceManifest} manifest 设备 Manifest。
 * @returns {boolean} 是否为 STA。
 */
export function is_wireless_client(manifest: DeviceManifest): boolean {
  return (
    manifest.device_type === 'laptop' ||
    manifest.device_type === 'phone' ||
    (manifest.wireless && manifest.wireless.role === 'sta')
  );
}

/**
 * 判断设备是否为 OLT。
 *
 * @param {DeviceManifest} manifest 设备 Manifest。
 * @returns {boolean} 是否为 OLT。
 */
export function is_olt(manifest: DeviceManifest): boolean {
  return manifest.device_type === 'olt' || (manifest.optical && manifest.optical.role === 'olt');
}

/**
 * 判断设备是否为 ONU。
 *
 * @param {DeviceManifest} manifest 设备 Manifest。
 * @returns {boolean} 是否为 ONU。
 */
export function is_onu(manifest: DeviceManifest): boolean {
  return manifest.device_type === 'onu' || (manifest.optical && manifest.optical.role === 'onu');
}

/** 拓扑边（有线或无线）。 */
export interface TopologyEdge {
  kind: 'wired' | 'wireless';
  cable_id?: string;
  left_device: string;
  left_port: string | null;
  right_device: string;
  right_port: string | null;
  state: string;
}

/**
 * 本地模拟运行时。
 */
export class LocalRuntime {
  /** 事件总线。 */
  private bus: EventBus;

  /** 实验 ID。 */
  private experiment_id: string;

  /** 设备表。 */
  private devices = new Map<string, DeviceRuntime>();

  /** 线缆表。 */
  private cables = new Map<string, CableRecord>();

  /** 无线模型。 */
  private radio = new LocalRadioModel();

  /** 光链路模型。 */
  private optical = new LocalOpticalModel();

  /** 光链路步进累计。 */
  private optical_accumulator = 0;

  /** 控制台会话表。 */
  private sessions = new Map<string, CliSession>();

  /** 定时器集合（便于销毁）。 */
  private timers = new Set<ReturnType<typeof globalThis.setTimeout>>();

  /** 设备序号。 */
  private device_sequence = 0;

  /** 可选实验命名空间，避免不同本地实验产生相同的后端绑定 ID。 */
  private device_id_namespace = '';

  /** 线缆序号。 */
  private cable_sequence = 0;

  /** 无线步进累计。 */
  private wireless_accumulator = 0;

  /**
   * @param {object} options 构造参数。
   * @param {EventBus} options.bus 事件总线。
   * @param {string} [options.experiment_id] 实验 ID。
   * @param {string} [options.device_id_namespace] 新建设备 ID 的实验命名空间。
   */
  constructor(options: { bus: EventBus; experiment_id?: string; device_id_namespace?: string }) {
    this.bus = options.bus;
    this.experiment_id = options.experiment_id || 'exp-local-001';
    this.device_id_namespace = (options.device_id_namespace || '')
      .replace(/[^A-Za-z0-9]/g, '')
      .slice(0, 12);
  }

  /**
   * 运行时类型。
   *
   * @returns {'local'} 类型标识。
   */
  type(): 'local' {
    return 'local';
  }

  /**
   * 离线模式无需连接。
   *
   * @returns {Promise<boolean>} 恒为 true。
   */
  async connect(): Promise<boolean> {
    return true;
  }

  /* ------------------------------ 设备 ------------------------------ */

  /**
   * 全部设备。
   *
   * @returns {DeviceRuntime[]} 设备数组。
   */
  list_devices(): DeviceRuntime[] {
    return [...this.devices.values()];
  }

  /**
   * 查询设备。
   *
   * @param {string} device_id 设备 ID。
   * @returns {DeviceRuntime | null} 设备。
   */
  get_device(device_id: string): DeviceRuntime | null {
    return this.devices.get(device_id) || null;
  }

  /**
   * 创建设备。
   *
   * @param {string} model_id 型号 ID。
   * @param {string} [hostname] 设备名。
   * @param {string} [preferred_device_id] 恢复已保存实验时使用的稳定设备 ID。
   * @returns {Promise<CommandResult>} 命令结果。
   */
  async create_device(
    model_id: string,
    hostname?: string,
    preferred_device_id?: string,
    port_names?: string[]
  ): Promise<CommandResult> {
    const registry = get_registry();
    const manifest = registry.manifest(model_id);
    if (!manifest) {
      return {
        success: false,
        error_code: 'MODEL_NOT_FOUND',
        message: '设备型号不存在：' + model_id
      };
    }
    const cli_profile = registry.cli_profile_for_vendor(manifest.vendor_id);
    if (!cli_profile) {
      return {
        success: false,
        error_code: 'CLI_PROFILE_MISSING',
        message: '缺少 CLI 档案：' + manifest.vendor_id
      };
    }
    const is_desktop = ['pc', 'laptop'].includes(manifest.device_type);
    if (is_desktop) {
      port_names = desktop_port_keys(model_id);
    }
    if (
      preferred_device_id &&
      (!/^[A-Za-z0-9._:-]{1,96}$/.test(preferred_device_id) || this.devices.has(preferred_device_id))
    ) {
      return {
        success: false,
        error_code: 'DEVICE_ID_INVALID',
        message: '保存文件中的设备 ID 非法或重复：' + preferred_device_id
      };
    }
    this.device_sequence += 1;
    const generated_prefix = this.device_id_namespace
      ? 'dev-' + this.device_id_namespace + '-'
      : 'dev-';
    const device_id =
      preferred_device_id || generated_prefix + String(this.device_sequence).padStart(3, '0');
    const sequence_match = /-(\d+)$/.exec(device_id);
    if (sequence_match) {
      this.device_sequence = Math.max(this.device_sequence, Number(sequence_match[1]));
    }
    const runtime_manifest = structuredClone(manifest);
    if (is_desktop && port_names?.length) {
      runtime_manifest.visual.port_layout = desktop_port_layout(model_id, port_names);
      runtime_manifest.port_overrides = port_names.map((short_name) => ({
        short_name, name: short_name, alias: short_name
      }));
    } else if (port_names?.length) {
      const existing = new Set(expand_ports(runtime_manifest).map((port) => String(port.short_name)));
      const missing = port_names.filter((name) => !existing.has(name));
      if (missing.length) {
        runtime_manifest.visual.port_layout.push({
          group_id: 'frontend-ethernet-modules', kind: 'rj45', label: '模块化以太网口',
          speed_bps: 1_000_000_000,
          naming: { short_prefix: 'eth' },
          rows: [{ start_index: 0, count: missing.length, names: missing }]
        });
      }
    }
    const device = new DeviceRuntime({
      device_id: device_id,
      experiment_id: this.experiment_id,
      manifest: runtime_manifest,
      vendor_profile: registry.vendor(manifest.vendor_id),
      cli_profile: cli_profile,
      hostname: hostname
    });
    /* 自动排布：设备在场景中按 2 倍显示比例建模（1 米 ≈ 2 单位），
       19 英寸设备宽约 8.8 单位，因此列间距取 12 单位、行间距取 8 单位。 */
    const index = this.devices.size;
    const column = index % 3;
    const row = Math.floor(index / 3);
    const column_offset = row % 2 === 0 ? 0 : 6;
    device.position = {
      x: (column - 1) * 12 + column_offset,
      y: 0,
      z: (row - 0.5) * 8
    };
    this.devices.set(device_id, device);
    this._ensure_radio_node(device);
    this._ensure_optical_node(device);
    this.bus.publish({
      event_type: EVENT_TYPE.DEVICE_CREATED,
      experiment_id: this.experiment_id,
      device_id: device_id,
      data: {
        model_id: manifest.model_id,
        vendor_id: manifest.vendor_id,
        summary: device.summary()
      }
    });
    return {
      success: true,
      command_id: 'cmd-local-' + device_id,
      command_type: 'CreateDevice',
      data: { device_id: device_id, model_id: manifest.model_id, device: device }
    };
  }

  /**
   * 删除设备并清理其线缆。
   *
   * @param {string} device_id 设备 ID。
   * @returns {Promise<CommandResult>} 命令结果。
   */
  async delete_device(device_id: string): Promise<CommandResult> {
    const device = this.devices.get(device_id);
    if (!device) {
      return { success: false, error_code: 'DEVICE_NOT_FOUND', message: '设备不存在' };
    }
    for (const cable of [...this.cables.values()]) {
      if (cable.source.device_id === device_id || cable.target?.device_id === device_id) {
        this._remove_cable(cable.cable_id);
      }
    }
    this.devices.delete(device_id);
    /* 设备被删除后其无线关联一并失效。 */
    this._prune_wireless_associations('DEVICE_REMOVED');
    this.radio.remove_node(device_id);
    this.optical.remove_node(device_id);
    this.bus.publish({
      event_type: EVENT_TYPE.DEVICE_STATE_CHANGED,
      experiment_id: this.experiment_id,
      device_id: device_id,
      data: { from: device.power_state, to: 'DELETED' }
    });
    return { success: true, command_id: 'cmd-local-del', command_type: 'DeleteDevice' };
  }

  /**
   * 开关机。
   *
   * @param {string} device_id 设备 ID。
   * @param {boolean} is_on 是否开机。
   * @returns {Promise<CommandResult>} 命令结果。
   */
  async power(device_id: string, is_on: boolean): Promise<CommandResult> {
    const device = this.devices.get(device_id);
    if (!device) {
      return { success: false, error_code: 'DEVICE_NOT_FOUND', message: '设备不存在' };
    }
    const from_state = device.power_state;
    if (is_on && (from_state === DEVICE_STATE.RUNNING || from_state === DEVICE_STATE.POWERING_ON)) {
      return { success: true, command_id: 'cmd-local-power', command_type: 'PowerOn' };
    }
    if (!is_on && from_state === DEVICE_STATE.OFF) {
      return { success: true, command_id: 'cmd-local-power', command_type: 'PowerOff' };
    }

    if (!is_on) {
      device.power_state = DEVICE_STATE.OFF;
      device.boot_progress = 0;
      for (const port of device.ports) {
        const was_up = port.link_up;
        port.link_up = false;
        port.state = PORT_STATE.DOWN;
        if (was_up) {
          this._emit_link(device, port, PORT_STATE.UP, PORT_STATE.DOWN);
        }
      }
      device.push_log('System is powered off');
      this._publish_state(device, from_state, device.power_state);
      /* 关机后无线链路必须断开：STA 关机解除自身关联，AP 关机解除其下所有 STA。 */
      this._prune_wireless_associations('DEVICE_POWER_OFF');
      this._refresh_wireless_links();
      /* 主机断电后光路同样失效。 */
      this._sync_optical_links();
      return { success: true, command_id: 'cmd-local-power', command_type: 'PowerOff' };
    }

    device.power_state = DEVICE_STATE.POWERING_ON;
    device.boot_progress = 0.05;
    this._publish_state(device, from_state, device.power_state);

    const boot_lines = (device.vendor_profile.boot_log || []).map((line: string) =>
      this._interpolate(line, device)
    );
    boot_lines.forEach((line: string, index: number) => {
      this._later(index * BOOT_LINE_INTERVAL_MS + 60, () => {
        if (
          device.power_state !== DEVICE_STATE.POWERING_ON &&
          device.power_state !== DEVICE_STATE.BOOTING
        ) {
          return;
        }
        device.push_log(line);
        device.boot_progress = utils.clamp((index + 1) / (boot_lines.length + 1), 0, 0.95);
        this.bus.publish({
          event_type: EVENT_TYPE.DEVICE_BOOT_PROGRESS,
          experiment_id: this.experiment_id,
          device_id: device.device_id,
          data: { line: line, progress: device.boot_progress }
        });
      });
    });

    this._later(boot_lines.length * BOOT_LINE_INTERVAL_MS + 260, () => {
      if (
        device.power_state !== DEVICE_STATE.POWERING_ON &&
        device.power_state !== DEVICE_STATE.BOOTING
      ) {
        return;
      }
      device.power_state = DEVICE_STATE.RUNNING;
      device.boot_progress = 1;
      device.uptime_seconds = 0;
      device.refresh_mac_table();
      for (const port of device.ports) {
        if (port.plugged && port.admin_up) {
          port.link_up = true;
          port.state = PORT_STATE.UP;
          this._emit_link(device, port, PORT_STATE.DOWN, PORT_STATE.UP);
        }
      }
      this._publish_state(device, DEVICE_STATE.BOOTING, device.power_state);
      /* 设备上电后重新协商其所有线缆：链路状态必须由两端共同决定。 */
      for (const cable of [...this.cables.values()]) {
        const touches_device =
          cable.source.device_id === device.device_id ||
          (cable.target && cable.target.device_id === device.device_id);
        if (touches_device) {
          this._negotiate_cable(cable);
        }
      }
      this._prune_wireless_associations('DEVICE_NOT_RUNNING');
      this._refresh_wireless_links();
      this._sync_optical_links();
      device.push_log('System is ready, ' + device.ports.length + ' ports available');
    });
    return { success: true, command_id: 'cmd-local-power', command_type: 'PowerOn' };
  }

  /**
   * 移动设备（同步无线模型位置）。
   *
   * @param {string} device_id 设备 ID。
   * @param {object} position 位置。
   * @returns {Promise<CommandResult>} 命令结果。
   */
  async move_device(
    device_id: string,
    position: { x: number; y: number; z: number }
  ): Promise<CommandResult> {
    const device = this.devices.get(device_id);
    if (!device) {
      return { success: false, error_code: 'DEVICE_NOT_FOUND', message: '设备不存在' };
    }
    device.position = { ...position };
    if (this.radio.has_node(device_id)) {
      this.radio.set_position(device_id, position);
      /* 拖出射频圈立即断连（无需等下一次 2 秒步进）。 */
      for (const drop of this.radio.check_out_of_range(device_id)) {
        const sta_device = this.devices.get(drop.sta_id);
        this.bus.publish({
          event_type: EVENT_TYPE.WIRELESS_ASSOC_CHANGED,
          experiment_id: this.experiment_id,
          device_id: drop.sta_id,
          data: {
            sta_device_id: drop.sta_id,
            ap_device_id: null,
            state: 'DISASSOCIATED',
            reason: drop.reason,
            rssi_dbm: drop.rssi_dbm
          }
        });
        if (sta_device) {
          sta_device.push_log('Wireless link lost: moved out of range');
        }
      }
    }
    this.bus.publish({
      event_type: EVENT_TYPE.DEVICE_MOVED,
      experiment_id: this.experiment_id,
      device_id: device_id,
      data: { position: device.position }
    });
    return {
      success: true,
      command_id: 'cmd-local-move',
      command_type: 'MoveDevice',
      data: { position: device.position }
    };
  }

  /* ------------------------------ 线缆 ------------------------------ */

  /**
   * 线缆快照。
   *
   * @returns {CableRecord[]} 线缆数组。
   */
  cables_snapshot(): CableRecord[] {
    return [...this.cables.values()].map((cable) => ({ ...cable }));
  }

  /**
   * 拓扑快照。
   *
   * @returns {{devices: DeviceSnapshot[]; cables: CableRecord[]}} 快照。
   */
  topology(): { devices: DeviceSnapshot[]; cables: CableRecord[] } {
    return { devices: this.devices_snapshot(), cables: this.cables_snapshot() };
  }

  /**
   * 设备快照（含端口对端信息）。
   *
   * @returns {DeviceSnapshot[]} 设备数组。
   */
  devices_snapshot(): DeviceSnapshot[] {
    return this.list_devices().map((device) => ({
      device_id: device.device_id,
      model_id: device.model_id,
      vendor_id: device.vendor_id,
      hostname: device.hostname,
      device_type: device.device_type,
      power_state: device.power_state,
      position: { ...device.position },
      ports: device.ports.map((port) => ({
        short_name: port.short_name,
        name: port.name,
        admin_up: port.admin_up,
        link_up: port.link_up,
        oper_state: port.state,
        speed: port.speed,
        duplex: port.duplex,
        vlan: port.vlan,
        description: port.description,
        poe_enabled: port.poe_enabled,
        mac_count: port.mac_count,
        rx_pkts: port.rx_pkts,
        tx_pkts: port.tx_pkts,
        crc_errors: port.crc_errors,
        cable_id: port.cable ? port.cable.cable_id : null,
        peer_device_id: port.peer_device_id || null,
        peer_port: port.peer_port || null
      }))
    }));
  }

  /**
   * 设备间（或接模拟对端）连线。
   *
   * @param {PortRef} source 源端口。
   * @param {PortRef} [target] 目标端口，省略表示接模拟对端。
   * @param {string} [cable_type] 线缆类型。
   * @param {string} [preferred_cable_id] 恢复已保存实验时使用的稳定线缆 ID。
   * @returns {Promise<CommandResult>} 命令结果。
   */
  async connect_cable(
    source: PortRef,
    target?: PortRef,
    cable_type?: string,
    preferred_cable_id?: string
  ): Promise<CommandResult> {
    const source_device = this.devices.get(source.device_id);
    if (!source_device) {
      return { success: false, error_code: 'DEVICE_NOT_FOUND', message: '源设备不存在' };
    }
    const source_port = source_device.find_port(source.port);
    if (!source_port) {
      return {
        success: false,
        error_code: 'PORT_NOT_FOUND',
        message: '源端口不存在：' + source.port
      };
    }
    if (source_port.plugged) {
      return { success: false, error_code: 'PORT_OCCUPIED', message: '源端口已被占用' };
    }

    let target_device: DeviceRuntime | null = null;
    let target_port: PortState | null = null;
    if (target) {
      if (target.device_id === source.device_id) {
        return { success: false, error_code: 'SELF_LOOP', message: '不支持同一设备自环' };
      }
      target_device = this.devices.get(target.device_id) || null;
      if (!target_device) {
        return { success: false, error_code: 'DEVICE_NOT_FOUND', message: '目标设备不存在' };
      }
      target_port = target_device.find_port(target.port);
      if (!target_port) {
        return {
          success: false,
          error_code: 'PORT_NOT_FOUND',
          message: '目标端口不存在：' + target.port
        };
      }
      if (target_port.plugged) {
        return { success: false, error_code: 'PORT_OCCUPIED', message: '目标端口已被占用' };
      }
      const mismatch =
        source_device.is_optical(source_port) !== target_device.is_optical(target_port) &&
        source_port.kind !== 'combo' &&
        target_port.kind !== 'combo';
      if (mismatch) {
        return {
          success: false,
          error_code: 'CONNECTOR_MISMATCH',
          message: '连接器不兼容：' + source_port.type + ' ↔ ' + target_port.type
        };
      }
    }

    if (
      preferred_cable_id &&
      (!/^[A-Za-z0-9._:-]{1,96}$/.test(preferred_cable_id) || this.cables.has(preferred_cable_id))
    ) {
      return {
        success: false,
        error_code: 'CABLE_ID_INVALID',
        message: '保存文件中的线缆 ID 非法或重复：' + preferred_cable_id
      };
    }
    this.cable_sequence += 1;
    const cable_id = preferred_cable_id || 'cab-' + String(this.cable_sequence).padStart(4, '0');
    const sequence_match = /^cab-(\d+)$/.exec(cable_id);
    if (sequence_match) {
      this.cable_sequence = Math.max(this.cable_sequence, Number(sequence_match[1]));
    }
    const resolved_type =
      cable_type || (source_device.is_optical(source_port) ? 'OPTICAL_FIBER' : 'ETHERNET_COPPER');
    const cable: CableRecord = {
      cable_id: cable_id,
      cable_type: resolved_type,
      state: 'CONNECTING',
      length_m: target ? Number(utils.rnd(1.5, 5).toFixed(1)) : 2.0,
      latency_ms: WIRED_LATENCY_MS,
      source: { device_id: source.device_id, port: source_port.short_name },
      target:
        target && target_port
          ? { device_id: target.device_id, port: target_port.short_name }
          : null,
      peer_label: target ? null : '模拟对端'
    };
    this.cables.set(cable_id, cable);

    this._attach_port(source_device, source_port, cable, target_device, target_port);
    if (target_device && target_port) {
      this._attach_port(target_device, target_port, cable, source_device, source_port);
    }
    this.bus.publish({
      event_type: EVENT_TYPE.CABLE_CONNECTED,
      experiment_id: this.experiment_id,
      device_id: source.device_id,
      data: {
        cable_id: cable_id,
        port: source_port.short_name,
        target_device_id: target ? target.device_id : null,
        target_port: target_port ? target_port.short_name : null,
        cable_type: resolved_type,
        state: 'CONNECTING'
      }
    });

    this._later(LINK_NEGOTIATION_DELAY * 1000, () => {
      if (!this.cables.has(cable_id)) {
        return;
      }
      this._negotiate_cable(cable);
    });
    return {
      success: true,
      command_id: 'cmd-local-cable',
      command_type: 'ConnectCable',
      data: { cable: cable }
    };
  }

  /**
   * 拔线。
   *
   * @param {string} cable_id 线缆 ID。
   * @returns {Promise<CommandResult>} 命令结果。
   */
  async disconnect_cable(cable_id: string): Promise<CommandResult> {
    if (!this.cables.has(cable_id)) {
      return { success: false, error_code: 'CABLE_NOT_FOUND', message: '线缆不存在' };
    }
    this._remove_cable(cable_id);
    return { success: true, command_id: 'cmd-local-uncable', command_type: 'DisconnectCable' };
  }

  /* ------------------------------ 端口配置与故障 ------------------------------ */

  /**
   * 配置端口。
   *
   * @param {string} device_id 设备 ID。
   * @param {string} port_id 端口短名。
   * @param {Record<string, unknown>} changes 变更字段。
   * @returns {Promise<CommandResult>} 命令结果。
   */
  async configure_port(
    device_id: string,
    port_id: string,
    changes: Record<string, unknown>
  ): Promise<CommandResult> {
    const device = this.devices.get(device_id);
    if (!device) {
      return { success: false, error_code: 'DEVICE_NOT_FOUND', message: '设备不存在' };
    }
    const port = device.find_port(port_id);
    if (!port) {
      return { success: false, error_code: 'PORT_NOT_FOUND', message: '端口不存在：' + port_id };
    }
    const applied: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(changes || {})) {
      if (field === 'admin_up') {
        port.admin_up = Boolean(value);
        port.state = port.admin_up ? PORT_STATE.DOWN : PORT_STATE.DISABLED;
        if (!port.admin_up && port.link_up) {
          port.link_up = false;
          this._emit_link(device, port, PORT_STATE.UP, PORT_STATE.DOWN);
        }
        if (port.admin_up && port.plugged && device.power_state === DEVICE_STATE.RUNNING) {
          port.link_up = true;
          port.state = PORT_STATE.UP;
          this._emit_link(device, port, PORT_STATE.DOWN, PORT_STATE.UP);
        }
        applied.admin_up = port.admin_up;
      } else if (field === 'vlan') {
        port.vlan = Number(value);
        applied.vlan = port.vlan;
      } else if (field === 'speed') {
        port.speed_mode = String(value);
        applied.speed = port.speed_mode;
      } else if (field === 'duplex') {
        port.duplex = String(value);
        applied.duplex = port.duplex;
      } else if (field === 'poe_enabled') {
        port.poe_enabled = Boolean(value) && port.poe_capable;
        port.poe_watts = port.poe_enabled ? Number(utils.rnd(3.2, 15.4).toFixed(1)) : 0;
        applied.poe_enabled = port.poe_enabled;
      } else if (field === 'description') {
        port.description = String(value);
        applied.description = port.description;
      }
    }
    port.last_change_at = Date.now();
    device.config_dirty = true;
    this.bus.publish({
      event_type: EVENT_TYPE.PORT_CONFIG_CHANGED,
      experiment_id: this.experiment_id,
      device_id: device_id,
      data: { port: port.short_name, changes: applied }
    });
    return {
      success: true,
      command_id: 'cmd-local-port',
      command_type: 'ConfigurePort',
      data: { port: port.short_name, applied: applied }
    };
  }

  /**
   * 注入故障。
   *
   * @param {string} device_id 设备 ID。
   * @param {string | null} port_id 端口短名。
   * @param {string} fault_type 故障类型。
   * @returns {Promise<CommandResult>} 命令结果。
   */
  async inject_fault(
    device_id: string,
    port_id: string | null,
    fault_type: string
  ): Promise<CommandResult> {
    const device = this.devices.get(device_id);
    if (!device) {
      return { success: false, error_code: 'DEVICE_NOT_FOUND', message: '设备不存在' };
    }
    const port = port_id ? device.find_port(port_id) : null;
    if (fault_type === 'high_temp') {
      device.environment.temperature = 78.5;
      device.environment.fan_status = 'Abnormal';
      device.push_log('Temperature threshold exceeded: 78.5 C', 'WARNING');
    } else if (port && fault_type === 'crc') {
      port.crc_errors += utils.rint(120, 480);
      port.in_errors += port.crc_errors;
      device.push_log('Interface ' + port.name + ' detected CRC errors', 'WARNING');
    } else if (port && fault_type === 'cable_broken') {
      if (port.cable) {
        this._remove_cable(port.cable.cable_id);
      } else {
        port.plugged = false;
        port.link_up = false;
        port.state = PORT_STATE.ERROR;
      }
    } else if (port && fault_type === 'flap') {
      const original = port.link_up;
      port.link_up = false;
      port.state = PORT_STATE.DOWN;
      this._later(1200, () => {
        port.link_up = original;
        port.state = original ? PORT_STATE.UP : PORT_STATE.DOWN;
        this._emit_link(device, port, PORT_STATE.DOWN, PORT_STATE.UP);
      });
    } else {
      return { success: false, error_code: 'FAULT_UNSUPPORTED', message: '不支持的故障类型' };
    }
    this.bus.publish({
      event_type: EVENT_TYPE.FAULT_INJECTED,
      experiment_id: this.experiment_id,
      device_id: device_id,
      data: { port: port ? port.short_name : null, fault_type: fault_type }
    });
    return { success: true, command_id: 'cmd-local-fault', command_type: 'InjectFault' };
  }

  /**
   * 保存配置。
   *
   * @param {string} device_id 设备 ID。
   * @returns {Promise<CommandResult>} 命令结果。
   */
  async save_config(device_id: string): Promise<CommandResult> {
    const device = this.devices.get(device_id);
    if (!device) {
      return { success: false, error_code: 'DEVICE_NOT_FOUND', message: '设备不存在' };
    }
    device.config_saved = true;
    device.config_dirty = false;
    this.bus.publish({
      event_type: EVENT_TYPE.CONFIG_SAVED,
      experiment_id: this.experiment_id,
      device_id: device_id,
      data: {}
    });
    return { success: true, command_id: 'cmd-local-save', command_type: 'SaveConfig' };
  }

  /* ------------------------------ 控制台 ------------------------------ */

  /**
   * 打开控制台会话。
   *
   * @param {string} device_id 设备 ID。
   * @returns {Promise<object>} 会话信息。
   */
  async console_open(device_id: string): Promise<{
    success: boolean;
    session_id?: string;
    prompt?: string;
    mode?: string;
    message?: string;
  }> {
    const device = this.devices.get(device_id);
    if (!device) {
      return { success: false, message: '设备不存在' };
    }
    const existing = [...this.sessions.values()].find(
      (item) => item.device.device_id === device_id
    );
    if (existing) {
      return {
        success: true,
        session_id: existing.session_id,
        prompt: existing.prompt(),
        mode: existing.mode
      };
    }
    const session = new CliSession({
      device: device,
      profile: device.cli_profile,
      vendor: device.vendor_profile,
      emit: (event_type: string, data: Record<string, unknown>) =>
        this.bus.publish({
          event_type: event_type,
          experiment_id: this.experiment_id,
          device_id: device_id,
          data: data
        })
    });
    this.sessions.set(session.session_id, session);
    this.bus.publish({
      event_type: EVENT_TYPE.CONSOLE_SESSION,
      experiment_id: this.experiment_id,
      device_id: device_id,
      data: { session_id: session.session_id, action: 'open', mode: session.mode }
    });
    return {
      success: true,
      session_id: session.session_id,
      prompt: session.prompt(),
      mode: session.mode
    };
  }

  /**
   * 控制台输入。
   *
   * @param {string} session_id 会话 ID。
   * @param {string} input 输入内容。
   * @returns {Promise<object>} 回显结果。
   */
  async console_write(
    session_id: string,
    input: string
  ): Promise<{
    success: boolean;
    lines: string[];
    prompt: string;
    mode: string;
    message?: string;
  }> {
    const session = this.sessions.get(session_id);
    if (!session) {
      return { success: false, lines: [], prompt: '', mode: '', message: '控制台会话不存在' };
    }
    if (session.device.power_state !== DEVICE_STATE.RUNNING) {
      return {
        success: true,
        lines: ['% 设备未处于运行状态，请在 3D 场景中按电源键开机。'],
        prompt: session.prompt(),
        mode: session.mode
      };
    }
    const result = session.write(input);
    return {
      success: true,
      lines: result.lines,
      prompt: result.prompt,
      mode: result.mode
    };
  }

  /**
   * 控制台补全。
   *
   * @param {string} session_id 会话 ID。
   * @param {string} input 已输入内容。
   * @returns {Promise<string[]>} 候选。
   */
  async console_complete(session_id: string, input: string): Promise<string[]> {
    const session = this.sessions.get(session_id);
    return session ? session.complete(input) : [];
  }

  /**
   * 关闭控制台会话。
   *
   * @param {string} session_id 会话 ID。
   * @returns {Promise<CommandResult>} 命令结果。
   */
  async console_close(session_id: string): Promise<CommandResult> {
    const session = this.sessions.get(session_id);
    if (!session) {
      return { success: false, error_code: 'SESSION_NOT_FOUND', message: '控制台会话不存在' };
    }
    this.sessions.delete(session_id);
    this.bus.publish({
      event_type: EVENT_TYPE.CONSOLE_SESSION,
      experiment_id: this.experiment_id,
      device_id: session.device.device_id,
      data: { session_id: session_id, action: 'close' }
    });
    return { success: true, command_id: 'cmd-local-console', command_type: 'ConsoleClose' };
  }

  /* ------------------------------ 转发仿真 ------------------------------ */

  /**
   * 端到端连通性测试：按拓扑做二层/三层转发并逐跳广播事件。
   *
   * @param {string} source_device_id 源设备。
   * @param {object} target 目标（设备或 IP）。
   * @param {number} [count] 发包次数。
   * @returns {Promise<PingResult>} 结果。
   */
  async ping(
    source_device_id: string,
    target: { device_id?: string; ip?: string },
    count = 4
  ): Promise<PingResult> {
    const source = this.devices.get(source_device_id);
    const empty = this._empty_ping_result(count);
    if (!source) {
      return { ...empty, unreachable_reason: 'TARGET_UNKNOWN' };
    }
    if (source.power_state !== DEVICE_STATE.RUNNING) {
      return { ...empty, unreachable_reason: 'DEVICE_POWER_OFF' };
    }

    let target_device: DeviceRuntime | null = null;
    if (target.device_id) {
      target_device = this.devices.get(target.device_id) || null;
    } else if (target.ip) {
      target_device = this._find_device_by_ip(target.ip);
    }
    if (!target_device) {
      return { ...empty, unreachable_reason: 'TARGET_UNKNOWN' };
    }
    if (target_device.power_state !== DEVICE_STATE.RUNNING) {
      return { ...empty, unreachable_reason: 'DEVICE_POWER_OFF' };
    }

    const path = this._find_path(source_device_id, target_device.device_id);
    if (!path) {
      return { ...empty, unreachable_reason: this._no_link_reason(source, target_device) };
    }

    const hops: PingResult['hops'] = [];
    let latency = 0;
    for (let index = 0; index < path.length; index += 1) {
      const device_id = path[index].device_id;
      const device = this.devices.get(device_id)!;
      const in_port = index === 0 ? null : path[index].in_port;
      const out_port = index === path.length - 1 ? null : path[index].out_port;
      latency += FORWARDING_DELAY_MS[device.device_type] || 0.1;
      if (in_port && out_port && device.device_type === 'switch') {
        const in_state = device.find_port(in_port);
        const out_state = device.find_port(out_port);
        if (
          in_state &&
          out_state &&
          in_state.mode === 'access' &&
          out_state.mode === 'access' &&
          in_state.vlan !== out_state.vlan
        ) {
          return {
            ...empty,
            path: path.map((item) => item.device_id),
            unreachable_reason: 'VLAN_MISMATCH'
          };
        }
      }
      hops.push({
        device_id: device_id,
        in_port: in_port,
        out_port: out_port,
        mac_learned: device.mac_address,
        vlan: in_port ? (device.find_port(in_port)?.vlan ?? 1) : 1
      });
    }
    latency += (path.length - 1) * WIRED_LATENCY_MS;

    /* 逐跳广播 packet.forwarded，供 3D 动画展示转发路径。 */
    const flow_id = 'flow_' + Math.random().toString(36).slice(2, 8);
    hops.forEach((hop, index) => {
      for (let sequence = 1; sequence <= Math.min(count, 3); sequence += 1) {
        this._later(index * 140 + sequence * 40, () => {
          this.bus.publish({
            event_type: EVENT_TYPE.PACKET_FORWARDED,
            experiment_id: this.experiment_id,
            device_id: hop.device_id,
            data: {
              flow_id: flow_id,
              sequence: sequence,
              path: path.map((item) => item.device_id),
              hop_index: index,
              in_port: hop.in_port,
              out_port: hop.out_port,
              protocol: 'ICMP',
              size_bytes: 98,
              vlan: hop.vlan
            }
          });
        });
      }
    });

    const jitter = () => latency * 2 + utils.rnd(0.05, 0.35);
    const rtt_min = jitter();
    const rtt_max = jitter() + utils.rnd(0.1, 0.5);
    const result: PingResult = {
      success: true,
      reachable: true,
      count: count,
      received: count,
      loss_percent: 0,
      rtt_min_ms: Number(rtt_min.toFixed(3)),
      rtt_avg_ms: Number(((rtt_min + rtt_max) / 2).toFixed(3)),
      rtt_max_ms: Number(rtt_max.toFixed(3)),
      path: path.map((item) => item.device_id),
      hops: hops,
      unreachable_reason: null
    };
    this._later(hops.length * 140 + 200, () => {
      this.bus.publish({
        event_type: EVENT_TYPE.PING_COMPLETED,
        experiment_id: this.experiment_id,
        device_id: source_device_id,
        data: { ...result }
      });
    });
    return result;
  }

  /* ------------------------------ 无线 ------------------------------ */

  /**
   * 无线状态快照。
   *
   * @returns {Promise<WirelessSnapshot>} 快照。
   */
  async wireless_snapshot(): Promise<WirelessSnapshot> {
    return this.radio.snapshot((node_id) => {
      const device = this.devices.get(node_id);
      return device ? device.hostname : node_id;
    });
  }

  /** 更新浏览器 AP 射频模型；真实客体无线通路不受此操作控制。 */
  async configure_ap(device_id: string, settings: ApRadioSettings): Promise<CommandResult> {
    const device = this.devices.get(device_id);
    if (!device || !is_wireless_ap(device.manifest)) {
      return { success: false, error_code: 'AP_NOT_FOUND', message: 'AP 不存在；请刷新实验后重试。' };
    }
    const ssid = settings.ssid.trim();
    if (!ssid || new TextEncoder().encode(ssid).length > 32 ||
        ![1, 6, 11, 36, 40, 44, 48].includes(settings.channel) ||
        !Number.isInteger(settings.tx_power_dbm) ||
        settings.tx_power_dbm < 0 || settings.tx_power_dbm > 30) {
      return {
        success: false,
        error_code: 'AP_RADIO_INVALID',
        message: 'SSID 须为 1–32 字节，信道选 1/6/11/36/40/44/48，功率为 0–30 dBm。'
      };
    }
    const disconnected = this.radio.configure_ap(device_id, {
      ssid, channel: settings.channel, tx_power_dbm: settings.tx_power_dbm
    });
    for (const client_id of disconnected) {
      this.bus.publish({
        event_type: EVENT_TYPE.WIRELESS_ASSOC_CHANGED,
        experiment_id: this.experiment_id,
        device_id: client_id,
        data: { sta_device_id: client_id, ap_device_id: null, state: 'DISASSOCIATED',
          reason: 'AP_RADIO_CHANGED' }
      });
    }
    return {
      success: true, command_id: 'cmd-local-ap-radio', command_type: 'ConfigureApRadio',
      data: { device_id, ssid, channel: settings.channel,
        tx_power_dbm: settings.tx_power_dbm, disconnected }
    };
  }

  /**
   * STA 关联 AP（省略 AP 时自动选择最强信号）。
   *
   * @param {string} sta_device_id STA 设备。
   * @param {string} [ap_device_id] AP 设备。
   * @returns {Promise<CommandResult>} 命令结果。
   */
  async associate(sta_device_id: string, ap_device_id?: string): Promise<CommandResult> {
    const sta = this.devices.get(sta_device_id);
    if (!sta || !is_wireless_client(sta.manifest)) {
      return {
        success: false,
        error_code: 'WIRELESS_UNSUPPORTED',
        message: '设备不具备无线客户端能力'
      };
    }
    if (sta.power_state !== DEVICE_STATE.RUNNING) {
      return { success: false, error_code: 'STATE_NOT_ALLOWED', message: '设备未开机，无法关联' };
    }
    if (ap_device_id) {
      const ap = this.devices.get(ap_device_id);
      if (!ap || !is_wireless_ap(ap.manifest)) {
        return { success: false, error_code: 'WIRELESS_UNSUPPORTED', message: '目标设备不是 AP' };
      }
      if (ap.power_state !== DEVICE_STATE.RUNNING) {
        return { success: false, error_code: 'STATE_NOT_ALLOWED', message: 'AP 未开机' };
      }
    }
    const record = this.radio.associate(sta_device_id, ap_device_id);
    if (!record) {
      return { success: false, error_code: 'AP_NOT_FOUND', message: '没有可用的 AP' };
    }
    this.bus.publish({
      event_type: EVENT_TYPE.WIRELESS_ASSOC_CHANGED,
      experiment_id: this.experiment_id,
      device_id: sta_device_id,
      data: { ...record, ap_device_id: record.ap_device_id }
    });
    return {
      success: true,
      command_id: 'cmd-local-assoc',
      command_type: 'WirelessAssociate',
      data: { association: record }
    };
  }

  /**
   * 解除无线关联。
   *
   * @param {string} sta_device_id STA 设备。
   * @returns {Promise<CommandResult>} 命令结果。
   */
  async disassociate(sta_device_id: string): Promise<CommandResult> {
    this.radio.disassociate(sta_device_id);
    this.bus.publish({
      event_type: EVENT_TYPE.WIRELESS_ASSOC_CHANGED,
      experiment_id: this.experiment_id,
      device_id: sta_device_id,
      data: { sta_device_id: sta_device_id, ap_device_id: null, state: 'IDLE' }
    });
    return {
      success: true,
      command_id: 'cmd-local-disassoc',
      command_type: 'WirelessDisassociate'
    };
  }

  /**
   * 重命名设备（主机名）。
   *
   * @param {string} device_id 设备 ID。
   * @param {string} hostname 新主机名。
   * @returns {Promise<CommandResult>} 命令结果。
   */
  async rename_device(device_id: string, hostname: string): Promise<CommandResult> {
    const device = this.devices.get(device_id);
    if (!device) {
      return { success: false, error_code: 'DEVICE_NOT_FOUND', message: '设备不存在' };
    }
    if (!hostname || hostname.length > 32) {
      return { success: false, error_code: 'INVALID_FIELD', message: '主机名长度需在 1-32 之间' };
    }
    const previous = device.hostname;
    device.hostname = hostname;
    this.bus.publish({
      event_type: EVENT_TYPE.DEVICE_RENAMED,
      experiment_id: this.experiment_id,
      device_id: device_id,
      data: { from: previous, to: hostname }
    });

    return {
      success: true,
      command_id: 'cmd-local-rename',
      command_type: 'RenameDevice',
      data: { device_id: device_id, hostname: hostname }
    };
  }

  /* ------------------------------ 光链路 ------------------------------ */

  /**
   * 光链路状态快照。
   *
   * @returns {Promise<OpticalSnapshot>} 快照。
   */
  async optical_snapshot(): Promise<OpticalSnapshot> {
    this._sync_optical_links();
    return this.optical.snapshot();
  }

  /**
   * 变更 ONU 光纤参数。
   *
   * @param {string} onu_device_id ONU 设备 ID。
   * @param {object} options 光纤参数。
   * @returns {Promise<CommandResult>} 命令结果。
   */
  async set_optical_fiber(
    onu_device_id: string,
    options: {
      fiber_length_m?: number;
      splitter_ratio?: number;
      connectors?: number;
      splices?: number;
      broken?: boolean;
    }
  ): Promise<CommandResult> {
    const device = this.devices.get(onu_device_id);
    if (!device || !is_onu(device.manifest)) {
      return { success: false, error_code: 'OPTICAL_UNSUPPORTED', message: '设备不是 ONU' };
    }
    const link = this.optical.set_fiber(onu_device_id, options);
    if (!link) {
      return {
        success: false,
        error_code: 'OLT_NOT_FOUND',
        message: 'ONU 尚未绑定 OLT（请先连接光纤）'
      };
    }
    this.bus.publish({
      event_type: EVENT_TYPE.OPTICAL_LINK_CHANGED,
      experiment_id: this.experiment_id,
      device_id: onu_device_id,
      data: { ...link }
    });
    return {
      success: true,
      command_id: 'cmd-local-optical-fiber',
      command_type: 'SetOpticalFiber',
      data: { link: link }
    };
  }

  /**
   * 设置 ONU 业务负载。
   *
   * @param {string} onu_device_id ONU 设备 ID。
   * @param {object} traffic 上下行需求（Mbps）。
   * @returns {Promise<CommandResult>} 命令结果。
   */
  async set_optical_traffic(
    onu_device_id: string,
    traffic: { downstream_mbps?: number; upstream_mbps?: number }
  ): Promise<CommandResult> {
    const link = this.optical.set_traffic(onu_device_id, traffic);
    if (!link) {
      return { success: false, error_code: 'NOT_AN_ONU', message: 'ONU 尚未绑定 OLT' };
    }
    this.bus.publish({
      event_type: EVENT_TYPE.OPTICAL_METRICS_UPDATED,
      experiment_id: this.experiment_id,
      device_id: onu_device_id,
      data: { ...link }
    });
    return {
      success: true,
      command_id: 'cmd-local-optical-traffic',
      command_type: 'SetOpticalTraffic',
      data: { link: link }
    };
  }

  /**
   * 注册光节点（OLT / ONU）。
   *
   * @param {DeviceRuntime} device 设备。
   * @returns {void}
   * @private
   */
  private _ensure_optical_node(device: DeviceRuntime): void {
    const optical = device.manifest.optical;
    if (is_olt(device.manifest)) {
      this.optical.add_olt({
        node_id: device.device_id,
        pon_ports: (optical && optical.pon_ports) || 2,
        tx_power_dbm: (optical && optical.tx_power_dbm) || 3.0
      });
    }
  }

  /**
   * 按光纤线缆同步 ONU 与 OLT 的绑定关系（长度取光缆长度或场景距离）。
   *
   * @returns {void}
   * @private
   */
  private _sync_optical_links(): void {
    for (const cable of this.cables.values()) {
      if (cable.cable_type !== 'OPTICAL_FIBER' || !cable.target) {
        continue;
      }
      const source = this.devices.get(cable.source.device_id);
      const target = this.devices.get(cable.target.device_id);
      if (!source || !target) {
        continue;
      }
      const pair = [
        { device: source, port: cable.source.port },
        { device: target, port: cable.target.port }
      ];
      const olt_entry = pair.find((item) => is_olt(item.device.manifest));
      const onu_entry = pair.find((item) => is_onu(item.device.manifest));
      if (!olt_entry || !onu_entry) {
        continue;
      }
      const distance = Math.hypot(
        olt_entry.device.position.x - onu_entry.device.position.x,
        olt_entry.device.position.y - onu_entry.device.position.y,
        olt_entry.device.position.z - onu_entry.device.position.z
      );
      const fiber_length_m = utils.clamp(
        (cable.length_m || distance * 2) * FIBER_LENGTH_FACTOR,
        50,
        20000
      );
      if (!this.optical.has_onu(onu_entry.device.device_id)) {
        this.optical.add_onu({
          node_id: onu_entry.device.device_id,
          olt_id: olt_entry.device.device_id,
          pon_port: 1,
          fiber_length_m: Number(fiber_length_m.toFixed(1)),
          splitter_ratio: DEFAULT_SPLITTER_RATIO
        });
        this.bus.publish({
          event_type: EVENT_TYPE.OPTICAL_LINK_CHANGED,
          experiment_id: this.experiment_id,
          device_id: onu_entry.device.device_id,
          data: {
            onu_id: onu_entry.device.device_id,
            olt_id: olt_entry.device.device_id,
            state: 'WORKING'
          }
        });
      }
    }
  }

  /* ------------------------------ 时间推进 ------------------------------ */

  /**
   * 推进运行时（由渲染主循环调用）。
   *
   * @param {number} delta_seconds 时间增量。
   * @returns {void}
   */
  tick(delta_seconds: number): void {
    for (const device of this.devices.values()) {
      device.update_traffic(delta_seconds);
      device.update_environment(delta_seconds);
    }
    this.wireless_accumulator += delta_seconds;
    if (this.wireless_accumulator >= WIRELESS_STEP_INTERVAL) {
      /* 设备中途关机（掉电）时也要断开无线链路。 */
      this._prune_wireless_associations('DEVICE_NOT_RUNNING');
      const step = this.radio.step(this.wireless_accumulator);
      this.wireless_accumulator = 0;
      /* 移出覆盖范围导致的掉线：广播断开事件并写入设备日志。 */
      for (const drop of step.drops) {
        const sta_device = this.devices.get(drop.sta_id);
        this.bus.publish({
          event_type: EVENT_TYPE.WIRELESS_ASSOC_CHANGED,
          experiment_id: this.experiment_id,
          device_id: drop.sta_id,
          data: {
            sta_device_id: drop.sta_id,
            ap_device_id: null,
            state: 'DISASSOCIATED',
            reason: drop.reason,
            rssi_dbm: drop.rssi_dbm
          }
        });
        if (sta_device) {
          sta_device.push_log(
            'Wireless link lost: out of range (' + drop.rssi_dbm + ' dBm < ' +
              this.radio.sensitivity_dbm + ' dBm)'
          );
        }
      }
      for (const association of step.associations) {
        this.bus.publish({
          event_type: EVENT_TYPE.WIRELESS_METRICS_UPDATED,
          experiment_id: this.experiment_id,
          device_id: association.sta_device_id,
          data: { ...association }
        });
      }
      for (const frame of step.frames.slice(0, 6)) {
        this.bus.publish({
          event_type: EVENT_TYPE.WIRELESS_FRAME,
          experiment_id: this.experiment_id,
          device_id: frame.sta_id,
          data: { ...frame }
        });
      }
      for (const ap of this.radio.aps_snapshot()) {
        this.bus.publish({
          event_type: EVENT_TYPE.WIRELESS_AP_UPDATED,
          experiment_id: this.experiment_id,
          device_id: ap.device_id,
          data: { ...ap }
        });
      }
    }

    this.optical_accumulator += delta_seconds;
    if (this.optical_accumulator >= OPTICAL_STEP_INTERVAL) {
      const step = this.optical.step(this.optical_accumulator);
      this.optical_accumulator = 0;
      for (const olt of step.olts) {
        this.bus.publish({
          event_type: EVENT_TYPE.OPTICAL_OLT_UPDATED,
          experiment_id: this.experiment_id,
          device_id: olt.node_id,
          data: { ...olt }
        });
      }
      for (const link of step.links) {
        this.bus.publish({
          event_type: EVENT_TYPE.OPTICAL_METRICS_UPDATED,
          experiment_id: this.experiment_id,
          device_id: link.onu_id,
          data: { ...link }
        });
      }
      for (const alarm of step.alarms) {
        this.bus.publish({
          event_type: EVENT_TYPE.OPTICAL_ALARM,
          experiment_id: this.experiment_id,
          device_id: alarm.onu_id,
          data: { ...alarm }
        });
      }
    }
  }

  /**
   * 订阅事件。
   *
   * @param {(event: SimlabEvent) => void} handler 处理函数。
   * @returns {() => void} 取消订阅函数。
   */
  on_event(handler: (event: SimlabEvent) => void): () => void {
    return this.bus.subscribe('*', handler);
  }

  /**
   * 销毁运行时。
   *
   * @returns {void}
   */
  dispose(): void {
    for (const timer of this.timers) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.sessions.clear();
    this.devices.clear();
    this.cables.clear();
  }

  /* ------------------------------ 内部实现 ------------------------------ */

  /**
   * 注册无线节点（AP / STA）。
   *
   * @param {DeviceRuntime} device 设备。
   * @returns {void}
   * @private
   */
  private _ensure_radio_node(device: DeviceRuntime): void {
    const wireless = device.manifest.wireless;
    if (is_wireless_ap(device.manifest)) {
      this.radio.add_ap({
        node_id: device.device_id,
        kind: 'ap',
        position: { ...device.position },
        ssid: (wireless && wireless.ssid_default) || 'SIMLAB-WLAN',
        channel: (wireless && wireless.channel) || 6,
        tx_power_dbm: (wireless && wireless.tx_power_dbm) || 20
      });
    } else if (is_wireless_client(device.manifest)) {
      this.radio.add_sta({
        node_id: device.device_id,
        kind: 'sta',
        position: { ...device.position }
      });
    }
  }

  /**
   * 把线缆挂到端口上。
   *
   * @param {DeviceRuntime} device 设备。
   * @param {PortState} port 端口。
   * @param {CableRecord} cable 线缆。
   * @param {DeviceRuntime | null} peer_device 对端设备。
   * @param {PortState | null} peer_port 对端端口。
   * @returns {void}
   * @private
   */
  private _attach_port(
    device: DeviceRuntime,
    port: PortState,
    cable: CableRecord,
    peer_device: DeviceRuntime | null,
    peer_port: PortState | null
  ): void {
    port.plugged = true;
    port.state = PORT_STATE.CONNECTING;
    port.cable = {
      cable_id: cable.cable_id,
      cable_type: cable.cable_type,
      state: 'CONNECTING',
      peer: peer_device && peer_port ? device_peer(peer_device, peer_port) : undefined
    };
    port.peer_device_id = peer_device ? peer_device.device_id : null;
    port.peer_port = peer_port ? peer_port.short_name : null;
    device.push_log('Interface ' + port.name + ' detects media, negotiating link');
    this.bus.publish({
      event_type: EVENT_TYPE.CABLE_CONNECTED,
      experiment_id: this.experiment_id,
      device_id: device.device_id,
      data: {
        cable_id: cable.cable_id,
        port: port.short_name,
        cable_type: cable.cable_type,
        state: 'CONNECTING'
      }
    });
  }

  /**
   * 链路协商：两端具备条件则置 UP。
   *
   * @param {CableRecord} cable 线缆。
   * @returns {void}
   * @private
   */
  private _negotiate_cable(cable: CableRecord): void {
    const endpoints: { device: DeviceRuntime; port: PortState }[] = [];
    const source_device = this.devices.get(cable.source.device_id);
    const source_port = source_device?.find_port(cable.source.port);
    if (source_device && source_port) {
      endpoints.push({ device: source_device, port: source_port });
    }
    if (cable.target) {
      const target_device = this.devices.get(cable.target.device_id);
      const target_port = target_device?.find_port(cable.target.port);
      if (target_device && target_port) {
        endpoints.push({ device: target_device, port: target_port });
      }
    }
    let all_ready = endpoints.length > 0;
    for (const endpoint of endpoints) {
      const ready = endpoint.device.power_state === DEVICE_STATE.RUNNING && endpoint.port.admin_up;
      all_ready = all_ready && ready;
    }
    cable.state = all_ready ? 'UP' : 'DOWN';
    for (const endpoint of endpoints) {
      const port = endpoint.port;
      if (all_ready) {
        port.link_up = true;
        port.state = PORT_STATE.UP;
        port.speed = endpoint.device.is_optical(port)
          ? '10G'
          : port.speed_mode === 'auto'
            ? Math.random() < 0.12
              ? '100M'
              : '1000M'
            : port.speed;
        port.last_change_at = Date.now();
        if (port.cable) {
          port.cable.state = 'UP';
        }
        endpoint.device.push_log(
          'Interface ' +
            port.name +
            ' link status changed to UP (' +
            port.speed +
            '/' +
            port.duplex +
            ')'
        );
        this._emit_link(endpoint.device, port, PORT_STATE.DOWN, PORT_STATE.UP);
      } else {
        port.link_up = false;
        port.state = PORT_STATE.DOWN;
        if (port.cable) {
          port.cable.state = 'DOWN';
        }
        endpoint.device.push_log('Interface ' + port.name + ' is not enabled, link stays down');
      }
    }
  }

  /**
   * 移除线缆并复位两端端口。
   *
   * @param {string} cable_id 线缆 ID。
   * @returns {void}
   * @private
   */
  private _remove_cable(cable_id: string): void {
    const cable = this.cables.get(cable_id);
    if (!cable) {
      return;
    }
    this.cables.delete(cable_id);
    this._sync_optical_links();
    const endpoints: { device: DeviceRuntime; port: PortState }[] = [];
    const source_device = this.devices.get(cable.source.device_id);
    const source_port = source_device?.find_port(cable.source.port);
    if (source_device && source_port) {
      endpoints.push({ device: source_device, port: source_port });
    }
    if (cable.target) {
      const target_device = this.devices.get(cable.target.device_id);
      const target_port = target_device?.find_port(cable.target.port);
      if (target_device && target_port) {
        endpoints.push({ device: target_device, port: target_port });
      }
    }
    for (const endpoint of endpoints) {
      const port = endpoint.port;
      const was_up = port.link_up;
      port.plugged = false;
      port.link_up = false;
      port.state = PORT_STATE.DOWN;
      port.macs = [];
      port.mac_count = 0;
      port.poe_watts = 0;
      port.cable = null;
      port.peer_device_id = null;
      port.peer_port = null;
      port.last_change_at = Date.now();
      endpoint.device.push_log(
        'Interface ' + port.name + ' link status changed to DOWN (cable removed)'
      );
      if (was_up) {
        this._emit_link(endpoint.device, port, PORT_STATE.UP, PORT_STATE.DOWN);
      }
    }
    this.bus.publish({
      event_type: EVENT_TYPE.CABLE_DISCONNECTED,
      experiment_id: this.experiment_id,
      device_id: cable.source.device_id,
      data: { cable_id: cable_id, port: cable.source.port }
    });
  }

  /**
   * 蓝牙 / Wi-Fi 链路变化后刷新相关端口可见性。
   *
   * @returns {void}
   * @private
   */
  /**
   * 清理失效的无线关联：STA 或 AP 只要不在 RUNNING，就解除关联并广播断开事件。
   *
   * 真机语义：STA 关机 / AP 掉电都会立即断开关联（AP 掉电时其下所有 STA 一起掉线）。
   *
   * @param {string} reason 断开原因（写入事件，便于前端提示与排障）。
   * @returns {number} 被解除的关联数量。
   * @private
   */
  private _prune_wireless_associations(reason: string): number {
    let removed = 0;
    for (const association of this.radio.associations_snapshot()) {
      const sta = this.devices.get(association.sta_device_id);
      const ap = this.devices.get(association.ap_device_id);
      const sta_ready = Boolean(sta && sta.power_state === DEVICE_STATE.RUNNING);
      const ap_ready = Boolean(ap && ap.power_state === DEVICE_STATE.RUNNING);
      if (sta_ready && ap_ready) {
        continue;
      }
      this.radio.disassociate(association.sta_device_id);
      removed += 1;
      this.bus.publish({
        event_type: EVENT_TYPE.WIRELESS_ASSOC_CHANGED,
        experiment_id: this.experiment_id,
        device_id: association.sta_device_id,
        data: {
          sta_device_id: association.sta_device_id,
          ap_device_id: null,
          state: 'DISASSOCIATED',
          reason: reason
        }
      });
    }

    return removed;
  }

  private _refresh_wireless_links(): void {
    /* 无线链路不占用物理端口，这里只负责把状态变化广播给前端。 */
    for (const association of this.radio.associations_snapshot()) {
      this.bus.publish({
        event_type: EVENT_TYPE.WIRELESS_ASSOC_CHANGED,
        experiment_id: this.experiment_id,
        device_id: association.sta_device_id,
        data: { ...association }
      });
    }
  }

  /**
   * 拓扑边集合（有线 + 无线）。
   *
   * @returns {TopologyEdge[]} 边列表。
   * @private
   */
  private _edges(): TopologyEdge[] {
    const edges: TopologyEdge[] = [];
    for (const cable of this.cables.values()) {
      if (!cable.target) {
        continue;
      }
      const source_device = this.devices.get(cable.source.device_id);
      const target_device = this.devices.get(cable.target.device_id);
      const source_port = source_device?.find_port(cable.source.port);
      const target_port = target_device?.find_port(cable.target.port);
      const up = Boolean(source_port?.link_up && target_port?.link_up);
      edges.push({
        kind: 'wired',
        cable_id: cable.cable_id,
        left_device: cable.source.device_id,
        left_port: cable.source.port,
        right_device: cable.target.device_id,
        right_port: cable.target.port,
        state: up ? 'UP' : 'DOWN'
      });
    }
    for (const association of this.radio.associations_snapshot()) {
      const sta = this.devices.get(association.sta_device_id);
      const ap = this.devices.get(association.ap_device_id);
      const up =
        sta?.power_state === DEVICE_STATE.RUNNING && ap?.power_state === DEVICE_STATE.RUNNING;
      edges.push({
        kind: 'wireless',
        left_device: association.sta_device_id,
        left_port: null,
        right_device: association.ap_device_id,
        right_port: null,
        state: up ? 'UP' : 'DOWN'
      });
    }
    return edges;
  }

  /**
   * BFS 查找转发路径。
   *
   * @param {string} source_id 源设备。
   * @param {string} target_id 目标设备。
   * @returns {{device_id: string; in_port: string | null; out_port: string | null}[] | null} 路径。
   * @private
   */
  private _find_path(
    source_id: string,
    target_id: string
  ): { device_id: string; in_port: string | null; out_port: string | null }[] | null {
    if (source_id === target_id) {
      return [{ device_id: source_id, in_port: null, out_port: null }];
    }
    const edges = this._edges().filter((edge) => edge.state === 'UP');
    const adjacency = new Map<
      string,
      { next: string; in_port: string | null; out_port: string | null }[]
    >();
    for (const edge of edges) {
      if (!adjacency.has(edge.left_device)) {
        adjacency.set(edge.left_device, []);
      }
      if (!adjacency.has(edge.right_device)) {
        adjacency.set(edge.right_device, []);
      }
      adjacency.get(edge.left_device)!.push({
        next: edge.right_device,
        in_port: null,
        out_port: edge.left_port
      });
      adjacency.get(edge.right_device)!.push({
        next: edge.left_device,
        in_port: null,
        out_port: edge.right_port
      });
    }

    const queue: string[] = [source_id];
    const previous = new Map<
      string,
      { from: string; out_port: string | null; in_port: string | null }
    >();
    const visited = new Set<string>([source_id]);
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current === target_id) {
        break;
      }
      for (const neighbour of adjacency.get(current) || []) {
        if (visited.has(neighbour.next)) {
          continue;
        }
        visited.add(neighbour.next);
        previous.set(neighbour.next, {
          from: current,
          out_port: neighbour.out_port,
          in_port: neighbour.in_port
        });
        queue.push(neighbour.next);
      }
    }
    if (!previous.has(target_id)) {
      return null;
    }

    const reversed: { device_id: string; in_port: string | null; out_port: string | null }[] = [];
    let cursor = target_id;
    while (cursor !== source_id) {
      const link = previous.get(cursor)!;
      reversed.push({ device_id: cursor, in_port: link.in_port, out_port: null });
      cursor = link.from;
    }
    reversed.push({ device_id: source_id, in_port: null, out_port: null });
    reversed.reverse();

    /* 补齐每跳的入端口 / 出端口。 */
    for (let index = 0; index < reversed.length; index += 1) {
      const next = reversed[index + 1];
      const current = reversed[index];
      if (!next) {
        continue;
      }
      const edge = edges.find(
        (item) =>
          (item.left_device === current.device_id && item.right_device === next.device_id) ||
          (item.right_device === current.device_id && item.left_device === next.device_id)
      );
      if (edge) {
        current.out_port =
          edge.left_device === current.device_id ? edge.left_port : edge.right_port;
        next.in_port = edge.left_device === next.device_id ? edge.left_port : edge.right_port;
      }
    }
    return reversed;
  }

  /**
   * 不可达原因判定。
   *
   * @param {DeviceRuntime} source 源设备。
   * @param {DeviceRuntime} target 目标设备。
   * @returns {string} 原因码。
   * @private
   */
  private _no_link_reason(source: DeviceRuntime, target: DeviceRuntime): string {
    const source_ports = source.ports.filter((port) => port.plugged);
    const shut_ports = source.ports.filter((port) => !port.admin_up);
    if (source_ports.length === 0) {
      return 'NO_LINK';
    }
    if (shut_ports.length === source.ports.length) {
      return 'PORT_SHUTDOWN';
    }
    const vlan_set = new Set(source.ports.filter((port) => port.link_up).map((port) => port.vlan));
    const target_vlans = new Set(
      target.ports.filter((port) => port.link_up).map((port) => port.vlan)
    );
    for (const vlan of vlan_set) {
      if (!target_vlans.has(vlan)) {
        return 'VLAN_MISMATCH';
      }
    }
    return source.device_type === 'switch' ? 'NO_LINK' : 'NO_ROUTE';
  }

  /**
   * 按 IP 查找设备（匹配 Vlanif 接口地址）。
   *
   * @param {string} ip 目标 IP。
   * @returns {DeviceRuntime | null} 设备。
   * @private
   */
  private _find_device_by_ip(ip: string): DeviceRuntime | null {
    for (const device of this.devices.values()) {
      for (const vlan_interface of device.vlan_interfaces.values()) {
        if (vlan_interface.ip_address === ip) {
          return device;
        }
      }
    }
    return null;
  }

  /**
   * 空 ping 结果。
   *
   * @param {number} count 次数。
   * @returns {PingResult} 结果。
   * @private
   */
  private _empty_ping_result(count: number): PingResult {
    return {
      success: true,
      reachable: false,
      count: count,
      received: 0,
      loss_percent: 100,
      rtt_min_ms: 0,
      rtt_avg_ms: 0,
      rtt_max_ms: 0,
      path: [],
      hops: [],
      unreachable_reason: 'NO_LINK'
    };
  }

  /**
   * 发布设备状态变化事件。
   *
   * @param {DeviceRuntime} device 设备。
   * @param {string} from_state 原状态。
   * @param {string} to_state 新状态。
   * @returns {void}
   * @private
   */
  private _publish_state(device: DeviceRuntime, from_state: string, to_state: string): void {
    this.bus.publish({
      event_type: EVENT_TYPE.DEVICE_STATE_CHANGED,
      experiment_id: this.experiment_id,
      device_id: device.device_id,
      data: { from: from_state, to: to_state }
    });
  }

  /**
   * 发布链路变化事件。
   *
   * @param {DeviceRuntime} device 设备。
   * @param {PortState} port 端口。
   * @param {string} from_state 原状态。
   * @param {string} to_state 新状态。
   * @returns {void}
   * @private
   */
  private _emit_link(
    device: DeviceRuntime,
    port: PortState,
    from_state: string,
    to_state: string
  ): void {
    if (to_state === PORT_STATE.UP) {
      device.refresh_mac_table();
    }
    this.bus.publish({
      event_type: EVENT_TYPE.PORT_LINK_CHANGED,
      experiment_id: this.experiment_id,
      device_id: device.device_id,
      data: {
        port: port.short_name,
        from: from_state,
        to: to_state,
        speed: port.speed,
        duplex: port.duplex
      }
    });
  }

  /**
   * 模板插值（启动日志）。
   *
   * @param {string} text 模板。
   * @param {DeviceRuntime} device 设备。
   * @returns {string} 渲染结果。
   * @private
   */
  private _interpolate(text: string, device: DeviceRuntime): string {
    const context = device.template_context();
    return String(text).replace(/\{(\w+)\}/g, (match: string, key: string) => {
      const value = (context as Record<string, unknown>)[key];
      return value === undefined ? match : String(value);
    });
  }

  /**
   * 延迟执行（可被 dispose 取消）。
   *
   * @param {number} delay_ms 毫秒。
   * @param {() => void} callback 回调。
   * @returns {void}
   * @private
   */
  private _later(delay_ms: number, callback: () => void): void {
    const timer = globalThis.setTimeout(() => {
      this.timers.delete(timer);
      callback();
    }, delay_ms);
    this.timers.add(timer);
  }
}

/**
 * 构造端口对端描述（供 LLDP 与面板展示）。
 *
 * @param {DeviceRuntime} device 对端设备。
 * @param {PortState} port 对端端口。
 * @returns {object} 对端描述。
 */
function device_peer(
  device: DeviceRuntime,
  port: PortState
): { system_name: string; device_type: string; chassis_id: string; port_id: string } {
  return {
    system_name: device.hostname,
    device_type: device.device_type,
    chassis_id: device.mac_address,
    port_id: port.short_name
  };
}
