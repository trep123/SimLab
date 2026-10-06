/**
 * @File : web/src/core/device_runtime.ts
 * @Time : 2026-10-04 09:35
 * @Author : Cetrp
 * @Description : 设备运行时状态模型（端口、VLAN、MAC、ARP、路由、环境量），命令行引擎与三维投影共用
 * 。
 */

import { utils, PORT_STATE, DEVICE_STATE, SPEED_TEXT } from './constants';
import { expand_ports } from '../data/spec_loader';
import type { CliProfile, DeviceManifest, PortState, VendorProfile } from '../data/types';

/** 运行时速率为显示值，数据档案中常用裸数值键，此处做一次归一化映射。 */
const SPEED_NUMERIC_KEY = {
  '10M': '10',
  '100M': '100',
  '1000M': '1000',
  '10G': '10000',
  '40G': '40000'
};

/** 链路 LED 活动强度的基准速率。 */
const TRAFFIC_BASE_RATE = { '10G': 8.0, '1000M': 4.0, '100M': 1.5, '10M': 0.8 };

/** 模拟邻居设备名池，用于 LLDP 与流量对端展示。 */
const PEER_NAME_POOL = [
  'PC-101',
  'PC-102',
  'PC-103',
  'SRV-APP-01',
  'SRV-DB-01',
  'AP-301',
  'SW-ACC-02',
  'SW-ACC-03',
  'RT-CORE-01',
  'FW-EDGE-01'
];

/** 邻居设备类型池，与名称池一一对应。 */
const PEER_TYPE_POOL = [
  'PC',
  'PC',
  'PC',
  'Server',
  'Server',
  'WLAN-AP',
  'Switch',
  'Switch',
  'Router',
  'Firewall'
];

/**
 * 由设备 ID 生成稳定的 MAC 地址。
 *
 * @param {string} device_id 设备 ID。
 * @param {number} offset 偏移序号。
 * @returns {string} 形如 00:1B:44:11:3A:B7。
 */
function make_mac(device_id, offset) {
  const base = utils.seeded_random(device_id + ':' + offset);
  const tail = Math.floor(base * 0xffffff)
    .toString(16)
    .padStart(6, '0')
    .toUpperCase();
  return '00:1B:44:' + tail.slice(0, 2) + ':' + tail.slice(2, 4) + ':' + tail.slice(4, 6);
}

/**
 * 生成设备序列号。
 *
 * @param {object} manifest 设备 Manifest。
 * @param {string} device_id 设备 ID。
 * @returns {string} 序列号。
 */
function make_serial(manifest, device_id) {
  const prefix = manifest.serial_prefix || '210235';
  const seed = utils.seeded_random(device_id + ':serial');
  const tail = String(Math.floor(seed * 99999999)).padStart(8, '0');
  return prefix + tail;
}

/**
 * 设备运行时实例：保存设备全部可变状态，并提供只读投影。
 */
class DeviceRuntime {
  /** 设备实例 ID。 */
  device_id: string;

  /** 实验 ID。 */
  experiment_id: string;

  /** 型号 ID。 */
  model_id: string;

  /** 厂商 ID。 */
  vendor_id: string;

  /** 设备类型。 */
  device_type: string;

  /** 设备 Manifest。 */
  manifest: DeviceManifest;

  /** 厂商档案。 */
  vendor_profile: VendorProfile;

  /** CLI 档案。 */
  cli_profile: CliProfile;

  /** 展示名。 */
  display_name: string;

  /** 产品名。 */
  product_name: string;

  /** 设备类别。 */
  device_class: string;

  /** 系统版本。 */
  os_version: string;

  /** 软件版本（厂商档案优先）。 */
  software_version: string;

  /** 序列号。 */
  serial_number: string;

  /** 管理 MAC。 */
  mac_address: string;

  /** 设备名。 */
  hostname: string;

  /** 电源状态。 */
  power_state: string;

  /** 开机进度。 */
  boot_progress: number;

