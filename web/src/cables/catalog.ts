/**
 * @File : web/src/cables/catalog.ts
 * @Time : 2026-10-04 13:00
 * @Author : Cetrp
 * @Description : 线缆类型目录（线缆栏数据源）：描述每种线缆的两端连接器、护套颜色、线径、
 *               最长距离与适用端口，并提供按端口选型、兼容判定与缺省选型查询函数。
 */

import type { ConnectorType } from '../devices/template_types';

/** 线缆类别：决定线缆栏里的分组与走线/流动画表现。 */
export type CableCategory = 'copper' | 'fiber' | 'power' | 'console';

/** 线缆类型描述（线缆栏一条记录）。 */
export interface CableKind {
  /** 类型 ID（cat6 / fiber_lc…），与运行时 CableRecord.cable_type 对应。 */
  cable_id: string;
  /** 中文显示名。 */
  label: string;
  /** 类别。 */
  category: CableCategory;
  /** 两端连接器（[A 端, B 端]，同类型线缆两端一致）。 */
  connectors: [ConnectorType, ConnectorType];
  /** 护套颜色（十六进制）。 */
  color: string;
  /** 线缆外径（米，用于管道半径换算）。 */
  diameter_m: number;
  /** 最大传输距离（米）。 */
  max_length_m: number;
  /** 速率文本（线缆栏展示）。 */
  speed_text: string;
  /** 说明文本（线缆栏悬浮提示）。 */
  description: string;
  /** 可插入的端口连接器类型（线缆栏里"点端口后高亮可用线缆"）。 */
  compatible_connectors: ConnectorType[];
}

/** 类别中文名（线缆栏分组标题）。 */
export const CABLE_CATEGORY_LABELS: Record<CableCategory, string> = {
  copper: '铜缆（双绞线/直连铜缆）',
  fiber: '光纤',
  power: '电源与接地',
  console: '控制台与调试'
};

/**
 * 线缆类型目录（9 种：铜缆 3、光纤 2、电源 3、控制台 1）。
 *
 * 线径取常见成品线规格：六类 UTP 约 6.0 mm、超六类屏蔽约 7.2 mm、
 * 单模 LC 跳线约 3.0 mm、SC/APC 入户光缆约 3.5 mm、DAC 约 8.5 mm、
 * Console 约 4.8 mm、IEC 电源线约 9.2 mm、DC 电源线约 4.2 mm、接地线约 6.0 mm。
 */
export const CABLE_CATALOG: CableKind[] = [
  {
    cable_id: 'cat6',
    label: '六类网线（Cat6 UTP）',
    category: 'copper',
    connectors: ['rj45', 'rj45'],
    color: '#2f6fd0',
    diameter_m: 0.006,
    max_length_m: 100,
    speed_text: '1000BASE-T',
    description: '非屏蔽双绞线，1000BASE-T，最长 100 m，可用于 GE 口与 Console 口。',
    compatible_connectors: ['rj45', 'console_rj45']
  },
  {
    cable_id: 'cat6a',
    label: '超六类屏蔽网线（Cat6A STP）',
    category: 'copper',
    connectors: ['rj45', 'rj45'],
    color: '#e8802f',
    diameter_m: 0.0072,
    max_length_m: 100,
    speed_text: '10GBASE-T',
    description: '屏蔽双绞线，10GBASE-T，最长 100 m，用于 10G 电口互联。',
    compatible_connectors: ['rj45']
  },
  {
    cable_id: 'fiber_lc',
    label: 'LC-LC 单模光纤跳线',
    category: 'fiber',
    connectors: ['sfp', 'sfp'],
    color: '#f2c93b',
    diameter_m: 0.003,
    max_length_m: 10000,
    speed_text: '10G/25G',
    description: '单模双芯跳线，10G/25G 光模块互联，最长 10 km。',
    compatible_connectors: ['sfp', 'sfp_plus']
  },
  {
    cable_id: 'fiber_sc',
    label: 'SC/APC 入户光缆',
    category: 'fiber',
    connectors: ['gpon', 'gpon'],
    color: '#2f9e63',
    diameter_m: 0.0035,
    max_length_m: 20000,
    speed_text: 'GPON 2.5G',
    description: 'GPON 入户皮线光缆（SC/APC 斜面接头），最长 20 km。',
    compatible_connectors: ['gpon']
  },
  {
    cable_id: 'dac_sfp',
    label: 'SFP+ 高速铜缆（DAC）',
    category: 'copper',
    connectors: ['sfp_plus', 'sfp_plus'],
    color: '#1b1f26',
    diameter_m: 0.0085,
    max_length_m: 5,
    speed_text: '10G',
    description: '无源直连铜缆，10G，最长 5 m，用于机柜内堆叠与短距互联。',
    compatible_connectors: ['sfp_plus']
  },
  {
    cable_id: 'console',
    label: 'Console 配置线（USB 转 RJ45）',
    category: 'console',
    connectors: ['usb', 'console_rj45'],
    color: '#3a4048',
    diameter_m: 0.0048,
    max_length_m: 3,
    speed_text: '115200 bps',
    description: '调试用配置线：USB-A 转 RJ45 Console 口，最长 3 m。',
    compatible_connectors: ['usb', 'console_rj45']
  },
  {
    cable_id: 'power_iec',
    label: '电源线（IEC C13-C14）',
    category: 'power',
    connectors: ['power_iec_c14', 'power_iec_c14'],
    color: '#15181d',
    diameter_m: 0.0092,
    max_length_m: 3,
    speed_text: '220V/10A',
    description: '交流电源线，220V/10A，一端 C13 直角插头插入设备 C14 插座。',
    compatible_connectors: ['power_iec_c14']
  },
  {
    cable_id: 'power_dc',
    label: '直流电源线（DC 桶形）',
    category: 'power',
    connectors: ['power_dc_barrel', 'power_dc_barrel'],
    color: '#1b1f26',
    diameter_m: 0.0042,
    max_length_m: 3,
    speed_text: '12V/2A',
    description: '直流电源线，12V/2A，桶形插头（5.5/2.1 mm），也可压接端子供电。',
    compatible_connectors: ['power_dc_barrel', 'power_dc_terminal']
  },
  {
    cable_id: 'ground',
    label: '接地线（黄绿）',
    category: 'power',
    connectors: ['power_dc_terminal', 'power_dc_terminal'],
    color: '#9acd32',
    diameter_m: 0.006,
    max_length_m: 2,
    speed_text: '接地',
    description: '机柜等电位接地线，黄绿双色，两端压接端子。',
    compatible_connectors: ['power_dc_terminal']
  }
];

