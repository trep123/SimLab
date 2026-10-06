/**
 * @File : web/src/devices/templates/huawei_usg6300e.ts
 * @Time : 2026-10-05 21:48
 * @Author : Cetrp
 * @Description : 华为 USG6300E 设备模板（8×GE 电口 + 2×10GE SFP+，1U 机架式防火墙）。
 *
 * 数据来源：assets/catalog/huawei-usg6300e.json 的 visual.chassis 与 visual.port_layout，
 * 端口名前缀/数量/类型/速率与资产严格一致；厂商差异只进数据，不改引擎。
 */

import type { DeviceTemplate } from '../template_types';

/** 8 个千兆电口的短名（序号从 0 开始，与资产一致）。 */
const GE_PORTS = Array.from({ length: 8 }, (unused, index) => 'GE1/0/' + index);

/** 2 个万兆光口的短名（序号延续电口编号）。 */
const XGE_PORTS = ['XGE1/0/8', 'XGE1/0/9'];

/** 模板：华为 USG6300E。 */
const template: DeviceTemplate = {
  model_id: 'huawei-usg6300e',
  vendor_id: 'huawei',
  display_name: '华为 USG6300E',
  device_type: 'firewall',
  dimensions: { width: 0.442, height: 0.0436, depth: 0.22, u_height: 1 },
  rack_mountable: true,
  version: 1,
  origin: 'builtin',
  description: '8×GE 电口 + 2×10GE SFP+ 光口，1U 机架式企业边界防火墙。',
  theme: { chassis_color: '#c9ced6', accent_color: '#cf0a2c' },
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
        color: '#c9ced6',
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
        background: '#23272e',
        brand_line: 'HUAWEI USG6300E',
        sub_line: '8×GE + 2×10GE SFP+',
        power_button: true,
        console: true,
        usb: true,
        reset_pinhole: true,
        led_color: '#cf0a2c'
      },
      transform: { position: [0, 0, 0.1105] }
    },
    {
      part_id: 'ge_ports',
      kind: 'port_row',
      category: 'port_module',
      label: '8×GE 电口',
      params: {
        connector: 'rj45',
        rows: 2,
        columns: 4,
        pitch_x: 0.0172,
        pitch_y: 0.017,
        origin: [-0.12, 0, 0.1105],
        names: GE_PORTS,
        speed_bps: 1000000000,
        group_id: 'ge'
      }
    },
    {
      part_id: 'xge_ports',
      kind: 'port_row',
      category: 'port_module',
      label: '2×10GE 光口',
      params: {
        connector: 'sfp_plus',
        rows: 1,
        columns: 2,
        pitch_x: 0.0205,
        origin: [0.19, 0, 0.1105],
        names: XGE_PORTS,
        speed_bps: 10000000000,
        group_id: 'xg'
      }
    },
    {
      part_id: 'psu',
      kind: 'psu_module',
      category: 'power',
      label: '内置电源',
      params: { width: 0.1, height: 0.036, depth: 0.16, label: 'PWR' },
      /* IEC 电源口朝向机箱背面：本地 +Z 旋转 180° 后指向 -Z。 */
      transform: { position: [-0.155, 0, -0.02], rotation: [0, Math.PI, 0] }
    },
    {
      part_id: 'fan_tray',
      kind: 'fan_tray',
      category: 'cooling',
      label: '侧吹风扇盘',
      params: { fan_count: 2, fan_size: 0.034, depth: 0.024, grille: true },
      transform: { position: [-0.16, 0, 0.02], rotation: [0, Math.PI / 2, 0] }
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
      label: '安全转发芯片',
      params: { width: 0.034, depth: 0.034, height: 0.0035 },
      transform: { position: [0.04, 0.007, 0] }
    }
  ],
  ports: [],
  leds: [
    { name: 'SYS', position: [-0.206, 0.013, 0.1135], color: '#3ddc84' },
    { name: 'PWR', position: [-0.192, 0.013, 0.1135], color: '#3ddc84' },
    { name: 'ALM', position: [-0.178, 0.013, 0.1135], color: '#ff5d6c' },
    { name: 'SPD', position: [-0.164, 0.013, 0.1135], color: '#cf0a2c' }
  ]
};

export default template;
