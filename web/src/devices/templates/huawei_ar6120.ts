/**
 * @File : web/src/devices/templates/huawei_ar6120.ts
 * @Time : 2026-10-05 21:44
 * @Author : Cetrp
 * @Description : 华为 AR6120 设备模板（2×GE Combo WAN + 8×GE LAN，桌面式企业路由器）。
 *
 * 数据来源：assets/catalog/huawei-ar6120.json 的 visual.chassis 与 visual.port_layout，
 * 端口名前缀/数量/类型/速率与资产严格一致；厂商差异只进数据，不改引擎。
 */

import type { DeviceTemplate } from '../template_types';

/** 2 个 GE Combo WAN 口（RJ45/SFP 光电复用，模板以电口呈现）。 */
const WAN_PORTS = ['GE0/0/0', 'GE0/0/1'];

/** 8 个 GE LAN 口（序号延续 WAN 口编号）。 */
const LAN_PORTS = Array.from({ length: 8 }, (unused, index) => 'GE0/0/' + (index + 2));

/** 模板：华为 AR6120。 */
const template: DeviceTemplate = {
  model_id: 'huawei-ar6120',
  vendor_id: 'huawei',
  display_name: '华为 AR6120',
  device_type: 'router',
  dimensions: { width: 0.32, height: 0.044, depth: 0.22, u_height: 0 },
  rack_mountable: false,
  version: 1,
  origin: 'builtin',
  description: '2×GE Combo WAN + 8×GE LAN 交换口，桌面式企业接入路由器。',
  theme: { chassis_color: '#c9ced6', accent_color: '#cf0a2c' },
  parts: [
    {
      part_id: 'chassis',
      kind: 'desktop_chassis',
      category: 'chassis',
      label: '桌面机箱',
      params: { width: 0.32, height: 0.044, depth: 0.22, color: '#c9ced6' }
    },
    {
      part_id: 'panel',
      kind: 'front_panel',
      category: 'front_panel',
      label: '前面板',
      params: {
        width: 0.32,
        height: 0.044,
        background: '#23272e',
        brand_line: 'HUAWEI AR6120',
        sub_line: '2×GE Combo WAN + 8×GE LAN',
        power_button: true,
        console: true,
        usb: true,
        reset_pinhole: true,
        led_color: '#cf0a2c'
      },
      transform: { position: [0, 0, 0.1105] }
    },
    {
      part_id: 'wan_ports',
      kind: 'port_row',
      category: 'port_module',
      label: '2×GE Combo WAN',
      params: {
        connector: 'rj45',
        rows: 1,
        columns: 2,
        pitch_x: 0.019,
        origin: [-0.1, 0, 0.1105],
        names: WAN_PORTS,
        speed_bps: 1000000000,
        group_id: 'wan'
      }
    },
    {
      part_id: 'lan_ports',
      kind: 'port_row',
      category: 'port_module',
      label: '8×GE LAN',
      params: {
        connector: 'rj45',
        rows: 1,
        columns: 8,
        pitch_x: 0.0172,
        origin: [0.03, 0, 0.1105],
        names: LAN_PORTS,
        speed_bps: 1000000000,
        group_id: 'lan'
      }
    },
    {
      part_id: 'power',
      kind: 'single_port',
      category: 'power',
      label: 'DC 电源口',
      params: {
        connector: 'power_dc_barrel',
        position: [-0.13, 0, -0.1105],
        short_name: 'POWER',
        /* 部件绕 Y 轴翻转 180°，本地 +Z 即设备背面朝外方向。 */
        direction: [0, 0, 1]
      },
      transform: { rotation: [0, Math.PI, 0] }
    },
    {
      part_id: 'fan_tray',
      kind: 'fan_tray',
      category: 'cooling',
      label: '无风扇被动散热片',
      params: { fan_count: 1, fan_size: 0.03, depth: 0.022, grille: false },
      transform: { position: [0.12, 0, -0.04] }
    },
    {
      part_id: 'board',
      kind: 'main_board',
      category: 'internal',
      label: '主板',
      params: { width: 0.28, depth: 0.18, color: '#14351f' },
      transform: { position: [0, 0.002, 0] }
    },
    {
      part_id: 'chip',
      kind: 'switch_chip',
      category: 'internal',
      label: '转发芯片',
      params: { width: 0.03, depth: 0.03, height: 0.0032 },
      transform: { position: [-0.04, 0.007, 0] }
    }
  ],
  ports: [],
  leds: [
    { name: 'SYS', position: [-0.15, 0.013, 0.1135], color: '#3ddc84' },
    { name: 'PWR', position: [-0.136, 0.013, 0.1135], color: '#3ddc84' },
    { name: 'WAN', position: [-0.122, 0.013, 0.1135], color: '#cf0a2c' }
  ]
};

export default template;