  /** 运行时长（秒）。 */
  uptime_seconds: number;

  /** 配置已保存。 */
  config_saved: boolean;

  /** 配置版本号。 */
  config_revision: number;

  /** 配置有未保存改动。 */
  config_dirty: boolean;

  /** 场景坐标（米）。 */
  position: { x: number; y: number; z: number };

  /** 环境量。 */
  environment: {
    temperature: number;
    fan_status: string;
    power_status: string;
    fan_level: number;
  };

  /** 设备日志缓冲。 */
  log_buffer: { timestamp: string; level: string; text: string }[];

  /** VLAN 表。 */
  vlans: Map<number, { vlan_id: number; name: string; description: string; ports: string[] }>;

  /** 三层接口表。 */
  vlan_interfaces: Map<
    number,
    { vlan_id: number; ip_address: string; mask: string; prefix_length: number }
  >;

  /** 静态 / 直连路由。 */
  routes: Record<string, unknown>[];

  /** ARP 表。 */
  arp_table: Record<string, unknown>[];

  /** 端口列表。 */
  ports: PortState[];

  /** 邻居名缓存。 */
  private _peer_names: Map<string, string>;

  /** 邻居类型缓存。 */
  private _peer_types: Map<string, string>;

  /** MAC 表刷新计时。 */
  private _mac_timer?: number;

  /**
   * @param {object} options 构造参数。
   * @param {string} options.device_id 设备实例 ID。
   * @param {object} options.manifest 设备 Manifest。
   * @param {object} options.vendor_profile 厂商档案。
   * @param {object} options.cli_profile CLI 档案。
   * @param {string} options.experiment_id 实验 ID。
   * @param {string} [options.hostname] 初始设备名。
   */
  constructor(options) {
    const manifest = options.manifest;
    const vendor_profile = options.vendor_profile || {};
    const cli_profile = options.cli_profile || {};

    this.device_id = options.device_id;
    this.experiment_id = options.experiment_id || 'exp-default';
    this.model_id = manifest.model_id;
    this.vendor_id = manifest.vendor_id;
    this.device_type = manifest.device_type;
    this.manifest = manifest;
    this.vendor_profile = vendor_profile;
    this.cli_profile = cli_profile;
    this.display_name = manifest.display_name;
    this.product_name = manifest.product_name || manifest.display_name;
    this.device_class = manifest.device_class || '';
    this.os_version = manifest.os_version || vendor_profile.os_version || '';
    this.serial_number = make_serial(manifest, options.device_id);
    this.mac_address = make_mac(options.device_id, 0);
    this.hostname = options.hostname || this._default_hostname(manifest);
    this.software_version = vendor_profile.os_version || this.os_version;

    this.power_state = DEVICE_STATE.OFF;
    this.boot_progress = 0;
    this.uptime_seconds = 0;
    this.config_saved = true;
    this.config_revision = 1;
    this.config_dirty = false;
    /** 场景坐标（米），由 MoveDevice 命令更新。 */
    this.position = { x: 0, y: 0, z: 0 };

    this.environment = {
      temperature: 24.0,
      fan_status: 'Normal',
      power_status: 'Normal',
      fan_level: 0
    };

    this.log_buffer = [];
    this.vlans = new Map();
    this.vlan_interfaces = new Map();
    this.routes = [];
    this.arp_table = [];
    this._peer_names = new Map();
    this._peer_types = new Map();

    this.ports = expand_ports(manifest).map((definition) => this._build_port(definition));
    this._default_vlan();
    this.reset_counters();
  }

  /**
   * 依据厂商与型号推导默认设备名。
   *
   * @param {object} manifest 设备 Manifest。
   * @returns {string} 默认设备名。
   * @private
   */
  _default_hostname(manifest) {
    const prefix_map = {
      switch: 'Switch',
      l3switch: 'L3Switch',
      router: 'Router',
      firewall: 'Firewall',
      ap: 'AP',
      pc: 'PC',
      server: 'Server'
    };
    const prefix = prefix_map[manifest.device_type] || 'Device';
    return prefix;
  }

