/**
 * @File : web/src/core/remote_runtime.ts
 * @Time : 2026-10-05 06:10
 * @Author : Cetrp
 * @Description : 远端运行时：通过 Django + DRF 的 REST/WebSocket 控制平面驱动设备与链路，
 *               并按事件把后端状态投影为本地渲染镜像（契约见 docs/API_CONTRACT.md 与 _V2）。
 */

import { EVENT_TYPE, PORT_STATE, DEVICE_STATE } from './constants';
import { DeviceRuntime } from './device_runtime';
import { get_registry } from '../data/assets';

import type { OpticalSnapshot } from './optical_model';
import type {
  CableRecord,
  CommandResult,
  DeviceSnapshot,
  PingResult,
  PortRef,
  SimlabEvent,
  WirelessSnapshot
} from './runtime_types';
import type { ConsoleOutput, ConsoleSessionInfo, RuntimeClient } from './runtime_types';
import type { EventBus } from './event_bus';

/**
 * 远端运行时。
 */
export class RemoteRuntime implements RuntimeClient {
  /** 后端基地址（不带结尾斜杠）。 */
  private base_url: string;

  /** 事件总线。 */
  private bus: EventBus;

  /** 实验 ID。 */
  private experiment_id: string;

  /** 设备镜像。 */
  private devices = new Map<string, DeviceRuntime>();

  /** 线缆缓存。 */
  private cables: CableRecord[] = [];

  /** WebSocket。 */
  private socket: WebSocket | null = null;

  /** 是否已连接。 */
  private connected = false;

  /** 事件取消订阅函数集合。 */
  private subscriptions: (() => void)[] = [];

  /**
   * @param {object} options 构造参数。
   * @param {string} options.base_url 后端地址，例如 http://127.0.0.1:8020。
   * @param {EventBus} options.bus 事件总线。
   * @param {string} options.experiment_id 实验 ID。
   */
  constructor(options: { base_url: string; bus: EventBus; experiment_id: string }) {
    this.base_url = String(options.base_url).replace(/\/$/, '');
    this.bus = options.bus;
    this.experiment_id = options.experiment_id;
  }

  /**
   * 运行时类型。
   *
   * @returns {'remote'} 类型标识。
   */
  type(): 'remote' {
    return 'remote';
  }

  /**
   * 是否已连接后端。
   *
   * @returns {boolean} 连接状态。
   */
  is_connected(): boolean {
    return this.connected;
  }

