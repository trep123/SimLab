/**
 * @File : web/src/devices/templates/generic_phone_wifi6.ts
 * @Time : 2026-10-07 20:40
 * @Author : Cetrp
 * @Description : 通用 Wi-Fi 6 智能手机设备模板（重新设计：平放真机形态）。
 *
 *               形态说明：手机**平放在台面上**（X = 宽 71.5 mm，Y = 厚 8.5 mm，Z = 长 152 mm），
 *               正面玻璃朝上、后盖与镜头模组朝下，右侧电源键、左侧音量键，底部扬声器与 USB-C。
 *               这样与笔记本/AP/ONU 等桌面设备保持同一视觉语言，也符合真机摆在实验台上的样子。
 *               此前模板让手机**竖立**（16 cm 高 → 场景里 3.2 单位，比 1U 交换机还高），
 *               且内置天线的金色贴片露在机外，观感像"竖立的薄板"。
 *
 * 数据来源：assets/catalog/generic-phone-wifi6.json 的 visual.chassis 与 visual.port_layout，
 * 端口名前缀/数量/类型/速率与资产严格一致；厂商差异只进数据，不改引擎。
 */

import type { DeviceTemplate } from '../template_types';

/** 手机宽度（米，与资产 chassis.width 一致）。 */
const PHONE_WIDTH = 0.0715;

/** 机身长度（米；资产 0.16 是竖立时屏幕高度，平放后成为机身长度）。 */
const PHONE_LENGTH = 0.152;

/** 机身厚度（米；真机厚度 8.5 mm，平放后即场景中的高度）。 */
const PHONE_THICKNESS = 0.0085;

/** 模板：通用 Wi-Fi 6 智能手机。 */
const template: DeviceTemplate = {
  model_id: 'generic-phone-wifi6',
  vendor_id: 'generic',
  display_name: '通用 Wi-Fi 6 智能手机',
  device_type: 'phone',
  dimensions: { width: PHONE_WIDTH, height: PHONE_THICKNESS, depth: PHONE_LENGTH, u_height: 0 },
  rack_mountable: false,
  version: 1,
  origin: 'builtin',
  description: '平放于台面的 Wi-Fi 6 智能手机无线终端，内置天线与 USB-C 数据/充电口。',
  theme: { chassis_color: '#2a2f36', accent_color: '#00bcd4' },
  parts: [
    {
      part_id: 'chassis',
      kind: 'phone_body',
      category: 'chassis',
      label: '手机机身（中框 + 玻璃 + 后盖 + 镜头）',
      params: {
        width: PHONE_WIDTH,
        length: PHONE_LENGTH,
        thickness: PHONE_THICKNESS,
        color: '#2a2f36'
      }
    },
    {
      part_id: 'back_label',
      kind: 'front_panel',
      category: 'front_panel',
      label: '后盖丝印',
      params: {
        width: PHONE_WIDTH * 0.72,
        height: PHONE_LENGTH * 0.34,
        background: '#31363d',
        brand_line: 'SIMLAB PHONE',
        sub_line: 'Wi-Fi 6 STA',
        power_button: false,
        console: false,
        usb: false,
        reset_pinhole: false,
        led_color: '#00bcd4'
      },
      /* 贴在机身背面（-Y），朝下并旋转到可读方向。 */
      transform: {
        position: [0, -PHONE_THICKNESS * 0.56, PHONE_LENGTH * 0.06],
        rotation: [Math.PI / 2, 0, 0]
      }
    },
    {
      part_id: 'usb_port',
      kind: 'port_row',
      category: 'port_module',
      label: 'USB-C 口（机身下沿）',
      params: {
        connector: 'usb',
        rows: 1,
        columns: 1,
        origin: [0, 0, -PHONE_LENGTH / 2],
        names: ['USB0/0/1'],
        speed_bps: 100000000,
        group_id: 'usb'
      },
      /* 机身下沿朝 -Z：绕 Y 轴转 180° 让插座开口朝外。 */
      transform: { rotation: [0, Math.PI, 0] }
    },
    {
      part_id: 'antennas',
      kind: 'internal_antenna',
      category: 'wireless',
      label: 'Wi-Fi 6 内置天线',
      params: {
        columns: 2,
        rows: 1,
        pitch: PHONE_WIDTH * 0.5,
        size: PHONE_WIDTH * 0.14
      },
      /* 收进机身内部（透视/爆炸模式可见）；internal_antenna 本就平铺在 XZ 平面。 */
      transform: { position: [0, PHONE_THICKNESS * 0.05, PHONE_LENGTH * 0.42] }
    },
    {
      part_id: 'battery',
      kind: 'battery_pack',
      category: 'power',
      label: '锂聚合物电池（平放）',
      params: {
        width: PHONE_WIDTH * 0.62,
        depth: PHONE_LENGTH * 0.52,
        height: PHONE_THICKNESS * 0.45,
        color: '#1d2733'
      },
      /* battery_pack 本身就是平铺薄板（X 宽 / Y 厚 / Z 长），不需要旋转。 */
      transform: { position: [0, -PHONE_THICKNESS * 0.12, -PHONE_LENGTH * 0.14] }
    },
    {
      part_id: 'board',
      kind: 'main_board',
      category: 'internal',
      label: '主板',
      params: { width: PHONE_WIDTH * 0.9, depth: PHONE_LENGTH * 0.5, color: '#14351f' },
      /* main_board 平铺在 XZ 平面（厚度仅 1.6 mm），无需旋转。 */
      transform: { position: [0, PHONE_THICKNESS * 0.12, PHONE_LENGTH * 0.2] }
    },
    {
      part_id: 'chip',
      kind: 'switch_chip',
      category: 'internal',
      label: '基带/SoC 芯片',
      params: {
        width: PHONE_WIDTH * 0.34,
        depth: PHONE_WIDTH * 0.34,
        height: PHONE_THICKNESS * 0.3
      },
      transform: { position: [0, PHONE_THICKNESS * 0.22, PHONE_LENGTH * 0.16] }
    },
    {
      part_id: 'camera_module',
      kind: 'internal_antenna',
      category: 'internal',
      label: '后摄模组（内部）',
      params: { columns: 2, rows: 2, pitch: PHONE_WIDTH * 0.16, size: PHONE_WIDTH * 0.12 },
      transform: {
        position: [-PHONE_WIDTH * 0.2, -PHONE_THICKNESS * 0.22, -PHONE_LENGTH * 0.34]
      }
    }
  ],
  ports: [],
  leds: [
    {
      name: 'PWR',
      position: [-PHONE_WIDTH * 0.16, PHONE_THICKNESS * 0.62, PHONE_LENGTH * 0.47],
      color: '#3ddc84'
    },
    {
      name: 'WLAN',
      position: [0, PHONE_THICKNESS * 0.62, PHONE_LENGTH * 0.47],
      color: '#00bcd4'
    },
    {
      name: 'CHG',
      position: [PHONE_WIDTH * 0.16, PHONE_THICKNESS * 0.62, PHONE_LENGTH * 0.47],
      color: '#ffb020'
    }
  ]
};

export default template;
