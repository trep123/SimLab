/**
 * @File : web/src/devices/templates/generic_onu_gpon.ts
 * @Time : 2026-10-06 15:00
 * @Author : Cetrp
 * @Description : 通用 GPON ONU（光猫）设备模板：1×GPON 上行光口 + 4×GE 用户口 + DC 电源，桌面式。
 */

import type { DeviceTemplate } from '../template_types';

/** 模板：通用 GPON ONU。 */
const template: DeviceTemplate = {
  model_id: 'generic-onu-gpon',
  vendor_id: 'generic',
  display_name: '通用 GPON ONU（4×GE 光猫）',
  device_type: 'onu',
  dimensions: { width: 0.16, height: 0.032, depth: 0.11, u_height: 0 },
  rack_mountable: false,
  version: 1,
  origin: 'builtin',
  description: '1×GPON 上行（SC/APC）+ 4×GE 用户口，桌面式光猫。',
  theme: { chassis_color: '#3c434c', accent_color: '#2f9e63' },
  parts: [
    {
      part_id: 'chassis',
      kind: 'desktop_chassis',
      category: 'chassis',
      label: '桌面机箱',
      params: { width: 0.16, height: 0.032, depth: 0.11, color: '#3c434c' }
    },
    {
      part_id: 'panel',
      kind: 'front_panel',
      category: 'front_panel',
      label: '前面板',
      params: {
        width: 0.16,
        height: 0.032,
        background: '#4a525c',
        brand_line: 'GPON ONU',
        sub_line: '1×GPON + 4×GE',
        power_button: true,
        console: false,
        usb: false,
        reset_pinhole: true,
        led_color: '#2f9e63'
      },
      transform: { position: [0, 0, 0.0555], rotation: [0, 0, 0] }
    },
    {
      part_id: 'lan_ports',
      kind: 'port_row',
      category: 'port_module',
      label: '4×GE 用户口',
      params: {
        connector: 'rj45',
        rows: 1,
        columns: 4,
        pitch_x: 0.019,
        origin: [0.012, -0.004, 0.0555],
        names: ['GE0/0/1', 'GE0/0/2', 'GE0/0/3', 'GE0/0/4'],
        speed_bps: 1000000000,
        group_id: 'lan'
      }
    },
    {
      part_id: 'pon_port',
      kind: 'single_port',
      category: 'port_module',
      label: 'GPON 上行光口',
      params: {
        connector: 'gpon',
        position: [-0.062, -0.002, 0.0555],
        short_name: 'GPON0/0/1',
        direction: [0, 0, 1]
      }
    },
    {
      part_id: 'power',
      kind: 'single_port',
      category: 'power',
      label: 'DC 电源口',
      params: {
        connector: 'power_dc_barrel',
        position: [-0.062, 0.008, 0.0555],
        short_name: 'POWER',
        direction: [0, 0, 1]
      }
    },
    {
      part_id: 'board',
      kind: 'main_board',
      category: 'internal',
      label: '主板',
      params: { width: 0.14, depth: 0.09, color: '#1d3a2a' },
      transform: { position: [0, 0.002, 0] }
    }
  ],
  ports: [],
  leds: [
    { name: 'PWR', position: [-0.05, 0.012, 0.058], color: '#2bff9a' },
    { name: 'LOS', position: [-0.036, 0.012, 0.058], color: '#ff5d6c' }
  ]
};

export default template;