/** 缺省选型表：端口连接器 → 线缆类型 ID（'' 表示该端口不接线缆）。 */
const DEFAULT_CABLE_BY_CONNECTOR: Record<string, string> = {
  rj45: 'cat6',
  sfp: 'fiber_lc',
  sfp_plus: 'fiber_lc',
  gpon: 'fiber_sc',
  console_rj45: 'console',
  usb: 'console',
  power_iec_c14: 'power_iec',
  power_dc_barrel: 'power_dc',
  power_dc_terminal: 'ground',
  antenna_sma: ''
};

/**
 * 按类型 ID 取线缆描述。
 *
 * @param {string} cable_id 类型 ID（cat6 / fiber_lc…）。
 * @returns {CableKind | null} 线缆描述；未登记返回 null。
 */
export function get_cable_kind(cable_id: string): CableKind | null {
  if (!cable_id) {
    return null;
  }
  for (const kind of CABLE_CATALOG) {
    if (kind.cable_id === cable_id) {
      return kind;
    }
  }
  return null;
}

/**
 * 判断线缆是否可以插入某种连接器。
 *
 * @param {CableKind} kind 线缆描述。
 * @param {ConnectorType} connector 端口连接器类型。
 * @returns {boolean} 是否兼容。
 */
export function is_compatible(kind: CableKind, connector: ConnectorType): boolean {
  if (!kind || !connector) {
    return false;
  }
  return kind.compatible_connectors.includes(connector);
}

/**
 * 按端口调整线缆两端顺序：让 connectors[0] 对上起点端口，保证两端接头插在对的位置
 * （例如 Console 线 USB 端插电脑、RJ45 端插设备 Console 口）。
 *
 * @param {CableKind} kind 线缆描述。
 * @param {ConnectorType} connector 起点端口连接器类型。
 * @returns {CableKind} 调整后的线缆描述（原对象不修改）。
 */
export function order_kind_for_connector(kind: CableKind, connector: ConnectorType): CableKind {
  if (!kind || !connector) {
    return kind;
  }
  const first = kind.connectors[0];
  const second = kind.connectors[1];
  if (first === connector || second !== connector) {
    return kind;
  }

  return { ...kind, connectors: [second, first] };
}

/**
 * 列出可插入某种连接器的全部线缆（线缆栏高亮用）。
 *
 * @param {ConnectorType} connector 端口连接器类型。
 * @returns {CableKind[]} 兼容线缆（保持目录顺序）。
 */
export function cables_for_connector(connector: ConnectorType): CableKind[] {
  return CABLE_CATALOG.filter((kind) => is_compatible(kind, connector));
}

/**
 * 列出某个类别下的全部线缆。
 *
 * @param {CableCategory} category 类别。
 * @returns {CableKind[]} 线缆列表。
 */
export function cables_by_category(category: CableCategory): CableKind[] {
  return CABLE_CATALOG.filter((kind) => kind.category === category);
}

/**
 * 端口连接器的缺省线缆类型。
 *
 * @param {ConnectorType} connector 端口连接器类型。
 * @returns {string} 线缆类型 ID；该端口不接线缆（如天线口）返回 ''。
 */
export function default_cable_id_for(connector: ConnectorType): string {
  if (!connector) {
    return '';
  }
  const cable_id = DEFAULT_CABLE_BY_CONNECTOR[connector];
  return cable_id === undefined ? '' : cable_id;
}

/**
 * 取两端连接器的中文名（线缆栏"连接器（两端）"列）。
 *
 * @param {CableKind} kind 线缆描述。
 * @returns {string} 形如 "RJ45 → RJ45" 的文本。
 */
export function connector_pair_text(kind: CableKind): string {
  const labels: Record<string, string> = {
    rj45: 'RJ45',
    sfp: 'SFP',
    sfp_plus: 'SFP+',
    gpon: 'SC/APC',
    console_rj45: 'RJ45 Console',
    usb: 'USB-A',
    power_iec_c14: 'IEC C14',
    power_dc_barrel: 'DC 桶形',
    power_dc_terminal: '压接端子',
    antenna_sma: 'SMA'
  };
  if (!kind) {
    return '';
  }
  const first = labels[kind.connectors[0]] || kind.connectors[0];
  const second = labels[kind.connectors[1]] || kind.connectors[1];
  return first + ' → ' + second;
}
