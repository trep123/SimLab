/**
 * @File : web/src/devices/templates/generic_laptop_wifi6.ts
 * @Time : 2026-10-05 22:10
 * @Author : Cetrp
 * @Description : 通用 Wi-Fi 6 笔记本电脑设备模板（底座 + 屏幕 + 键盘 + 内置天线 + 1×GE 网口）。
 *
 * 数据来源：assets/catalog/generic-laptop-wifi6.json 的 visual.chassis 与 visual.port_layout，
 * 端口名前缀/数量/类型/速率与资产严格一致；厂商差异只进数据，不改引擎。
 */

import type { DeviceTemplate } from '../template_types';

/** 模板：通用 Wi-Fi 6 笔记本电脑。 */
const template: DeviceTemplate = {
  model_id: 'generic-laptop-wifi6',
  vendor_id: 'generic',
  display_name: '通用 Wi-Fi 6 笔记本电脑',
  device_type: 'laptop',
  dimensions: { width: 0.34, height: 0.022, depth: 0.24, u_height: 0 },
  rack_mountable: false,
  version: 1,
  origin: 'builtin',
  description: '内置 Wi-Fi 6、1×GE 网口和可映射真实 QEMU 桌面的笔记本电脑终端。',
  theme: { chassis_color: '#9aa0a6', accent_color: '#00bcd4' },
  parts: [
    {
      part_id: 'base',
      kind: 'laptop_base',
      category: 'chassis',
      label: '笔记本底座',
      params: { width: 0.34, depth: 0.24, thickness: 0.016, color: '#9aa0a6' }
    },
    {
      part_id: 'lid',
      kind: 'laptop_lid',
      category: 'compute',
      label: '屏幕总成',
      params: { width: 0.34, height: 0.215, angle_deg: 104, glow: '#16233a' },
      transform: { position: [0, 0.008, -0.1] }
    },
    {
      part_id: 'keyboard',
      kind: 'keyboard',
      category: 'compute',
      label: '键盘与触控板',
      params: { width: 0.3, depth: 0.11, rows: 5, columns: 14, touchpad: true },
      transform: { position: [0, 0.009, 0.035] }
    },
    {
      part_id: 'eth_port',
      kind: 'port_row',
      category: 'port_module',
      label: '1×GE 网口',
      params: {
        connector: 'rj45',
        rows: 1,
        columns: 1,
        origin: [-0.168, 0, 0.06],
        names: ['ETH0/0/1'],
        speed_bps: 1000000000,
        group_id: 'eth'
      },
      /* 机身左侧：本地 +Z 旋转 -90° 后朝 -X（机身外）。 */
      transform: { rotation: [0, -Math.PI / 2, 0] }
    },
    {
      part_id: 'power',
      kind: 'single_port',
      category: 'power',
      label: 'DC 充电口',
      params: {
        connector: 'power_dc_barrel',
        position: [0.168, 0, 0.06],
        short_name: 'POWER',
        direction: [0, 0, 1]
      },
      /* 机身右侧：本地 +Z 旋转 +90° 后朝 +X（机身外）。 */
      transform: { rotation: [0, Math.PI / 2, 0] }
    },
    {
      part_id: 'internal_antennas',
      kind: 'internal_antenna',
      category: 'wireless',
      label: 'Wi-Fi 6 内置天线',
      params: { columns: 2, rows: 2, pitch: 0.02, size: 0.012 },
      transform: { position: [-0.09, 0.002, -0.06] }
    },
    {
      part_id: 'board',
      kind: 'main_board',
      category: 'internal',
      label: '主板',
      params: { width: 0.3, depth: 0.2, color: '#14351f' },
      transform: { position: [0, -0.002, 0] }
    },
    {
      part_id: 'heatsink',
      kind: 'heatsink',
      category: 'internal',
      label: '散热鳍片',
      params: { width: 0.06, height: 0.006, count: 10 },
      transform: { position: [0.08, 0.001, -0.05] }
    }
  ],
  ports: [],
  leds: [
    { name: 'PWR', position: [-0.05, 0.0105, 0.112], color: '#3ddc84' },
    { name: 'WLAN', position: [-0.036, 0.0105, 0.112], color: '#00bcd4' }
  ]
};

export default template;
