/**
 * @File : web/src/cli/defaults.ts
 * @Time : 2026-10-04 17:45
 * @Author : Cetrp
 * @Description : CLI 档案的中性兜底片段：当厂商档案缺少 tables/phrases/config_render 等段落时保证引
 * 擎可用。
 */

/** 状态措辞兜底。 */
const STATUS_TEXT = {
  phy_up: 'up',
  phy_down: 'down',
  phy_admin_down: '*down',
  protocol_up: 'up',
  protocol_down: 'down',
  speed: { auto: 'auto', 10: '10M', 100: '100M', 1000: '1G', 10000: '10G' },
  duplex: { full: 'full', half: 'half', auto: 'auto' },
  type: { rj45: '10/100/1000Base-T', sfp: '10GBase-SR' },
  poe: { enabled: 'enabled', disabled: 'disabled' },
  vlan_untagged: 'Untagged',
  vlan_tagged: 'Tagged'
};

/** 表格兜底定义。 */
const TABLES = {
  interface_brief_table: {
    header_lines: ['PHY: Physical   *down: administratively down'],
    columns: [
      { key: 'short_name', header: 'Interface', width: 22, align: 'left' },
      { key: 'phy_text', header: 'PHY', width: 6, align: 'left' },
      { key: 'protocol_text', header: 'Protocol', width: 10, align: 'left' },
      { key: 'in_uti', header: 'InUti', width: 7, align: 'right' },
      { key: 'out_uti', header: 'OutUti', width: 7, align: 'right' },
      { key: 'in_errors', header: 'inErrors', width: 9, align: 'right' },
      { key: 'out_errors', header: 'outErrors', width: 10, align: 'right' }
    ],
    empty_text: '--'
  },
  interface_detail: {
    header_lines: [],
    columns: [
      { key: 'key_text', header: 'Item', width: 20, align: 'left' },
      { key: 'value_text', header: 'Value', width: 40, align: 'left' }
    ],
    empty_text: '--'
  },
  vlan_table: {
    header_lines: ['VID  Type    Ports'],
    columns: [
      { key: 'vlan_id', header: 'VID', width: 6, align: 'left' },
      { key: 'status_text', header: 'Status', width: 9, align: 'left' },
      { key: 'member_ports', header: 'Ports', width: 60, align: 'left' }
    ],
    empty_text: '--'
  },
  mac_table: {
    header_lines: ['MAC Address Table'],
    columns: [
      { key: 'mac_address', header: 'MAC Address', width: 20, align: 'left' },
      { key: 'vlan_id', header: 'VLAN', width: 7, align: 'left' },
      { key: 'type_text', header: 'Type', width: 10, align: 'left' },
      { key: 'port_name', header: 'Port', width: 20, align: 'left' },
      { key: 'age_text', header: 'Age', width: 8, align: 'left' }
    ],
    empty_text: '--'
  },
  arp_table: {
    header_lines: ['IP ADDRESS      MAC ADDRESS        EXPIRE(M) TYPE     INTERFACE'],
    columns: [
      { key: 'ip_address', header: 'IP Address', width: 17, align: 'left' },
      { key: 'mac_address', header: 'MAC Address', width: 20, align: 'left' },
      { key: 'expire_text', header: 'Expire', width: 8, align: 'left' },
      { key: 'type_text', header: 'Type', width: 10, align: 'left' },
      { key: 'interface', header: 'Interface', width: 20, align: 'left' }
    ],
    empty_text: '--'
  },
  route_table: {
    header_lines: ['Routing Tables: Public'],
    columns: [
      { key: 'destination', header: 'Destination', width: 18, align: 'left' },
      { key: 'mask', header: 'Mask', width: 18, align: 'left' },
      { key: 'protocol_text', header: 'Proto', width: 9, align: 'left' },
      { key: 'preference', header: 'Pre', width: 5, align: 'right' },
      { key: 'nexthop', header: 'NextHop', width: 18, align: 'left' },
      { key: 'interface', header: 'Interface', width: 16, align: 'left' }
    ],
    empty_text: '--'
  },
  lldp_table: {
    header_lines: ['LLDP Neighbor Information'],
    columns: [
      { key: 'system_name', header: 'System Name', width: 20, align: 'left' },
      { key: 'chassis_id', header: 'Chassis ID', width: 20, align: 'left' },
      { key: 'port_id', header: 'Port ID', width: 14, align: 'left' },
      { key: 'ttl', header: 'TTL', width: 6, align: 'right' },
      { key: 'capability', header: 'Capability', width: 14, align: 'left' }
    ],
    empty_text: '--'
  },
  poe_table: {
    header_lines: ['PoE Interface Information'],
    columns: [
      { key: 'short_name', header: 'Interface', width: 16, align: 'left' },
      { key: 'poe_text', header: 'PoE', width: 10, align: 'left' },
      { key: 'power_text', header: 'Power', width: 10, align: 'right' },
      { key: 'current_text', header: 'Current', width: 10, align: 'right' },
      { key: 'voltage_text', header: 'Voltage', width: 10, align: 'right' },
      { key: 'class_text', header: 'Class', width: 9, align: 'left' }
    ],
    empty_text: '--'
  },
  counters_table: {
    header_lines: ['Interface counters'],
    columns: [
      { key: 'short_name', header: 'Interface', width: 18, align: 'left' },
      { key: 'rx_pkts', header: 'InPackets', width: 12, align: 'right' },
      { key: 'tx_pkts', header: 'OutPackets', width: 12, align: 'right' },
      { key: 'in_errors', header: 'InErrors', width: 10, align: 'right' },
      { key: 'out_errors', header: 'OutErrors', width: 10, align: 'right' },
      { key: 'crc', header: 'CRC', width: 8, align: 'right' }
    ],
    empty_text: '--'
  }
};

