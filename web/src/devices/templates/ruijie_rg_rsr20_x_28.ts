/**
 * @File : web/src/devices/templates/ruijie_rg_rsr20_x_28.ts
 * @Time : 2026-10-05 22:02
 * @Author : Cetrp
 * @Description : 锐捷 RG-RSR20-X-28 设备模板（4×GE Combo WAN + 24×GE LAN，1U 机架式路由器）。
 *
 * 数据来源：assets/catalog/ruijie-rg-rsr20-x-28.json 的 visual.chassis 与 visual.port_layout，
 * 端口名前缀/数量/类型/速率与资产严格一致；厂商差异只进数据，不改引擎。
 */

import type { DeviceTemplate } from '../template_types';

/** 4 个 GE Combo WAN 口（光电复用，模板以电口呈现）。 */
const WAN_PORTS = Array.from({ length: 4 }, (unused, index) => 'Gi0/' + index);

/** 24 个 GE LAN 交换口（序号延续 WAN 口编号，Gi0/4 – Gi0/27）。 */
const LAN_PORTS = Array.from({ length: 24 }, (unused, index) => 'Gi0/' + (index + 4));

/** 模板：锐捷 RG-RSR20-X-28。 */
const template: DeviceTemplate = {
  model_id: 'ruijie-rg-rsr20-x-28',
  vendor_id: 'ruijie',
  display_name: '锐捷 RG-RSR20-X-28',
  device_type: 'router',
  dimensions: { width: 0.442, height: 0.0436, depth: 0.24, u_height: 1 },
  rack_mountable: true,
  version: 1,
  origin: 'builtin',
  description: '4×GE Combo WAN + 24×GE LAN 交换口，1U 机架式多业务接入路由器。',
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
        depth: 0.24,
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
        brand_line: 'Ruijie RG-RSR20-X-28',
        sub_line: '4×GE Combo WAN + 24×GE LAN',
        power_button: true,
        console: true,
        usb: true,
        reset_pinhole: true,
        led_color: '#00a651'
      },
      transform: { position: [0, 0, 0.1205] }
    },
    {
      part_id: 'wan_ports',
      kind: 'port_row',
      category: 'port_module',
      label: '4×GE Combo WAN',
      params: {
        connector: 'rj45',
        rows: 1,
        columns: 4,
        pitch_x: 0.0172,
        origin: [-0.18, 0, 0.1205],
        names: WAN_PORTS,
        speed_bps: 1000000000,
        group_id: 'wan'
      }
    },
    {
      part_id: 'lan_ports',
      kind: 'port_row',
      category: 'port_module',
      label: '24×GE LAN 交换口',
      params: {
        connector: 'rj45',
        rows: 2,
        columns: 12,
        pitch_x: 0.0172,
        pitch_y: 0.017,
        origin: [0.012, 0, 0.1205],
        names: LAN_PORTS,
        speed_bps: 1000000000,
        group_id: 'lan'
      }
    },
    {
      part_id: 'psu',
      kind: 'psu_module',
      category: 'power',
      label: '内置电源',
      params: { width: 0.1, height: 0.036, depth: 0.18, label: 'PWR' },
      /* IEC 电源口朝向机箱背面：本地 +Z 旋转 180° 后指向 -Z；
         Z 位置前移 12 mm，避免电源尾部从机箱背面穿出。 */
      transform: { position: [-0.155, 0, -0.018], rotation: [0, Math.PI, 0] }
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
      transform: { position: [0, 0.002, 0] }
    },
    {
      part_id: 'chip',
      kind: 'switch_chip',
      category: 'internal',
      label: '转发芯片',
      params: { width: 0.034, depth: 0.034, height: 0.0035 },
      transform: { position: [0.04, 0.007, 0] }
    }
  ],
  ports: [],
  leds: [
    { name: 'SYS', position: [-0.206, 0.013, 0.1235], color: '#3ddc84' },
    { name: 'PWR', position: [-0.192, 0.013, 0.1235], color: '#3ddc84' },
    { name: 'SPD', position: [-0.178, 0.013, 0.1235], color: '#00a651' }
  ]
};

export default template;
