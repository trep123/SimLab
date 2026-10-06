/**
 * @File : web/src/devices/templates/generic_olt_gpon_8.ts
 * @Time : 2026-10-05 22:08
 * @Author : Cetrp
 * @Description : 通用 GPON OLT 设备模板（8×GPON PON 口 + 4×10GE SFP+ 上联，1U 机架式）。
 *
 * 数据来源：assets/catalog/generic-olt-gpon-8.json 的 visual.chassis 与 visual.port_layout，
 * 端口名前缀/数量/类型/速率与资产严格一致；厂商差异只进数据，不改引擎。
 */

import type { DeviceTemplate } from '../template_types';

/** 8 个 GPON PON 口的短名（2 行 × 4 口）。 */
const PON_PORTS = Array.from({ length: 8 }, (unused, index) => 'GPON0/1/' + (index + 1));

/** 4 个万兆上联光口的短名。 */
const XGE_PORTS = Array.from({ length: 4 }, (unused, index) => 'XGE0/0/' + (index + 1));

/** 模板：通用 GPON OLT（8×PON 口）。 */
const template: DeviceTemplate = {
  model_id: 'generic-olt-gpon-8',
  vendor_id: 'generic',
  display_name: '通用 GPON OLT（8×PON 口）',
  device_type: 'olt',
  dimensions: { width: 0.442, height: 0.0436, depth: 0.24, u_height: 1 },
  rack_mountable: true,
  version: 1,
  origin: 'builtin',
  description: '8×GPON PON 口 + 4×10GE SFP+ 上联，1U 机架式无源光网络局端设备。',
  theme: { chassis_color: '#9aa0a6', accent_color: '#00bcd4' },
  parts: [
    {
      part_id: 'chassis',
      kind: 'rack_chassis',
      category: 'chassis',
      label: '1U 机箱',
      params: {
        width: 0.442,
        height: 0.0436,
        depth: 0.24,
        color: '#9aa0a6',
        ears: true,
        vents: true
      }
    },
    {
      part_id: 'panel',
      kind: 'front_panel',
      category: 'front_panel',
      label: '前面板',
      params: {
        width: 0.442,
        height: 0.0436,
        background: '#2a2e33',
        brand_line: 'SIMLAB OLT GPON-8',
        sub_line: '8×GPON + 4×10GE',
        power_button: true,
        console: true,
        usb: true,
        reset_pinhole: true,
        led_color: '#00bcd4'
      },
      transform: { position: [0, 0, 0.1205] }
    },
    {
      part_id: 'pon_ports',
      kind: 'port_row',
      category: 'port_module',
      label: '8×GPON PON 口',
      params: {
        connector: 'gpon',
        rows: 2,
        columns: 4,
        pitch_x: 0.0195,
        pitch_y: 0.017,
        origin: [-0.12, 0, 0.1205],
        names: PON_PORTS,
        speed_bps: 10000000000,
        group_id: 'pon'
      }
    },
    {
      part_id: 'uplink_ports',
      kind: 'port_row',
      category: 'port_module',
      label: '4×10GE SFP+ 上联',
      params: {
        connector: 'sfp_plus',
        rows: 2,
        columns: 2,
        pitch_x: 0.0205,
        pitch_y: 0.017,
        origin: [0.168, 0, 0.1205],
        names: XGE_PORTS,
        speed_bps: 10000000000,
        group_id: 'uplink'
      }
    },
    {
      part_id: 'psu',
      kind: 'psu_module',
      category: 'power',
      label: '内置电源',
      params: { width: 0.1, height: 0.036, depth: 0.18, label: 'PWR' },
      /* IEC 电源口朝向机箱背面：本地 +Z 旋转 180° 后指向 -Z；
         Z 位置前移 12 mm，避免电源尾部（含风扇/提手）从机箱背面穿出。 */
      transform: { position: [-0.155, 0, -0.018], rotation: [0, Math.PI, 0] }
    },
    {
      part_id: 'fan_tray',
      kind: 'fan_tray',
      category: 'cooling',
      label: '风扇盘',
      params: { fan_count: 3, fan_size: 0.034, depth: 0.026, grille: true },
      transform: { position: [0.11, 0, -0.03] }
    },
    {
      part_id: 'board',
      kind: 'main_board',
      category: 'internal',
      label: '主板',
      params: { width: 0.4, depth: 0.2, color: '#14351f' },
      transform: { position: [0, 0.002, 0] }
    },
    {
      part_id: 'chip',
      kind: 'switch_chip',
      category: 'internal',
      label: 'PON MAC 芯片',
      params: { width: 0.034, depth: 0.034, height: 0.0035 },
      transform: { position: [0, 0.007, 0] }
    },
    {
      part_id: 'heatsink',
      kind: 'heatsink',
      category: 'internal',
      label: '散热鳍片',
      params: { width: 0.05, height: 0.008, count: 14 },
      transform: { position: [0.14, 0.002, -0.03] }
    }
  ],
  ports: [],
  leds: [
    { name: 'SYS', position: [-0.206, 0.013, 0.1235], color: '#3ddc84' },
    { name: 'PWR', position: [-0.192, 0.013, 0.1235], color: '#3ddc84' },
    { name: 'PON', position: [-0.178, 0.013, 0.1235], color: '#00bcd4' },
    { name: 'LOS', position: [-0.164, 0.013, 0.1235], color: '#ff5d6c' }
  ]
};

export default template;