  /**
   * 构造端口运行时状态。
   *
   * @param {object} definition 端口定义。
   * @returns {object} 端口运行时对象。
   * @private
   */
  _build_port(definition) {
    const speed_key = SPEED_TEXT[definition.speed_bps] || '1000M';
    return Object.assign({}, definition, {
      state: PORT_STATE.DOWN,
      admin_up: true,
      link_up: false,
      plugged: false,
      cable: null,
      speed: definition.kind === 'sfp' || definition.kind === 'sfp_plus' ? '10G' : speed_key,
      speed_mode: 'auto',
      duplex: 'full',
      vlan: 1,
      mode: 'access',
      trunk_vlans: [],
      description: '',
      poe_enabled: false,
      poe_watts: 0,
      rx_pkts: 0,
      tx_pkts: 0,
      rx_bytes: 0,
      tx_bytes: 0,
      in_errors: 0,
      out_errors: 0,
      crc_errors: 0,
      mac_count: 0,
      in_uti: 0,
      out_uti: 0,
      mtu: 1500,
      last_change_at: Date.now(),
      blink_phase: utils.rnd(0, 6),
      traffic_rate: 0,
      macs: []
    });
  }

  /**
   * 初始化默认 VLAN。
   *
   * @returns {void}
   * @private
   */
  _default_vlan() {
    this.vlans.set(1, {
      vlan_id: 1,
      name: 'VLAN 001',
      description: 'default vlan',
      ports: this.ports.map((port) => port.short_name)
    });
  }

  /**
   * 清空全部端口计数。
   *
   * @returns {void}
   */
  reset_counters() {
    for (const port of this.ports) {
      port.rx_pkts = 0;
      port.tx_pkts = 0;
      port.rx_bytes = 0;
      port.tx_bytes = 0;
      port.in_errors = 0;
      port.out_errors = 0;
      port.crc_errors = 0;
    }
  }

  /**
   * 按名称查找端口，支持完整名、短名、别名与大小写/空格差异。
   *
   * @param {string} query 端口查询串。
   * @returns {object|null} 端口对象。
   */
  find_port(query) {
    if (!query) {
      return null;
    }
    const normalized = String(query).replace(/\s+/g, '').toLowerCase();
    for (const port of this.ports) {
      const candidates = [port.id, port.name, port.short_name, port.alias];
      for (const candidate of candidates) {
        if (candidate && candidate.replace(/\s+/g, '').toLowerCase() === normalized) {
          return port;
        }
      }
    }
    for (const port of this.ports) {
      const candidates = [port.name, port.short_name, port.alias];
      for (const candidate of candidates) {
        const value = candidate.replace(/\s+/g, '').toLowerCase();
        if (value.endsWith(normalized) && normalized.length >= 3) {
          return port;
        }
      }
    }
    return null;
  }

  /**
   * 该端口当前是否已建立链路。
   *
   * @param {object} port 端口对象。
   * @returns {boolean} 链路是否 UP。
   */
  is_link_up(port) {
    return (
      Boolean(port) && this.power_state === DEVICE_STATE.RUNNING && port.admin_up && port.link_up
    );
  }

  /**
   * 端口速率是否属于光口。
   *
   * @param {object} port 端口对象。
   * @returns {boolean} 是否为光口。
   */
  is_optical(port) {
    return Boolean(port) && (port.kind === 'sfp' || port.kind === 'sfp_plus');
  }

  /**
   * 为端口分配模拟邻居（LLDP 与流量对端使用）。
   *
   * @param {object} port 端口对象。
   * @returns {object} 邻居信息。
   */
  peer_of(port) {
    if (!this._peer_names.has(port.short_name)) {
      const index = this.ports.indexOf(port);
      const pool_index =
        (index + Math.floor(utils.seeded_random(this.device_id + port.short_name) * 10)) %
        PEER_NAME_POOL.length;
      this._peer_names.set(port.short_name, PEER_NAME_POOL[pool_index]);
      this._peer_types.set(port.short_name, PEER_TYPE_POOL[pool_index]);
    }
    return {
      system_name: this._peer_names.get(port.short_name),
      device_type: this._peer_types.get(port.short_name),
      chassis_id: make_mac(this.device_id, port.index + 100),
      port_id: port.short_name,
      ttl: 120,
      capability: this._peer_types.get(port.short_name)
    };
  }