  /**
   * 连接后端：探测实验、拉取拓扑、建立事件通道。
   *
   * @returns {Promise<boolean>} 是否连接成功。
   */
  async connect(): Promise<boolean> {
    try {
      let response = await fetch(this.base_url + '/api/v1/experiments/' + this.experiment_id + '/');
      if (response.status === 404) {
        await fetch(this.base_url + '/api/v1/experiments/', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ experiment_id: this.experiment_id, name: '数字孪生演示实验' })
        });
        response = await fetch(this.base_url + '/api/v1/experiments/' + this.experiment_id + '/');
      }
      if (!response.ok) {
        return false;
      }
      const payload = await response.json();
      for (const device of payload.devices || []) {
        this._project_device(device);
      }
      await this.refresh_topology();
      this._open_socket();
      this.connected = true;
      return true;
    } catch (error) {
      this.connected = false;
      return false;
    }
  }

  /**
   * 建立 WebSocket 事件投影。
   *
   * @returns {void}
   * @private
   */
  private _open_socket(): void {
    const ws_url =
      this.base_url.replace(/^http/, 'ws') + '/ws/experiments/' + this.experiment_id + '/';
    try {
      const socket = new WebSocket(ws_url);
      socket.onmessage = (message) => {
        try {
          const payload = JSON.parse(message.data);
          if (payload.type === 'event' && payload.event) {
            this._project_event(payload.event as SimlabEvent);
            this.bus.publish(payload.event as SimlabEvent);
          }
        } catch (error) {
          console.warn('WebSocket 事件解析失败', error);
        }
      };
      socket.onclose = () => {
        this.connected = false;
        this.bus.publish({
          event_type: EVENT_TYPE.LOG_APPENDED,
          experiment_id: this.experiment_id,
          device_id: null,
          timestamp: new Date().toISOString(),
          data: { text: '与控制平面的 WebSocket 连接已断开' }
        });
      };
      this.socket = socket;
    } catch (error) {
      this.connected = false;
    }
  }

  /**
   * 统一请求封装。
   *
   * @param {string} path 路径。
   * @param {object} [options] fetch 选项。
   * @returns {Promise<any>} 响应 JSON。
   * @private
   */
  private async _request(path: string, options?: RequestInit): Promise<any> {
    const response = await fetch(this.base_url + path, {
      headers: { 'Content-Type': 'application/json' },
      ...(options || {})
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      return {
        success: false,
        error_code: payload.error_code || 'HTTP_' + response.status,
        message: payload.message || response.statusText
      };
    }
    return payload;
  }

  /**
   * 刷新拓扑并把设备与线缆投影到本地镜像。
   *
   * @returns {Promise<void>} 完成 Promise。
   */
  async refresh_topology(): Promise<void> {
    const payload = await this._request('/api/v1/experiments/' + this.experiment_id + '/topology/');
    if (payload.success === false) {
      return;
    }
    for (const device of payload.devices || []) {
      this._project_device(device);
    }
    this.cables = payload.cables || [];
  }

  /**
   * 后端设备 → 本地渲染镜像。
   *
   * @param {DeviceSnapshot} payload 设备快照。
   * @returns {DeviceRuntime | null} 镜像设备。
   * @private
   */
  private _project_device(payload: DeviceSnapshot): DeviceRuntime | null {
    const registry = get_registry();
    const manifest = registry.manifest(payload.model_id);
    if (!manifest) {
      return null;
    }
    const existing = this.devices.get(payload.device_id);
    const device =
      existing ||
      new DeviceRuntime({
        device_id: payload.device_id,
        experiment_id: this.experiment_id,
        manifest: manifest,
        vendor_profile: registry.vendor(manifest.vendor_id),
        cli_profile: registry.cli_profile_for_vendor(manifest.vendor_id),
        hostname: payload.hostname
      });
    device.hostname = payload.hostname || device.hostname;
    device.power_state = payload.power_state || device.power_state;
    if (payload.position) {
      device.position = { ...payload.position };
    }
    for (const port_state of payload.ports || []) {
      const port = device.find_port(port_state.short_name);
      if (!port) {
        continue;
      }
      const was_up = port.link_up;
      port.admin_up = port_state.admin_up !== false;
      port.link_up = Boolean(port_state.link_up);
      port.state = port_state.oper_state || (port.link_up ? PORT_STATE.UP : PORT_STATE.DOWN);
      port.speed = port_state.speed || port.speed;
      port.duplex = port_state.duplex || port.duplex;
      port.vlan = port_state.vlan === undefined ? port.vlan : port_state.vlan;
      port.description =
        port_state.description === undefined ? port.description : port_state.description;
      port.poe_enabled = Boolean(port_state.poe_enabled);
      port.mac_count = port_state.mac_count || 0;
      port.rx_pkts = port_state.rx_pkts || 0;
      port.tx_pkts = port_state.tx_pkts || 0;
      port.crc_errors = port_state.crc_errors || 0;
      port.plugged = Boolean(port_state.cable_id) || port.peer_device_id != null;
      port.peer_device_id = port_state.peer_device_id || null;
      port.peer_port = port_state.peer_port || null;
      if (port_state.cable_id) {
        port.cable = {
          cable_id: port_state.cable_id,
          cable_type: 'ETHERNET_COPPER',
          state: port.link_up ? 'UP' : 'DOWN'
        };
      }
      if (!was_up && port.link_up) {
        port.last_change_at = Date.now();
      }
    }
    this.devices.set(payload.device_id, device);
    return device;
  }

  /**
   * 事件投影：远端事件同步到本地镜像。
   *
   * @param {SimlabEvent} event 事件。
   * @returns {void}
   * @private
   */
  private _project_event(event: SimlabEvent): void {
    const data = event.data || {};
    const device = event.device_id ? this.devices.get(event.device_id) : null;
    if (!device) {
      return;
    }
    switch (event.event_type) {
      case EVENT_TYPE.PORT_LINK_CHANGED: {
        const port = device.find_port(data.port);
        if (port) {
          port.link_up = data.to === PORT_STATE.UP;
          port.state = data.to;
          port.speed = data.speed || port.speed;
        }
        break;
      }
      case EVENT_TYPE.PORT_ADMIN_CHANGED: {
        const port = device.find_port(data.port);
        if (port) {
          port.admin_up = Boolean(data.admin_up);
        }
        break;
      }
      case EVENT_TYPE.PORT_CONFIG_CHANGED: {
        const port = device.find_port(data.port);
        if (port) {
          if (data.changes) {
            Object.assign(port, data.changes);
          } else if (data.field) {
            port[data.field] = data.to;
          }
        } else if (data.field === 'hostname' && data.to) {
          device.hostname = data.to;
        }
        break;
      }
      case EVENT_TYPE.CABLE_CONNECTED: {
        const port = device.find_port(data.port);
        if (port) {
          port.plugged = true;
          port.cable = {
            cable_id: data.cable_id || event.event_id,
            cable_type: data.cable_type || 'ETHERNET_COPPER',
            state: 'CONNECTING'
          };
          port.peer_device_id = data.target_device_id || null;
          port.peer_port = data.target_port || null;
        }
        break;
      }
      case EVENT_TYPE.CABLE_DISCONNECTED: {
        const port = device.find_port(data.port);
        if (port) {
          port.plugged = false;
          port.link_up = false;
          port.cable = null;
          port.peer_device_id = null;
          port.peer_port = null;
        }
        break;
      }
      case EVENT_TYPE.DEVICE_STATE_CHANGED: {
        device.power_state = data.to;
        if (data.to === DEVICE_STATE.RUNNING) {
          device.boot_progress = 1;
        }
        break;
      }
      case EVENT_TYPE.DEVICE_BOOT_PROGRESS: {
        device.boot_progress = data.progress || device.boot_progress;
        if (data.line) {
          device.push_log(data.line);
        }
        break;
      }
      case EVENT_TYPE.DEVICE_MOVED: {
        if (data.position) {
          device.position = { ...data.position };
        }
        break;
      }
      case EVENT_TYPE.CONFIG_SAVED: {
        device.config_saved = true;
        device.config_dirty = false;
        break;
      }
      case EVENT_TYPE.FAULT_INJECTED: {
        const port = device.find_port(data.port);
        if (port && data.fault_type === 'cable_broken') {
          port.plugged = false;
          port.link_up = false;
        }
        break;
      }
      default:
        break;
    }
  }

  /* ------------------------------ RuntimeClient 实现 ------------------------------ */

  /**
   * 设备镜像列表。
   *
   * @returns {DeviceRuntime[]} 设备数组。
   */
  list_devices(): DeviceRuntime[] {
    return [...this.devices.values()];
  }

  /**
   * 查询设备镜像。
   *
   * @param {string} device_id 设备 ID。
   * @returns {DeviceRuntime | null} 设备。
   */
  get_device(device_id: string): DeviceRuntime | null {
    return this.devices.get(device_id) || null;
  }

  /**
   * 设备快照。
   *
   * @returns {DeviceSnapshot[]} 快照。
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
        vlan: port.vlan,
        description: port.description,
        cable_id: port.cable ? port.cable.cable_id : null,
        peer_device_id: port.peer_device_id || null,
        peer_port: port.peer_port || null
      }))
    }));
  }

  /**
   * 线缆快照。
   *
   * @returns {CableRecord[]} 线缆数组。
   */
  cables_snapshot(): CableRecord[] {
    /* 防御性归一化：个别后端版本在协商完成后未回写 cable.state，
       此时按两端端口的真实链路状态推导，避免前端显示"端口 UP 但线缆 DOWN"。 */
    return this.cables.map((cable) => {
      let state = cable.state;
      if (cable.target) {
        const from_device = this.devices.get(cable.source.device_id);
        const to_device = this.devices.get(cable.target.device_id);
        const from_port = from_device ? from_device.find_port(cable.source.port) : null;
        const to_port = to_device ? to_device.find_port(cable.target.port) : null;
        if (from_port && to_port && from_port.link_up && to_port.link_up) {
          state = 'UP';
        }
      }
      return { ...cable, state: state };
    });
  }

  /**
   * 创建设备。
   *
   * @param {string} model_id 型号 ID。
   * @param {string} [hostname] 设备名。
   * @returns {Promise<CommandResult>} 命令结果。
   */
  async create_device(model_id: string, hostname?: string): Promise<CommandResult> {
    const payload = await this._request('/api/v1/experiments/' + this.experiment_id + '/devices/', {
      method: 'POST',
      body: JSON.stringify({ model_id: model_id, hostname: hostname })
    });
    if (payload.success === false) {
      return payload;
    }
    const device_payload = payload.device || payload;
    const device = this._project_device(device_payload);
    return {
      success: Boolean(device),
      command_id: payload.command_id,
      command_type: 'CreateDevice',
      data: { device_id: device ? device.device_id : null, device: device }
    };
  }

  /**
   * 删除设备。
   *
   * @param {string} device_id 设备 ID。
   * @returns {Promise<CommandResult>} 命令结果。
   */
  async delete_device(device_id: string): Promise<CommandResult> {
    const payload = await this._request('/api/v1/devices/' + device_id + '/', { method: 'DELETE' });
    this.devices.delete(device_id);
    return { success: payload.success !== false, ...payload };
  }

  /**
   * 开关机。
   *
   * @param {string} device_id 设备 ID。
   * @param {boolean} is_on 是否开机。
   * @returns {Promise<CommandResult>} 命令结果。
   */
  async power(device_id: string, is_on: boolean): Promise<CommandResult> {
    const payload = await this._request('/api/v1/devices/' + device_id + '/power/', {
      method: 'POST',
      body: JSON.stringify({ on: is_on })
    });
    return { success: payload.success !== false, ...payload };
  }

  /**
   * 移动设备。
   *
   * @param {string} device_id 设备 ID。
   * @param {object} position 位置。
   * @returns {Promise<CommandResult>} 命令结果。
   */
  async move_device(
    device_id: string,
    position: { x: number; y: number; z: number }
  ): Promise<CommandResult> {
    const payload = await this._request('/api/v1/devices/' + device_id + '/position/', {
      method: 'PATCH',
      body: JSON.stringify({ position: position })
    });
    const device = this.devices.get(device_id);
    if (device) {
      device.position = { ...position };
    }
    return { success: payload.success !== false, ...payload };
  }

  /**
   * 设备间连线。
   *
   * @param {PortRef} source 源端口。
   * @param {PortRef} [target] 目标端口。
   * @param {string} [cable_type] 线缆类型。
   * @returns {Promise<CommandResult>} 命令结果。
   */
  async connect_cable(
    source: PortRef,
    target?: PortRef,
    cable_type?: string
  ): Promise<CommandResult> {
    const body: Record<string, unknown> = {
      source_device_id: source.device_id,
      source_port: source.port,
      cable_type: cable_type
    };
    if (target) {
      body.target_device_id = target.device_id;
      body.target_port = target.port;
    }
    const payload = await this._request('/api/v1/experiments/' + this.experiment_id + '/cables/', {
      method: 'POST',
      body: JSON.stringify(body)
    });
    if (payload.success !== false) {
      await this.refresh_topology();
    }
    return { success: payload.success !== false, ...payload };
  }

  /**
   * 拔线。
   *
   * @param {string} cable_id 线缆 ID。
   * @returns {Promise<CommandResult>} 命令结果。
   */
  async disconnect_cable(cable_id: string): Promise<CommandResult> {
    const payload = await this._request('/api/v1/cables/' + cable_id + '/', { method: 'DELETE' });
    if (payload.success !== false) {
      await this.refresh_topology();
    }
    return { success: payload.success !== false, ...payload };
  }

  /**
   * 端口配置。
   *
   * @param {string} device_id 设备 ID。
   * @param {string} port 端口短名。
   * @param {Record<string, unknown>} changes 变更。
   * @returns {Promise<CommandResult>} 命令结果。
   */
  async configure_port(
    device_id: string,
    port: string,
    changes: Record<string, unknown>
  ): Promise<CommandResult> {
    const payload = await this._request(
      '/api/v1/devices/' + device_id + '/ports/' + encodeURIComponent(port) + '/',
      { method: 'PATCH', body: JSON.stringify(changes) }
    );
    return { success: payload.success !== false, ...payload };
  }

  /**
   * 故障注入。
   *
   * @param {string} device_id 设备 ID。
   * @param {string | null} port 端口。
   * @param {string} fault_type 故障类型。
   * @returns {Promise<CommandResult>} 命令结果。
   */
  async inject_fault(
    device_id: string,
    port: string | null,
    fault_type: string
  ): Promise<CommandResult> {
    const payload = await this._request('/api/v1/devices/' + device_id + '/faults/', {
      method: 'POST',
      body: JSON.stringify({ port: port, fault_type: fault_type })
    });
    return { success: payload.success !== false, ...payload };
  }

  /**
   * 保存配置。
   *
   * @param {string} device_id 设备 ID。
   * @returns {Promise<CommandResult>} 命令结果。
   */
  async save_config(device_id: string): Promise<CommandResult> {
    const payload = await this._request('/api/v1/devices/' + device_id + '/save-config/', {
      method: 'POST'
    });
    return { success: payload.success !== false, ...payload };
  }

  /**
   * 打开控制台会话。
   *
   * @param {string} device_id 设备 ID。
   * @returns {Promise<ConsoleSessionInfo>} 会话信息。
   */
  async console_open(device_id: string): Promise<ConsoleSessionInfo> {
    const payload = await this._request('/api/v1/devices/' + device_id + '/console-sessions/', {
      method: 'POST'
    });
    return payload;
  }

  /**
   * 控制台输入。
   *
   * @param {string} session_id 会话 ID。
   * @param {string} input 输入。
   * @returns {Promise<ConsoleOutput>} 回显。
   */
  async console_write(session_id: string, input: string): Promise<ConsoleOutput> {
    const payload = await this._request('/api/v1/console-sessions/' + session_id + '/input/', {
      method: 'POST',
      body: JSON.stringify({ input: input })
    });
    return {
      success: payload.success !== false,
      lines: payload.lines || [],
      prompt: payload.prompt || '',
      mode: payload.mode || 'user',
      message: payload.message
    };
  }

  /**
   * 控制台补全。
   *
   * @param {string} session_id 会话 ID。
   * @param {string} input 输入。
   * @returns {Promise<string[]>} 候选。
   */
  async console_complete(session_id: string, input: string): Promise<string[]> {
    const payload = await this._request(
      '/api/v1/console-sessions/' + session_id + '/complete/?input=' + encodeURIComponent(input)
    );
    return payload.candidates || [];
  }

  /**
   * 关闭控制台会话。
   *
   * @param {string} session_id 会话 ID。
   * @returns {Promise<CommandResult>} 命令结果。
   */
  async console_close(session_id: string): Promise<CommandResult> {
    const payload = await this._request('/api/v1/console-sessions/' + session_id + '/', {
      method: 'DELETE'
    });
    return { success: payload.success !== false, ...payload };
  }

  /**
   * 端到端连通性测试。
   *
   * @param {string} source_device_id 源设备。
   * @param {object} target 目标。
   * @param {number} [count] 次数。
   * @returns {Promise<PingResult>} 结果。
   */
  async ping(
    source_device_id: string,
    target: { device_id?: string; ip?: string },
    count = 4
  ): Promise<PingResult> {
    const payload = await this._request('/api/v1/experiments/' + this.experiment_id + '/ping/', {
      method: 'POST',
      body: JSON.stringify({
        source_device_id: source_device_id,
        target: { device_id: target.device_id },
        target_ip: target.ip,
        count: count
      })
    });
    if (
      payload &&
      payload.success !== false &&
      payload.reachable &&
      Array.isArray(payload.path) &&
      payload.path.length > 1 &&
      (!Array.isArray(payload.hops) || payload.hops.length === 0)
    ) {
      payload.hops = this._synthesize_hops(payload.path, payload.hops || []);
    }
    return payload;
  }

  /**
   * 依据拓扑合成逐跳路径（后端未返回 hops 时的兜底，字段含义与契约 §4 一致）。
   *
   * @param {string[]} path 设备路径。
   * @param {object[]} existing 后端已返回的 hops。
   * @returns {object[]} 逐跳记录。
   * @private
   */
  private _synthesize_hops(
    path: string[],
    existing: { device_id: string; in_port: string | null; out_port: string | null }[]
  ): {
    device_id: string;
    in_port: string | null;
    out_port: string | null;
    mac_learned?: string;
    vlan?: number;
  }[] {
    const hops: {
      device_id: string;
      in_port: string | null;
      out_port: string | null;
      mac_learned?: string;
      vlan?: number;
    }[] = path.map((device_id) => ({ device_id: device_id, in_port: null, out_port: null }));
    for (let index = 0; index < path.length - 1; index += 1) {
      const left = path[index];
      const right = path[index + 1];
      const cable = this.cables.find(
        (item) =>
          item.target &&
          ((item.source.device_id === left && item.target.device_id === right) ||
            (item.source.device_id === right && item.target.device_id === left))
      );
      if (!cable || !cable.target) {
        continue;
      }
      hops[index].out_port =
        cable.source.device_id === left ? cable.source.port : cable.target.port;
      hops[index + 1].in_port =
        cable.source.device_id === right ? cable.source.port : cable.target.port;
    }
    for (const hop of hops) {
      const device = this.devices.get(hop.device_id);
      if (device) {
        hop.mac_learned = device.mac_address;
      }
      const existing_hop = existing.find((item) => item.device_id === hop.device_id);
      if (existing_hop) {
        hop.in_port = hop.in_port || existing_hop.in_port;
        hop.out_port = hop.out_port || existing_hop.out_port;
      }
    }
    return hops;
  }

  /**
   * 重命名设备（调用控制平面 PATCH /devices/{id}/）。
   *
   * @param {string} device_id 设备 ID。
   * @param {string} hostname 新主机名。
   * @returns {Promise<CommandResult>} 命令结果。
   */
  async rename_device(device_id: string, hostname: string): Promise<CommandResult> {
    const payload = await this._request('/api/v1/devices/' + device_id + '/', {
      method: 'PATCH',
      body: JSON.stringify({ hostname: hostname })
    });
    if (payload.success !== false && this.devices.has(device_id)) {
      const device = this.devices.get(device_id);
      if (device) {
        device.hostname = hostname;
      }
    }

    return { success: payload.success !== false, ...payload };
  }

  /**
   * 光链路状态快照（后端由独立光仿真进程提供）。
   *
   * @returns {Promise<OpticalSnapshot>} 快照。
   */
  async optical_snapshot(): Promise<OpticalSnapshot> {
    const payload = await this._request('/api/v1/experiments/' + this.experiment_id + '/optical/');
    if (payload.success === false) {
      return {
        success: false,
        runtime: { adapter: 'unavailable', process: '-', alive: false, c_lib: false },
        olts: [],
        links: [],
        alarms: []
      };
    }
    return payload as OpticalSnapshot;
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
    const payload = await this._request('/api/v1/devices/' + onu_device_id + '/optical/fiber/', {
      method: 'POST',
      body: JSON.stringify(options)
    });
    return { success: payload.success !== false, ...payload };
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
    const payload = await this._request('/api/v1/devices/' + onu_device_id + '/optical/traffic/', {
      method: 'POST',
      body: JSON.stringify(traffic)
    });
    return { success: payload.success !== false, ...payload };
  }

  /**
   * 无线状态快照。
   *
   * @returns {Promise<WirelessSnapshot>} 快照。
   */
  async wireless_snapshot(): Promise<WirelessSnapshot> {
    const payload = await this._request('/api/v1/experiments/' + this.experiment_id + '/wireless/');
    return payload;
  }

  /**
   * 关联 AP。
   *
   * @param {string} sta_device_id STA。
   * @param {string} [ap_device_id] AP。
   * @returns {Promise<CommandResult>} 命令结果。
   */
  async associate(sta_device_id: string, ap_device_id?: string): Promise<CommandResult> {
    const payload = await this._request(
      '/api/v1/devices/' + sta_device_id + '/wireless/associate/',
      { method: 'POST', body: JSON.stringify({ ap_device_id: ap_device_id }) }
    );
    return { success: payload.success !== false, ...payload };
  }

  /**
   * 解除无线关联。
   *
   * @param {string} sta_device_id STA。
   * @returns {Promise<CommandResult>} 命令结果。
   */
  async disassociate(sta_device_id: string): Promise<CommandResult> {
    const payload = await this._request(
      '/api/v1/devices/' + sta_device_id + '/wireless/disassociate/',
      { method: 'POST' }
    );
    return { success: payload.success !== false, ...payload };
  }

  /**
   * 远端模式下前端不做物理推进（事件驱动）。
   *
   * @param {number} delta_seconds 时间增量。
   * @returns {void}
   */
  tick(delta_seconds: number): void {
    for (const device of this.devices.values()) {
      device.update_environment(delta_seconds);
    }
  }

  /**
   * 订阅事件（本地事件总线 + 远端 WebSocket 事件都会进入总线）。
   *
   * @param {(event: SimlabEvent) => void} handler 处理函数。
   * @returns {() => void} 取消订阅。
   */
  on_event(handler: (event: SimlabEvent) => void): () => void {
    const unsubscribe = this.bus.subscribe('*', handler);
    this.subscriptions.push(unsubscribe);
    return unsubscribe;
  }

  /**
   * 关闭连接。
   *
   * @returns {void}
   */
  dispose(): void {
    for (const unsubscribe of this.subscriptions) {
      unsubscribe();
    }
    this.subscriptions = [];
    if (this.socket) {
      try {
        this.socket.close();
      } catch (error) {
        console.warn('关闭 WebSocket 失败', error);
      }
    }
    this.devices.clear();
  }
}
