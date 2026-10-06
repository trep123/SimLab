/**
 * @File : web/src/devices/templates/generic_c3428gt_24s.ts
 * @Time : 2026-10-05 22:06
 * @Author : Cetrp
 * @Description : 通用 C3428GT-24S 设备模板（24×GE 电口，前 12 口 PoE + 4×10GE SFP+，1U 交换机）。
 *
 * 数据来源：assets/catalog/generic-c3428gt-24s.json 的 visual.chassis 与 visual.port_layout，
 * 端口名前缀/数量/类型/速率与资产严格一致（PoE 仅前 12 口）；厂商差异只进数据，不改引擎。
 */

import type { DeviceTemplate } from '../template_types';

/** 12 个 PoE 千兆电口的短名（上排）。 */
const POE_PORTS = Array.from({ length: 12 }, (unused, index) => 'GE0/0/' + (index + 1));

/** 12 个普通千兆电口的短名（下排）。 */
const GE_PORTS = Array.from({ length: 12 }, (unused, index) => 'GE0/0/' + (index + 13));

/** 4 个万兆光口的短名。 */
const XGE_PORTS = Array.from({ length: 4 }, (unused, index) => 'Te0/0/' + (index + 1));

/** 模板：通用 C3428GT-24S。 */
const template: DeviceTemplate = {
  model_id: 'generic-c3428gt-24s',
  vendor_id: 'generic',
  display_name: '通用 C3428GT-24S',
  device_type: 'switch',
  dimensions: { width: 0.442, height: 0.0436, depth: 0.22, u_height: 1 },
  rack_mountable: true,
  version: 1,
  origin: 'builtin',
  description: '24×GE 电口（前 12 口 PoE）+ 4×10GE SFP+ 上行，1U 机架式接入交换机。',
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
        depth: 0.22,
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
        brand_line: 'NETLAB C3428GT-24S',
        sub_line: '24×GE (12×PoE) + 4×10GE SFP+',
        power_button: false,
        console: true,
        usb: true,
        reset_pinhole: true,
        led_color: '#00bcd4'
      },
      transform: { position: [0, 0, 0.1105] }
    },
    {
      part_id: 'poe_ports',
      kind: 'port_row',
      category: 'port_module',
      label: '12×GE PoE 电口',
      params: {
        connector: 'rj45',
        rows: 1,
        columns: 12,
        pitch_x: 0.0172,
        origin: [0.012, 0.0085, 0.1105],
        names: POE_PORTS,
        speed_bps: 1000000000,
        group_id: 'ge-poe',
        poe: true
      }
    },
    {
      part_id: 'ge_ports',
      kind: 'port_row',
      category: 'port_module',
      label: '12×GE 电口（无 PoE）',
      params: {
        connector: 'rj45',
        rows: 1,
        columns: 12,
        pitch_x: 0.0172,
        origin: [0.012, -0.0085, 0.1105],
        names: GE_PORTS,
        speed_bps: 1000000000,
        group_id: 'ge'
      }
    },
    {
      part_id: 'xge_ports',
      kind: 'port_row',
      category: 'port_module',
      label: '4×10GE 光口',
      params: {
        connector: 'sfp_plus',
        rows: 2,
        columns: 2,
        pitch_x: 0.0205,
        pitch_y: 0.017,
        origin: [0.168, 0, 0.1105],
        names: XGE_PORTS,
        speed_bps: 10000000000,
        group_id: 'xg'
      }
    },
    {
      part_id: 'psu',
      kind: 'psu_module',
      category: 'power',
      label: 'PoE 电源模块',
      params: { width: 0.1, height: 0.038, depth: 0.17, label: 'PWR' },
      /* IEC 电源口朝向机箱背面：本地 +Z 旋转 180° 后指向 -Z。 */
      transform: { position: [-0.15, 0, -0.02], rotation: [0, Math.PI, 0] }
    },
    {
      part_id: 'fan_tray',
      kind: 'fan_tray',
      category: 'cooling',
      label: '风扇盘',
      params: { fan_count: 3, fan_size: 0.034, depth: 0.026, grille: true },
      transform: { position: [0.115, 0, -0.02] }
    },
    {
      part_id: 'board',
      kind: 'main_board',
      category: 'internal',
      label: '主板',
      params: { width: 0.4, depth: 0.18, color: '#14351f' },
      transform: { position: [0, 0.002, 0] }
    },
    {
      part_id: 'chip',
      kind: 'switch_chip',
      category: 'internal',
      label: '转发芯片',
      params: { width: 0.034, depth: 0.034, height: 0.0035 },
      transform: { position: [0, 0.007, 0] }
    }
  ],
  ports: [],
  leds: [
    { name: 'SYS', position: [-0.206, 0.013, 0.1135], color: '#3ddc84' },
    { name: 'PWR', position: [-0.192, 0.013, 0.1135], color: '#3ddc84' },
    { name: 'PoE', position: [-0.178, 0.013, 0.1135], color: '#ffb020' },
    { name: 'SPD', position: [-0.164, 0.013, 0.1135], color: '#00bcd4' }
  ]
};

export default template;