  /**
   * 端口状态文本（按厂商措辞）。
   *
   * @param {object} port 端口对象。
   * @returns {object} 含 phy_text、protocol_text 等字段。
   */
  port_text(port) {
    const status_text = (this.cli_profile && this.cli_profile.status_text) || {};
    let phy_text = status_text.phy_down || 'down';
    if (!port.admin_up) {
      phy_text = status_text.phy_admin_down || 'down';
    } else if (this.is_link_up(port)) {
      phy_text = status_text.phy_up || 'up';
    }
    const protocol_text = this.is_link_up(port)
      ? status_text.protocol_up || 'up'
      : status_text.protocol_down || 'down';
    const speed_map = status_text.speed || {};
    const duplex_map = status_text.duplex || {};
    const type_map = status_text.type || {};
    const poe_map = status_text.poe || {};
    const kind_key = port.kind === 'sfp' || port.kind === 'sfp_plus' ? 'sfp' : 'rj45';
    /* 数据档案的键是裸速率（"1000"/"10000"），运行时是显示值（"1000M"/"10G"），两种口径都要命中。 */
    const speed_numeric = SPEED_NUMERIC_KEY[port.speed] || port.speed;
    return {
      phy_text: phy_text,
      protocol_text: protocol_text,
      speed_text: speed_map[port.speed] || speed_map[speed_numeric] || port.speed,
      duplex_text: duplex_map[port.duplex] || port.duplex,
      type_text: type_map[kind_key] || port.type,
      poe_text: poe_map[port.poe_enabled ? 'enabled' : 'disabled'] || String(port.poe_enabled)
    };
  }

  /**
   * 更新环境量（温度、风扇）。
   *
   * @param {number} delta_seconds 时间增量（秒）。
   * @returns {void}
   */
  update_environment(delta_seconds) {
    const running = this.power_state === DEVICE_STATE.RUNNING;
    const up_ports = this.ports.filter((port) => this.is_link_up(port)).length;
    const poe_load = this.ports.reduce(
      (sum, port) => sum + (port.poe_enabled ? port.poe_watts : 0),
      0
    );
    const target = running ? 30 + up_ports * 0.55 + poe_load * 0.18 : 24;
    this.environment.temperature = utils.lerp(
      this.environment.temperature,
      target + utils.rnd(-0.4, 0.4),
      Math.min(1, delta_seconds * 0.4)
    );
    const load_ratio = utils.clamp((this.environment.temperature - 32) / 26, 0, 1);
    this.environment.fan_level = running ? utils.lerp(0.35, 1, load_ratio) : 0;
    this.environment.fan_status = this.environment.temperature > 72 ? 'Abnormal' : 'Normal';
    this.environment.power_status = 'Normal';
  }

