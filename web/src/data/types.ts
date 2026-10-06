/**
 * @File : web/src/data/types.ts
 * @Time : 2026-10-05 03:40
 * @Author : Cetrp
 * @Description : 领域类型定义：规格资产、设备运行时、CLI 档案、事件与命令，供前端 v2 全量引用。
 */

/* ------------------------------ 规格资产 ------------------------------ */

/** 厂商品牌参数（三维外观取色与丝印）。 */
export interface VendorBrand {
  chassis_color?: string;
  chassis_dark_color?: string;
  faceplate_color?: string;
  logo_text?: string;
  logo_color?: string;
  accent_color?: string;
  led_scheme?: string;
  silkscreen_font?: string;
  cable_color?: number;
  [key: string]: unknown;
}

/** 厂商档案（assets/vendor/*.json）。 */
export interface VendorProfile {
  schema_version: string;
  vendor_id: string;
  display_name: string;
  display_name_en?: string;
  os_family: string;
  os_version: string;
  cli_profile_id: string;
  brand: VendorBrand;
  prompt: Record<string, string>;
  boot_log: string[];
  messages: Record<string, string>;
  confirm_words?: { yes: string[]; no: string[] };
  led_legend?: Record<string, string>;
}

/** 端口分组命名规则。 */
export interface PortNaming {
  name_prefix?: string;
  short_prefix: string;
  alias_prefix?: string;
}

/** 端口行定义。 */
export interface PortRow {
  start_index?: number;
  count: number;
  row_index?: number;
  /** 显式端口名；用于把模块化网口绑定到 VM 的稳定 vNIC alias。 */
  names?: string[];
}

/** 面板端口分组。 */
export interface PortLayoutGroup {
  group_id: string;
  kind: string;
  label?: string;
  speed_bps: number;
  poe?: boolean;
  naming: PortNaming;
  rows: PortRow[];
}

/** 设备外观。 */
export interface DeviceVisual {
  chassis: { width: number; height: number; depth: number; u_height?: number };
  silkscreen?: { brand_line?: string; sub_line?: string };
  front_panel?: {
    power_button?: boolean;
    console?: string | boolean;
    usb?: boolean;
    reset_pinhole?: boolean;
    mode_button?: boolean;
  };
  port_layout: PortLayoutGroup[];
  leds?: { per_port?: number; system_label?: string; power_label?: string; speed_label?: string };
  airflow?: string;
}

/** 设备 Manifest（assets/catalog/*.json）。 */
export interface DeviceManifest {
  schema_version: string;
  manifest_version?: string;
  model_id: string;
  vendor_id: string;
  device_type: string;
  display_name: string;
  product_name?: string;
  device_class?: string;
  os_version?: string;
  serial_prefix?: string;
  board_type?: string;
  visual: DeviceVisual;
  port_overrides?: { short_name: string; note?: string; [key: string]: unknown }[];
  runtime: { type: string; profile?: string; capabilities?: string[] };
  features?: string[];
  /** 光接入网能力描述（OLT / ONU），由光链路运行时消费。 */
  optical?: {
    role: 'olt' | 'onu';
    pon_ports?: number;
    max_onu_per_port?: number;
    tx_power_dbm?: number;
    sensitivity_dbm?: number;
    overload_dbm?: number;
    splitter_ratio_default?: number;
    guaranteed_mbps?: number;
    max_mbps?: number;
    downstream_capacity_mbps?: number;
    upstream_capacity_mbps?: number;
    max_distance_m?: number;
  };
  /** 无线能力描述（AP / STA），由无线运行时消费。 */
  wireless?: {
    role: 'ap' | 'sta';
    ssid_default?: string;
    channel?: number;
    band?: string;
    tx_power_dbm?: number;
    sensitivity_dbm?: number;
    max_clients?: number;
    supported_rates_mbps?: number[];
  };
}

/** 端口定义（Manifest 展开结果）。 */
export interface PortDefinition {
  id: string;
  name: string;
  short_name: string;
  alias: string;
  index: number;
  group_id: string;
  kind: string;
  type: string;
  protocol: string;
  speed_bps: number;
  poe_capable: boolean;
  row?: number;
  [key: string]: unknown;
}

/** 端口运行时状态。 */
export interface PortState extends PortDefinition {
  state: string;
  admin_up: boolean;
  link_up: boolean;
  plugged: boolean;
  cable: CableRuntime | null;
  speed: string;
  speed_mode: string;
  duplex: string;
  vlan: number;
  mode: string;
  trunk_vlans: number[];
  description: string;
  poe_enabled: boolean;
  poe_watts: number;
  rx_pkts: number;
  tx_pkts: number;
  rx_bytes: number;
  tx_bytes: number;
  in_errors: number;
  out_errors: number;
  crc_errors: number;
  mac_count: number;
  in_uti: number;
  out_uti: number;
  mtu: number;
  last_change_at: number;
  blink_phase: number;
  traffic_rate: number;
  macs: MacEntry[];
  ip_address?: string;
  ip_mask?: string;
  /** 对端设备与端口（设备间互连时由控制平面给出）。 */
  peer_device_id?: string | null;
  peer_port?: string | null;
  /** 对端是否为无线关联（Wi-Fi 链路）。 */
  wireless?: boolean;
}

