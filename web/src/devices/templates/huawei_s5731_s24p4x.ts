/**
 * @File : web/src/devices/templates/huawei_s5731_s24p4x.ts
 * @Time : 2026-10-05 21:46
 * @Author : Cetrp
 * @Description : 华为 S5731-S24P4X 设备模板（24×GE PoE+ 电口 + 4×10GE SFP+，1U 机架式）。
 *
 * 数据来源：assets/catalog/huawei-s5731-s24p4x.json 的 visual.chassis 与 visual.port_layout，
 * 端口名前缀/数量/类型/速率与资产严格一致；厂商差异只进数据，不改引擎。
 */

import type { DeviceTemplate } from '../template_types';

/** 24 个千兆 PoE+ 电口的短名。 */
const GE_PORTS = Array.from({ length: 24 }, (unused, index) => 'GE0/0/' + (index + 1));

/** 4 个万兆光口的短名。 */
const XGE_PORTS = ['XGE0/0/1', 'XGE0/0/2', 'XGE0/0/3', 'XGE0/0/4'];

/** 模板：华为 S5731-S24P4X。 */
const template: DeviceTemplate = {
  model_id: 'huawei-s5731-s24p4x',
  vendor_id: 'huawei',
  display_name: '华为 S5731-S24P4X',
  device_type: 'switch',
  dimensions: { width: 0.442, height: 0.0436, depth: 0.22, u_height: 1 },
  rack_mountable: true,
  version: 1,
  origin: 'builtin',
  description: '24×GE PoE+（整机 400W）+ 4×10GE SFP+ 上行，1U 机架式 PoE 接入交换机。',
  theme: { chassis_color: '#c9ced6', accent_color: '#cf0a2c' },
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
        color: '#c9ced6',
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
        background: '#23272e',
        brand_line: 'HUAWEI S5731-S24P4X',
        sub_line: '24×GE PoE+ + 4×10GE',
        power_button: false,
        console: true,
        usb: true,
        reset_pinhole: true,
        led_color: '#cf0a2c'
      },
      transform: { position: [0, 0, 0.1105] }
    },
    {
      part_id: 'ge_ports',
      kind: 'port_row',
      category: 'port_module',
      label: '24×GE PoE+ 电口',
      params: {
        connector: 'rj45',
        rows: 2,
        columns: 12,
        numbering: 'column-major',
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
        rows: 2,
        columns: 2,
        pitch_x: 0.0205,
        pitch_y: 0.017,
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
      label: 'PoE 电源模块',
      params: { width: 0.1, height: 0.038, depth: 0.17, label: 'PWR' },
      /* IEC 电源口朝向机箱背面：本地 +Z 旋转 180° 后指向 -Z。 */
      transform: { position: [-0.15, 0, -0.02], rotation: [0, Math.PI, 0] }
    },
    {
      part_id: 'fan_tray',
      kind: 'fan_tray',
      category: 'cooling',
      label: '风扇盘',
      params: { fan_count: 3, fan_size: 0.034, depth: 0.026, grille: true },
      transform: { position: [0.115, 0, -0.02] }
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
    { name: 'PoE', position: [-0.178, 0.013, 0.1135], color: '#ffb020' },
    { name: 'SPED', position: [-0.164, 0.013, 0.1135], color: '#cf0a2c' }
  ]
};

export default template;