  /**
   * 推进端口计数与流量占用（仅在设备运行且链路 UP 时增长）。
   *
   * @param {number} delta_seconds 时间增量（秒）。
   * @returns {void}
   */
  update_traffic(delta_seconds) {
    const running = this.power_state === DEVICE_STATE.RUNNING;
    for (const port of this.ports) {
      const up = this.is_link_up(port);
      if (!up) {
        port.in_uti = 0;
        port.out_uti = 0;
        port.traffic_rate = 0;
        port.blink_phase += delta_seconds;
        continue;
      }
      const rate = TRAFFIC_BASE_RATE[port.speed] || 2.0;
      port.blink_phase += delta_seconds * (1.2 + rate * 0.25);
      port.traffic_rate = utils.lerp(
        port.traffic_rate,
        utils.clamp(rate * utils.rnd(0.55, 1.35), 0.05, 9.6),
        0.3
      );
      const packets = Math.max(1, Math.floor(port.traffic_rate * 1200 * delta_seconds));
      port.rx_pkts += packets;
      port.tx_pkts += Math.floor(packets * utils.rnd(0.7, 1.2));
      port.rx_bytes += packets * 1024;
      port.tx_bytes += packets * 900;
      port.in_uti = utils.clamp((port.traffic_rate / (port.speed === '10G' ? 10 : 1)) * 100, 0, 99);
      port.out_uti = utils.clamp(port.in_uti * utils.rnd(0.6, 1.15), 0, 99);
      /* 健康链路偶发 CRC 错误：概率极低，避免正常实验被误判为故障。 */
      if (Math.random() < 0.00004 * delta_seconds * 60) {
        port.crc_errors += 1;
        port.in_errors += 1;
      }
    }
    if (running) {
      this.uptime_seconds += delta_seconds;
      this._mac_timer = (this._mac_timer || 0) + delta_seconds;
      if (this._mac_timer >= 2) {
        this._mac_timer = 0;
        this.refresh_mac_table();
      }
    }
  }

  /**
   * 重新学习端口 MAC 表项。
   *
   * @returns {void}
   */
  refresh_mac_table() {
    for (const port of this.ports) {
      if (!this.is_link_up(port)) {
        port.macs = [];
        port.mac_count = 0;
        continue;
      }
      /* 目标表项数随链路存活时间缓慢增长，避免每次刷新都随机抖动。 */
      const target = Math.min(8, 1 + Math.floor(this.uptime_seconds / 15) + (port.index % 3));
      while (port.macs.length < target) {
        const slot = port.macs.length;
        port.macs.push({
          mac_address: make_mac(this.device_id, port.index * 10 + slot + 1),
          vlan_id: port.vlan,
          type_text: 'dynamic',
          port_name: port.short_name,
          age_seconds: 0,
          age_text: '0'
        });
      }
      if (port.macs.length > target) {
        port.macs.splice(target);
      }
      for (const entry of port.macs) {
        entry.age_seconds += 2;
        entry.age_text = String(Math.floor(entry.age_seconds));
        entry.vlan_id = port.vlan;
      }
      port.mac_count = port.macs.length;
    }
  }

  /**
   * 汇总 MAC 表（任务书表格行模型）。
   *
   * @returns {object[]} MAC 表行。
   */
  mac_rows() {
    this.refresh_mac_table();
    const rows = [];
    for (const port of this.ports) {
      for (const entry of port.macs) {
        rows.push(entry);
      }
    }
    return rows;
  }

  /**
   * 汇总 ARP 表。
   *
   * @returns {object[]} ARP 行。
   */
  arp_rows() {
    const rows = [];
    for (const [vlan_id, vlan_interface] of this.vlan_interfaces.entries()) {
      if (!vlan_interface.ip_address) {
        continue;
      }
      rows.push({
        ip_address: vlan_interface.ip_address,
        mac_address: this.mac_address,
        expire_text: '-',
        type_text: 'Interface',
        interface: 'Vlanif' + vlan_id
      });
      const port = this.ports.find((item) => item.vlan === vlan_id && this.is_link_up(item));
      if (port) {
        const peer = this.peer_of(port);
        rows.push({
          ip_address: vlan_interface.ip_address.replace(/\.\d+$/, '.1'),
          mac_address: peer.chassis_id,
          expire_text: String(Math.floor(utils.rnd(3, 19))),
          type_text: 'Dynamic',
          interface: port.short_name
        });
      }
    }
    return rows;
  }

