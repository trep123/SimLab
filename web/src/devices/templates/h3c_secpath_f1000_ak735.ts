/**
 * @File : web/src/devices/templates/h3c_secpath_f1000_ak735.ts
 * @Time : 2026-10-05 21:56
 * @Author : Cetrp
 * @Description : 新华三 SecPath F1000-AK735 设备模板（8×GE 电口 + 2×GE SFP，1U 机架式防火墙）。
 *
 * 数据来源：assets/catalog/h3c-secpath-f1000-ak735.json 的 visual.chassis 与 visual.port_layout，
 * 端口名前缀/数量/类型/速率与资产严格一致（SFP 口序号延续电口编号）；厂商差异只进数据。
 */

import type { DeviceTemplate } from '../template_types';

/** 8 个千兆电口的短名（GE1/0/1 为默认 WAN 口）。 */
const GE_PORTS = Array.from({ length: 8 }, (unused, index) => 'GE1/0/' + (index + 1));

/** 2 个 GE SFP 光口的短名（序号延续电口编号）。 */
const SFP_PORTS = ['GE1/0/9', 'GE1/0/10'];

/** 模板：新华三 SecPath F1000-AK735。 */
const template: DeviceTemplate = {
  model_id: 'h3c-secpath-f1000-ak735',
  vendor_id: 'h3c',
  display_name: '新华三 SecPath F1000-AK735',
  device_type: 'firewall',
  dimensions: { width: 0.442, height: 0.0436, depth: 0.22, u_height: 1 },
  rack_mountable: true,
  version: 1,
  origin: 'builtin',
  description: '8×GE 电口 + 2×GE SFP 光口，1U 机架式企业下一代防火墙。',
  theme: { chassis_color: '#33383f', accent_color: '#00a6a6' },
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
        color: '#33383f',
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
        background: '#15181c',
        brand_line: 'H3C SecPath F1000-AK735',
        sub_line: '8×GE + 2×GE SFP',
        power_button: true,
        console: true,
        usb: true,
        reset_pinhole: true,
        led_color: '#00a6a6'
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
      part_id: 'sfp_ports',
      kind: 'port_row',
      category: 'port_module',
      label: '2×GE SFP 光口',
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
    { name: 'SPD', position: [-0.164, 0.013, 0.1135], color: '#00a6a6' }
  ]
};

export default template;
