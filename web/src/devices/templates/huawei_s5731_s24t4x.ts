/**
 * @File : web/src/devices/templates/huawei_s5731_s24t4x.ts
 * @Time : 2026-10-06 14:40
 * @Author : Cetrp
 * @Description : 华为 CloudEngine S5731-S24T4X 设备模板（24×GE 电口 + 4×10GE 光口，1U 机架式）。
 *
 * 本文件只描述"这台设备长什么样、有哪些接口"；行为（CLI/转发/仿真）由运行时与 Manifest 决定。
 * 新增设备时复制本文件、改参数即可，无需改动引擎。
 */

import type { DeviceTemplate } from '../template_types';

/** 24 个千兆电口的短名。 */
const GE_PORTS = Array.from({ length: 24 }, (unused, index) => 'GE0/0/' + (index + 1));

/** 4 个万兆光口的短名。 */
const XGE_PORTS = ['XGE0/0/1', 'XGE0/0/2', 'XGE0/0/3', 'XGE0/0/4'];

/** 模板：华为 S5731-S24T4X。 */
const template: DeviceTemplate = {
  model_id: 'huawei-s5731-s24t4x',
  vendor_id: 'huawei',
  display_name: '华为 CloudEngine S5731-S24T4X',
  device_type: 'switch',
  dimensions: { width: 0.442, height: 0.0436, depth: 0.22, u_height: 1 },
  rack_mountable: true,
  version: 1,
  origin: 'builtin',
  description: '24×10/100/1000BASE-T 电口 + 4×10GE SFP+ 上行，1U 盒式交换机。',
  theme: { chassis_color: '#c9cfd6', accent_color: '#37e0c9' },
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
        color: '#c9cfd6',
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
        background: '#9aa4ae',
        brand_line: 'HUAWEI CloudEngine S5731-S24T4X',
        sub_line: '24×GE + 4×10GE',
        power_button: true,
        console: true,
        usb: true,
        reset_pinhole: true,
        led_color: '#37e0c9'
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
        group_id: 'ge',
        poe: true
      }
    },
    {
      part_id: 'xge_ports',
      kind: 'port_row',
      category: 'port_module',
      label: '4×10GE 光口',
      params: {
        connector: 'sfp_plus',
        rows: 1,
        columns: 4,
        pitch_x: 0.0205,
        origin: [0.168, 0, 0.1105],
        names: XGE_PORTS,
        speed_bps: 10000000000,
        group_id: 'xge'
      }
    },
    {
      part_id: 'psu',
      kind: 'psu_module',
      category: 'power',
      label: '内置电源',
      params: { width: 0.1, height: 0.04, depth: 0.16, label: 'PWR' },
      transform: { position: [-0.16, 0, -0.02] }
    },
    {
      part_id: 'fan_tray',
      kind: 'fan_tray',
      category: 'cooling',
      label: '风扇盘',
      params: { fan_count: 2, fan_size: 0.038, depth: 0.026, grille: true },
      transform: { position: [0.12, 0, 0.02] }
    },
    {
      part_id: 'board',
      kind: 'main_board',
      category: 'internal',
      label: '主板',
      params: { width: 0.4, depth: 0.18, color: '#1d3a2a' },
      transform: { position: [0, 0.004, 0] }
    },
    {
      part_id: 'chip',
      kind: 'switch_chip',
      category: 'internal',
      label: '转发芯片',
      params: { width: 0.034, depth: 0.034, height: 0.0035 },
      transform: { position: [0, 0.01, 0] }
    },
    {
      part_id: 'heatsink',
      kind: 'heatsink',
      category: 'internal',
      label: '散热鳍片',
      params: { width: 0.05, height: 0.012, count: 14 },
      transform: { position: [0, 0.016, 0] }
    }
  ],
  ports: [],
  leds: [
    { name: 'SYS', position: [-0.2, 0.012, 0.113], color: '#37e0c9' },
    { name: 'PWR', position: [-0.185, 0.012, 0.113], color: '#2bff9a' }
  ]
};

export default template;