  /**
   * 汇总路由表。
   *
   * @returns {object[]} 路由行。
   */
  route_rows() {
    const rows = [
      {
        destination: '0.0.0.0',
        mask: '0.0.0.0',
        nexthop: '0.0.0.0',
        interface: 'NULL0',
        protocol_text: 'Static',
        preference: 60,
        metric: 0
      }
    ];
    for (const [vlan_id, vlan_interface] of this.vlan_interfaces.entries()) {
      if (!vlan_interface.ip_address) {
        continue;
      }
      const octets = vlan_interface.ip_address.split('.');
      rows.push({
        destination: octets.slice(0, 3).join('.') + '.0',
        mask: '255.255.255.0',
        nexthop: vlan_interface.ip_address,
        interface: 'Vlanif' + vlan_id,
        protocol_text: 'Direct',
        preference: 0,
        metric: 0
      });
    }
    return rows;
  }

  /**
   * 汇总 LLDP 邻居表。
   *
   * @returns {object[]} LLDP 行。
   */
  lldp_rows() {
    const rows = [];
    for (const port of this.ports) {
      if (!this.is_link_up(port)) {
        continue;
      }
      const peer = this.peer_of(port);
      rows.push({
        system_name: peer.system_name,
        chassis_id: peer.chassis_id,
        port_id: port.short_name,
        ttl: peer.ttl,
        capability: peer.capability
      });
    }
    return rows;
  }

  /**
   * 端口概览行模型。
   *
   * @returns {object[]} 概览行。
   */
  port_rows() {
    return this.ports.map((port) => {
      const text = this.port_text(port);
      return Object.assign({}, text, {
        short_name: port.short_name,
        name: port.name,
        alias: port.alias,
        status: this.is_link_up(port) ? 'UP' : port.admin_up ? 'DOWN' : 'DISABLED',
        vlan_text: String(port.vlan),
        description: port.description,
        poe_text: text.poe_text,
        in_uti: port.in_uti.toFixed(0) + '%',
        out_uti: port.out_uti.toFixed(0) + '%',
        in_errors: port.in_errors,
        out_errors: port.out_errors,
        crc: port.crc_errors,
        rx_pkts: port.rx_pkts,
        tx_pkts: port.tx_pkts,
        rx_bytes: port.rx_bytes,
        tx_bytes: port.tx_bytes,
        mac_count: port.mac_count,
        mtu: port.mtu,
        uptime_text: utils.format_uptime((Date.now() - port.last_change_at) / 1000)
      });
    });
  }

  /**
   * 汇总 VLAN 表。
   *
   * @returns {object[]} VLAN 行。
   */
  vlan_rows() {
    const rows = [];
    for (const vlan of this.vlans.values()) {
      const members = this.ports.filter((port) => port.vlan === vlan.vlan_id);
      rows.push({
        vlan_id: String(vlan.vlan_id).padStart(4, '0'),
        raw_vlan_id: vlan.vlan_id,
        vlan_name: vlan.name,
        description: vlan.description,
        status_text: vlan.vlan_id === 1 ? 'active' : 'active',
        member_ports: members.map((port) => port.short_name).join(', ') || '--',
        tagged_ports:
          this.ports
            .filter((port) => port.mode === 'trunk' && port.trunk_vlans.indexOf(vlan.vlan_id) >= 0)
            .map((port) => port.short_name)
            .join(', ') || '--',
        untagged_ports: members.map((port) => port.short_name).join(', ') || '--'
      });
    }
    rows.sort((left, right) => left.raw_vlan_id - right.raw_vlan_id);
    return rows;
  }

  /**
   * 汇总 PoE 表。
   *
   * @returns {object[]} PoE 行。
   */
  poe_rows() {
    return this.ports
      .filter((port) => port.poe_capable)
      .map((port) => ({
        short_name: port.short_name,
        poe_text: port.poe_enabled ? 'enabled' : 'disabled',
        power_text: port.poe_watts.toFixed(1) + ' W',
        current_text: (port.poe_watts / 53.5).toFixed(3) + ' A',
        voltage_text: '53.5 V',
        class_text: port.poe_watts > 15 ? 'Class 4' : port.poe_watts > 7 ? 'Class 3' : 'Class 0'
      }));
  }