/** MAC 表项。 */
export interface MacEntry {
  mac_address: string;
  vlan_id: number;
  type_text: string;
  port_name: string;
  age_text: string;
  age_seconds?: number;
}

/** 运行时线缆记录。 */
export interface CableRuntime {
  cable_id: string;
  cable_type: string;
  state: string;
  peer?: { system_name: string; device_type: string; chassis_id: string; port_id: string };
  target_device_id?: string | null;
  target_port?: string | null;
}

/* ------------------------------ CLI 档案 ------------------------------ */

/** CLI 参数定义。 */
export interface CliArgument {
  name: string;
  type: string;
  required?: boolean;
  values?: string[];
  help?: string;
  [key: string]: unknown;
}

/** CLI 命令定义。 */
export interface CliCommand {
  id: string;
  syntax: string;
  aliases?: string[];
  modes: string[];
  help: string;
  handler: string;
  args?: CliArgument[];
  output?: string[];
  next_mode?: string;
  confirm?: string;
  hidden?: boolean;
  [key: string]: unknown;
}

/** CLI 模式定义。 */
export interface CliMode {
  prompt_key: string;
  description?: string;
  enter_command?: string | null;
}

/** 表格列定义。 */
export interface TableColumn {
  key: string;
  header: string;
  width: number;
  align?: 'left' | 'right' | 'center';
}

/** CLI 档案（assets/cli/*.json）。 */
export interface CliProfile {
  schema_version: string;
  profile_id: string;
  vendor_id: string;
  modes: Record<string, CliMode>;
  commands: CliCommand[];
  tables?: Record<string, { header_lines?: string[]; columns: TableColumn[]; empty_text?: string }>;
  status_text?: Record<string, unknown>;
  phrases?: Record<string, unknown>;
  config_render?: Record<string, string[]>;
  text_templates?: Record<string, string | string[]>;
  /** 配置模式提示符后缀（部分厂商用）。 */
  prompt_suffix?: string;
}

/* ------------------------------ 事件与命令 ------------------------------ */

/** 平台事件（任务书 §18）。 */
export interface SimlabEvent {
  event_id: string;
  event_type: string;
  experiment_id: string | null;
  device_id: string | null;
  timestamp: string;
  data: Record<string, any>;
}

/** 命令对象（任务书 §17）。 */
export interface SimlabCommand {
  type: string;
  device_id: string | null;
  payload: Record<string, any>;
}

/** 命令执行结果。 */
export interface CommandResult {
  success: boolean;
  command_id?: string;
  command_type?: string;
  state_changes?: Record<string, unknown>[];
  events?: string[];
  data?: any;
  error_code?: string;
  message?: string;
}

/* ------------------------------ 拓扑与无线 ------------------------------ */

/** 线缆记录（后端拓扑快照）。 */
export interface CableRecord {
  cable_id: string;
  cable_type: string;
  state: string;
  length_m?: number;
  latency_ms?: number;
  source: { device_id: string; port: string };
  target: { device_id: string; port: string } | null;
  peer_label?: string | null;
}

/** 拓扑快照。 */
export interface TopologySnapshot {
  success: boolean;
  experiment_id: string;
  devices: DeviceSnapshot[];
  cables: CableRecord[];
}

/** 设备快照（后端拓扑快照中的设备）。 */
export interface DeviceSnapshot {
  device_id: string;
  model_id: string;
  vendor_id: string;
  hostname: string;
  device_type: string;
  power_state: string;
  position: { x: number; y: number; z: number };
  ports: Record<string, any>[];
}

/** 无线关联记录。 */
export interface WirelessAssociation {
  sta_device_id: string;
  ap_device_id: string;
  state: string;
  rssi_dbm: number;
  snr_db: number;
  phy_rate_mbps: number;
  mcs?: number;
  retries: number;
  throughput_mbps: number;
  distance_m: number;
  last_change?: string;
}

/** AP 状态。 */
export interface WirelessAccessPoint {
  device_id: string;
  ssid: string;
  channel: number;
  tx_power_dbm: number;
  coverage_radius_m: number;
  position?: { x: number; y: number; z: number };
  client_count: number;
  channel_utilization: number;
}

/** 无线状态快照。 */
export interface WirelessSnapshot {
  success: boolean;
  runtime: { adapter: string; process: string; alive: boolean; channel: number; band: string };
  aps: WirelessAccessPoint[];
  associations: WirelessAssociation[];
}

/** 连通性测试结果。 */
export interface PingResult {
  success: boolean;
  reachable: boolean;
  count: number;
  received: number;
  loss_percent: number;
  rtt_min_ms: number;
  rtt_avg_ms: number;
  rtt_max_ms: number;
  path: string[];
  hops: {
    device_id: string;
    in_port: string | null;
    out_port: string | null;
    mac_learned?: string;
    vlan?: number;
  }[];
  unreachable_reason?: string | null;
}
