/**
 * @File : web/src/devices/templates/generic_ap_ax3000.ts
 * @Time : 2026-10-05 22:04
 * @Author : Cetrp
 * @Description : 通用 Wi-Fi 6 吸顶 AP AX3000 设备模板（1×2.5GE 上联 + Console + 2 根外置天线）。
 *
 * 数据来源：assets/catalog/generic-ap-ax3000.json 的 visual.chassis 与 visual.port_layout，
 * 端口名前缀/数量/类型/速率与资产严格一致；厂商差异只进数据，不改引擎。
 */

import type { DeviceTemplate } from '../template_types';

/** 模板：通用 Wi-Fi 6 吸顶 AP AX3000。 */
const template: DeviceTemplate = {
  model_id: 'generic-ap-ax3000',
  vendor_id: 'generic',
  display_name: '通用 Wi-Fi 6 吸顶 AP AX3000',
  device_type: 'ap',
  dimensions: { width: 0.086, height: 0.02, depth: 0.086, u_height: 0 },
  rack_mountable: false,
  version: 1,
  origin: 'builtin',
  description: '1×2.5GE PoE 上联口 + Console，双频 Wi-Fi 6 吸顶/桌面接入点（2 根外置天线）。',
  theme: { chassis_color: '#9aa0a6', accent_color: '#00bcd4' },
  parts: [
    {
      part_id: 'chassis',
      kind: 'desktop_chassis',
      category: 'chassis',
      label: '吸顶机箱',
      params: { width: 0.086, height: 0.02, depth: 0.086, color: '#9aa0a6' }
    },
    {
      part_id: 'panel',
      kind: 'front_panel',
      category: 'front_panel',
      label: '顶面丝印面板',
      params: {
        width: 0.082,
        height: 0.082,
        background: '#2a2e33',
        brand_line: 'SIMLAB AP AX3000',
        sub_line: 'Wi-Fi 6 · 2.4G/5G',
        power_button: true,
        console: true,
        usb: false,
        reset_pinhole: true,
        led_color: '#00bcd4'
      },
      transform: { position: [0, 0.0102, 0], rotation: [-Math.PI / 2, 0, 0] }
    },
    {
      part_id: 'uplink_port',
      kind: 'port_row',
      category: 'port_module',
      label: '1×2.5GE 上联口',
      params: {
        connector: 'rj45',
        rows: 1,
        columns: 1,
        origin: [-0.025, 0, -0.043],
        names: ['GE0/0/1'],
        speed_bps: 1000000000,
        group_id: 'uplink',
        poe: true
      },
      transform: { rotation: [0, Math.PI, 0] }
    },
    {
      part_id: 'console_port',
      kind: 'port_row',
      category: 'port_module',
      label: 'Console 口',
      params: {
        connector: 'console_rj45',
        rows: 1,
        columns: 1,
        origin: [0.002, 0, -0.043],
        names: ['CON0/0/1'],
        speed_bps: 100000000,
        group_id: 'console'
      },
      transform: { rotation: [0, Math.PI, 0] }
    },
    {
      part_id: 'power',
      kind: 'single_port',
      category: 'power',
      label: 'DC 电源口',
      params: {
        connector: 'power_dc_barrel',
        position: [0.028, 0, -0.043],
        short_name: 'POWER',
        /* 部件绕 Y 轴翻转 180°，本地 +Z 即设备背面朝外方向。 */
        direction: [0, 0, 1]
      },
      transform: { rotation: [0, Math.PI, 0] }
    },
    {
      part_id: 'antennas',
      kind: 'antenna_array',
      category: 'wireless',
      label: '2×外置天线',
      params: {
        count: 2,
        length: 0.05,
        radius: 0.004,
        tilt_deg: 20,
        spread: 0.03,
        side: 'top',
        position: [0, 0.012, 0.016],
        base_plate: true
      }
    },
    {
      part_id: 'internal_antennas',
      kind: 'internal_antenna',
      category: 'wireless',
      label: '内置天线阵子',
      params: { columns: 2, rows: 2, pitch: 0.02, size: 0.012 },
      transform: { position: [0, -0.005, 0] }
    },
    {
      part_id: 'board',
      kind: 'main_board',
      category: 'internal',
      label: '主板',
      params: { width: 0.07, depth: 0.07, color: '#14351f' },
      transform: { position: [0, -0.007, 0] }
    }
  ],
  ports: [],
  leds: [
    { name: 'SYS', position: [-0.032, 0.0105, 0.022], color: '#3ddc84' },
    { name: 'PWR', position: [-0.018, 0.0105, 0.022], color: '#3ddc84' },
    { name: 'WLAN', position: [-0.004, 0.0105, 0.022], color: '#00bcd4' }
  ]
};

export default template;