  /**
   * 汇总计数表。
   *
   * @returns {object[]} 计数行。
   */
  counter_rows() {
    return this.ports.map((port) => ({
      short_name: port.short_name,
      rx_pkts: port.rx_pkts,
      tx_pkts: port.tx_pkts,
      in_errors: port.in_errors,
      out_errors: port.out_errors,
      crc: port.crc_errors,
      rx_bytes: port.rx_bytes,
      tx_bytes: port.tx_bytes
    }));
  }

  /**
   * 追加一条设备日志（带厂商日志前缀）。
   *
   * @param {string} message 日志内容。
   * @param {string} [level] 级别。
   * @returns {object} 日志记录。
   */
  push_log(message, level = 'INFO') {
    const templates = (this.cli_profile && this.cli_profile.text_templates) || {};
    const prefix_template =
      typeof templates.log_prefix === 'string' ? templates.log_prefix : '%{date} {hostname} ';
    const prefix = prefix_template.replace(/\{(\w+)\}/g, (match, key) => {
      if (key === 'date') {
        return utils.format_datetime(new Date());
      }
      if (key === 'hostname') {
        return this.hostname;
      }
      return match;
    });
    const record = {
      timestamp: utils.format_datetime(new Date()),
      level: level || 'INFO',
      text: prefix + message
    };
    this.log_buffer.push(record);
    if (this.log_buffer.length > 400) {
      this.log_buffer.splice(0, this.log_buffer.length - 400);
    }
    return record;
  }

  /**
   * 生成模板渲染所需的数据上下文。
   *
   * @param {object} [extra] 额外上下文。
   * @returns {object} 渲染上下文。
   */
  template_context(extra = {}) {
    const up_count = this.ports.filter((port) => this.is_link_up(port)).length;
    return Object.assign(
      {
        hostname: this.hostname,
        model: this.model_id,
        product_name: this.product_name,
        vendor_name: this.vendor_profile.display_name || this.vendor_id,
        os_version: this.software_version,
        serial_number: this.serial_number,
        mac_address: this.mac_address,
        uptime: utils.format_uptime(this.uptime_seconds),
        now: utils.format_datetime(new Date()),
        date: utils.format_datetime(new Date()),
        temperature: this.environment.temperature.toFixed(1),
        fan_status: this.environment.fan_status,
        power_status: this.environment.power_status,
        port_count: this.ports.length,
        up_count: up_count
      },
      extra || {}
    );
  }

  /**
   * 设备能力集合。
   *
   * @returns {string[]} 能力列表。
   */
  capabilities() {
    return ((this.manifest.runtime || {}).capabilities || []).slice();
  }

  /**
   * 是否具备某项能力。
   *
   * @param {string} capability 能力名。
   * @returns {boolean} 是否具备。
   */
  has_capability(capability) {
    return this.capabilities().indexOf(capability) >= 0;
  }

  /**
   * 设备概要（供检视面板与后端 API 使用）。
   *
   * @returns {object} 概要对象。
   */
  summary() {
    const up_count = this.ports.filter((port) => this.is_link_up(port)).length;
    return {
      device_id: this.device_id,
      experiment_id: this.experiment_id,
      hostname: this.hostname,
      model_id: this.model_id,
      vendor_id: this.vendor_id,
      vendor_name: this.vendor_profile.display_name || this.vendor_id,
      device_type: this.device_type,
      device_class: this.device_class,
      product_name: this.product_name,
      serial_number: this.serial_number,
      mac_address: this.mac_address,
      os_version: this.software_version,
      power_state: this.power_state,
      boot_progress: this.boot_progress,
      uptime_text: utils.format_uptime(this.uptime_seconds),
      port_count: this.ports.length,
      up_count: up_count,
      temperature: Number(this.environment.temperature.toFixed(1)),
      capabilities: this.capabilities(),
      config_saved: this.config_saved
    };
  }
}

export { DeviceRuntime };
export const device_runtime_utils = {
  make_mac: make_mac,
  make_serial: make_serial,
  PEER_NAME_POOL: PEER_NAME_POOL
};