/** 配置短语兜底。 */
const PHRASES = {
  mode: { access: 'port link-type access', trunk: 'port link-type trunk' },
  access_vlan: 'port default vlan {vlan}',
  trunk_vlans: 'port trunk allow-pass vlan {vlans}',
  ip_address: 'ip address {ip} {mask}',
  poe_on: 'poe enable',
  no_shutdown: 'undo shutdown',
  shutdown: 'shutdown'
};

/** 运行配置模板兜底。 */
const CONFIG_RENDER = {
  header: ['#', ' sysname {hostname}', '#'],
  vlan: ['vlan {vlan}', ' description {vlan_description}', ' quit'],
  vlan_interface: ['interface Vlanif{vlan}', ' ip address {ip} {mask}', ' quit'],
  interface: [
    'interface {interface}',
    '{mode_phrase}',
    '?description description {description}',
    '{vlan_phrase}',
    '?trunk {trunk_phrase}',
    '?ip {ip_phrase}',
    '?poe {poe_phrase}',
    '{shutdown_phrase}',
    ' quit'
  ],
  footer: ['#', 'return']
};

/** 文本模板兜底。 */
const TEXT_TEMPLATES = {
  ping_result: [
    'PING {ip}: 56 data bytes, press CTRL_C to break',
    '    Reply from {ip}: bytes=56 Sequence={seq} ttl={ttl} time={rtt} ms',
    '  --- {ip} ping statistics ---',
    '  {sent} packet(s) transmitted',
    '  {received} packet(s) received',
    '  {loss}% packet loss'
  ],
  log_prefix: '%{date} {hostname} '
};

/** 交互确认兜底。 */
const CONFIRM_WORDS = { yes: ['y', 'yes'], no: ['n', 'no'] };

/**
 * 深合并兜底片段（厂商数据优先）。
 *
 * @param {object} base 兜底对象。
 * @param {object} override 厂商数据。
 * @returns {object} 合并结果。
 */
function deep_merge(base, override) {
  if (Array.isArray(base)) {
    return Array.isArray(override) ? override : base;
  }
  if (base && typeof base === 'object') {
    const result = {};
    const keys = new Set(Object.keys(base).concat(Object.keys(override || {})));
    for (const key of keys) {
      if (override && Object.prototype.hasOwnProperty.call(override, key)) {
        result[key] = deep_merge(base[key], override[key]);
      } else {
        result[key] = base[key];
      }
    }
    return result;
  }
  return override === undefined ? base : override;
}

/**
 * 为 CLI 档案补齐兜底段落。
 *
 * @param {object} profile CLI 档案。
 * @returns {object} 补齐后的档案副本。
 */
function with_defaults(profile) {
  const merged = deep_merge(
    {
      status_text: STATUS_TEXT,
      tables: TABLES,
      phrases: PHRASES,
      config_render: CONFIG_RENDER,
      text_templates: TEXT_TEMPLATES
    },
    {
      status_text: profile.status_text,
      tables: profile.tables,
      phrases: profile.phrases,
      config_render: profile.config_render,
      text_templates: profile.text_templates
    }
  );
  return Object.assign({}, profile, merged);
}

/**
 * 为厂商档案补齐兜底段落。
 *
 * @param {object} vendor 厂商档案。
 * @returns {object} 补齐后的档案副本。
 */
function with_vendor_defaults(vendor) {
  const merged = deep_merge(
    {
      confirm_words: CONFIRM_WORDS,
      messages: {
        unknown_command: "Error: Unrecognized command found at '^' position.",
        incomplete_command: "Error: Incomplete command found at '^' position.",
        ambiguous_command: "Error: Ambiguous command found at '^' position.",
        wrong_parameter: "Error: Wrong parameter found at '^' position.",
        permission_denied: 'Error: You do not have permission to run the command.',
        config_saved: 'Info: The current configuration is saved to the device successfully.',
        save_confirm: 'Are you sure to continue? [Y/N]:',
        reboot_confirm: 'Warning: All the configuration will be saved, Continue? [Y/N]:',
        reboot_started: 'Info: The system is now starting to reboot...',
        counter_cleared: 'Info: The counters of the specified interface are cleared.',
        poe_enabled: 'Info: PoE is enabled on the interface.',
        interface_not_found: 'Error: The interface does not exist.',
        operation_aborted: 'Info: The operation is aborted.'
      }
    },
    vendor
  );
  return merged;
}

export const CliDefaults = {
  STATUS_TEXT: STATUS_TEXT,
  TABLES: TABLES,
  PHRASES: PHRASES,
  CONFIG_RENDER: CONFIG_RENDER,
  TEXT_TEMPLATES: TEXT_TEMPLATES,
  with_defaults: with_defaults,
  with_vendor_defaults: with_vendor_defaults,
  deep_merge: deep_merge
};
