/**
 * @File : web/src/devices/templates/cisco_c2960x_24ts_l.ts
 * @Time : 2026-10-05 21:40
 * @Author : Cetrp
 * @Description : 思科 Catalyst 2960X-24TS-L 设备模板（24×GE 电口 + 2×SFP 上行，1U 机架式）。
 *
 * 数据来源：assets/catalog/cisco-c2960x-24ts-l.json 的 visual.chassis 与 visual.port_layout，
 * 端口名前缀/数量/类型/速率与资产严格一致；厂商差异只进数据，不改引擎。
 */

import type { DeviceTemplate } from '../template_types';

/** 24 个千兆电口的短名（Gi1/0/1 – Gi1/0/24）。 */
const GE_PORTS = Array.from({ length: 24 }, (unused, index) => 'Gi1/0/' + (index + 1));

/** 2 个 SFP 上行光口的短名（序号延续电口编号）。 */
const SFP_PORTS = ['Gi1/0/25', 'Gi1/0/26'];

/** 模板：思科 Catalyst 2960X-24TS-L。 */
const template: DeviceTemplate = {
  model_id: 'cisco-c2960x-24ts-l',
  vendor_id: 'cisco',
  display_name: '思科 Catalyst 2960X-24TS-L',
  device_type: 'switch',
  dimensions: { width: 0.442, height: 0.0436, depth: 0.22, u_height: 1 },
  rack_mountable: true,
  version: 1,
  origin: 'builtin',
  description: '24×10/100/1000BASE-T 电口 + 2×SFP 上行光口，1U 机架式接入交换机。',
  theme: { chassis_color: '#8e959c', accent_color: '#049fd9' },
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
        color: '#8e959c',
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
        background: '#2c3038',
        brand_line: 'CISCO Catalyst 2960X-24TS-L',
        sub_line: '24×GE + 2×SFP',
        power_button: false,
        console: true,
        usb: true,
        reset_pinhole: true,
        led_color: '#049fd9'
      },
      transform: { position: [0, 0, 0.1105] }
    },
    {
      part_id: 'ge_ports',
      kind: 'port_row',
      category: 'port_module',
      label: '24×GE 电口',
      params: {
        connector: 'rj45',
        rows: 2,
        columns: 12,
        numbering: 'column-major',
        pitch_x: 0.0172,
        pitch_y: 0.017,
        origin: [0.012, 0, 0.1105],
        names: GE_PORTS,
        speed_bps: 1000000000,
        group_id: 'ge'
      }
    },
    {
      part_id: 'sfp_ports',
      kind: 'port_row',
      category: 'port_module',
      label: '2×SFP 上行光口',
      params: {
        connector: 'sfp',
        rows: 1,
        columns: 2,
        pitch_x: 0.0205,
        origin: [0.19, 0, 0.1105],
        names: SFP_PORTS,
        speed_bps: 1000000000,
        group_id: 'sfp'
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
      label: '风扇盘',
      params: { fan_count: 2, fan_size: 0.038, depth: 0.026, grille: true },
      transform: { position: [0.12, 0, -0.02] }
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
    { name: 'SYST', position: [-0.206, 0.013, 0.1135], color: '#3ddc84' },
    { name: 'PWR', position: [-0.192, 0.013, 0.1135], color: '#3ddc84' },
    { name: 'SPD', position: [-0.178, 0.013, 0.1135], color: '#049fd9' }
  ]
};

export default template;
