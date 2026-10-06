/**
 * @File : web/src/devices/templates/ruijie_rg_s2910_24gt4xs.ts
 * @Time : 2026-10-05 21:58
 * @Author : Cetrp
 * @Description : 锐捷 RG-S2910-24GT4XS 设备模板（24×GE + 4×10GE SFP+，1U 机架式交换机）。
 *
 * 数据来源：assets/catalog/ruijie-rg-s2910-24gt4xs.json 的 visual.chassis 与 visual.port_layout，
 * 端口名前缀/数量/类型/速率与资产严格一致；厂商差异只进数据，不改引擎。
 */

import type { DeviceTemplate } from '../template_types';

/** 24 个千兆电口的短名。 */
const GE_PORTS = Array.from({ length: 24 }, (unused, index) => 'Gi0/' + (index + 1));

/** 4 个万兆光口的短名（序号延续电口编号）。 */
const XGE_PORTS = Array.from({ length: 4 }, (unused, index) => 'Te0/' + (index + 25));

/** 模板：锐捷 RG-S2910-24GT4XS。 */
const template: DeviceTemplate = {
  model_id: 'ruijie-rg-s2910-24gt4xs',
  vendor_id: 'ruijie',
  display_name: '锐捷 RG-S2910-24GT4XS',
  device_type: 'switch',
  dimensions: { width: 0.442, height: 0.0436, depth: 0.22, u_height: 1 },
  rack_mountable: true,
  version: 1,
  origin: 'builtin',
  description: '24×10/100/1000BASE-T 电口 + 4×10GE SFP+ 上行，1U 机架式千兆接入交换机。',
  theme: { chassis_color: '#33373c', accent_color: '#00a651' },
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
        color: '#33373c',
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
        background: '#101317',
        brand_line: 'Ruijie RG-S2910-24GT4XS',
        sub_line: '24×GE + 4×10GE SFP+',
        power_button: false,
        console: true,
        usb: false,
        reset_pinhole: true,
        led_color: '#00a651'
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
        pitch_x: 0.0172,
        pitch_y: 0.017,
        origin: [0.012, 0, 0.1105],
        names: GE_PORTS,
        speed_bps: 1000000000,
        group_id: 'ge'
      }
    },
    {
      part_id: 'xge_ports',
      kind: 'port_row',
      category: 'port_module',
      label: '4×10GE SFP+ 光口',
      params: {
        connector: 'sfp_plus',
        rows: 1,
        columns: 4,
        pitch_x: 0.0205,
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
      params: { fan_count: 2, fan_size: 0.036, depth: 0.026, grille: true },
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
    { name: 'SYS', position: [-0.206, 0.013, 0.1135], color: '#3ddc84' },
    { name: 'PWR', position: [-0.192, 0.013, 0.1135], color: '#3ddc84' },
    { name: 'SPD', position: [-0.178, 0.013, 0.1135], color: '#00a651' }
  ]
};

export default template;
