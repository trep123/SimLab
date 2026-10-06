/**
 * @File : web/src/devices/templates/cisco_isr4331.ts
 * @Time : 2026-10-05 21:42
 * @Author : Cetrp
 * @Description : 思科 ISR4331 设备模板（3×GE 路由口 + 2 个 NIM 扩展插槽，1U 机架式）。
 *
 * 数据来源：assets/catalog/cisco-isr4331.json 的 visual.chassis 与 visual.port_layout，
 * 端口名前缀/数量/类型/速率与资产严格一致；厂商差异只进数据，不改引擎。
 */

import type { DeviceTemplate } from '../template_types';

/** 3 个千兆路由口的短名（序号从 0 开始，与资产一致）。 */
const GE_PORTS = ['Gi0/0/0', 'Gi0/0/1', 'Gi0/0/2'];

/** 模板：思科 ISR4331。 */
const template: DeviceTemplate = {
  model_id: 'cisco-isr4331',
  vendor_id: 'cisco',
  display_name: '思科 ISR4331',
  device_type: 'router',
  dimensions: { width: 0.442, height: 0.0436, depth: 0.26, u_height: 1 },
  rack_mountable: true,
  version: 1,
  origin: 'builtin',
  description: '3×GE 路由口 + 2 个 NIM 扩展插槽，1U 机架式企业分支路由器。',
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
        depth: 0.26,
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
        brand_line: 'CISCO ISR4331',
        sub_line: '3×GE + NIM Slot',
        power_button: true,
        console: true,
        usb: true,
        reset_pinhole: false,
        led_color: '#049fd9'
      },
      transform: { position: [0, 0, 0.1305] }
    },
    {
      part_id: 'ge_ports',
      kind: 'port_row',
      category: 'port_module',
      label: '3×GE 路由口',
      params: {
        connector: 'rj45',
        rows: 1,
        columns: 3,
        pitch_x: 0.019,
        origin: [-0.16, 0, 0.1305],
        names: GE_PORTS,
        speed_bps: 1000000000,
        group_id: 'ge'
      }
    },
    {
      part_id: 'nim_slot_0',
      kind: 'psu_bay',
      category: 'port_module',
      label: 'NIM 扩展插槽 1（空）',
      params: { width: 0.108, height: 0.032, depth: 0.012 },
      transform: { position: [-0.02, 0, 0.1305] }
    },
    {
      part_id: 'nim_slot_1',
      kind: 'psu_bay',
      category: 'port_module',
      label: 'NIM 扩展插槽 2（空）',
      params: { width: 0.108, height: 0.032, depth: 0.012 },
      transform: { position: [0.1, 0, 0.1305] }
    },
    {
      part_id: 'psu',
      kind: 'psu_module',
      category: 'power',
      label: '内置电源',
      params: { width: 0.1, height: 0.036, depth: 0.18, label: 'PWR' },
      /* IEC 电源口朝向机箱背面：本地 +Z 旋转 180° 后指向 -Z。 */
      transform: { position: [-0.155, 0, -0.03], rotation: [0, Math.PI, 0] }
    },
    {
      part_id: 'fan_tray',
      kind: 'fan_tray',
      category: 'cooling',
      label: '侧吹风扇盘',
      params: { fan_count: 2, fan_size: 0.036, depth: 0.024, grille: true },
      transform: { position: [-0.16, 0, 0.02], rotation: [0, Math.PI / 2, 0] }
    },
    {
      part_id: 'board',
      kind: 'main_board',
      category: 'internal',
      label: '主板',
      params: { width: 0.4, depth: 0.2, color: '#14351f' },
      transform: { position: [0, 0.002, -0.01] }
    },
    {
      part_id: 'chip',
      kind: 'switch_chip',
      category: 'internal',
      label: '转发芯片',
      params: { width: 0.034, depth: 0.034, height: 0.0035 },
      transform: { position: [0.04, 0.007, -0.01] }
    }
  ],
  ports: [],
  leds: [
    { name: 'SYST', position: [-0.206, 0.013, 0.1335], color: '#3ddc84' },
    { name: 'PWR', position: [-0.192, 0.013, 0.1335], color: '#3ddc84' },
    { name: 'SPD', position: [-0.178, 0.013, 0.1335], color: '#049fd9' }
  ]
};

export default template;
