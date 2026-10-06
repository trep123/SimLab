/**
 * @File : web/src/devices/templates/generic_atx_pc.ts
 * @Time : 2026-10-04 23:25
 * @Author : Codex
 * @Description : 通用 ATX 教学 PC 模板：主机、显示器、键鼠与真实 G0 VNC 显示区域。
 */

import type { DeviceTemplate } from '../template_types';

/** 模板：可绑定 simlab-g0-pc1 的通用 PC 工作站。 */
const template: DeviceTemplate = {
  model_id: 'generic-atx-pc',
  vendor_id: 'generic',
  display_name: '通用 x86_64 教学 PC',
  device_type: 'pc',
  dimensions: { width: 0.64, height: 0.46, depth: 0.48, u_height: 0 },
  rack_mountable: false,
  version: 1,
  origin: 'builtin',
  description: '带独立显示器、键鼠和 ATX 主机的教学工作站，可绑定真实 QEMU 桌面。',
  theme: { chassis_color: '#242a32', accent_color: '#37e0c9' },
  parts: [
    {
      part_id: 'workstation',
      kind: 'pc_workstation',
      category: 'chassis',
      label: 'PC 主机与显示器',
      params: { case_color: '#242a32', accent_color: '#37e0c9' }
    },
    {
      part_id: 'eth0',
      kind: 'network_port',
      category: 'port_module',
      label: '主板千兆网口',
      params: {
        connector: 'rj45',
        short_name: 'eth0',
        speed_bps: 1000000000,
        group_id: 'eth',
        /* 模块中心位于机箱背板 z=-0.1778m，旋转 180° 只改变接口朝向，不改变该位置。 */
        position: [0.22, 0, -0.1778]
      },
      transform: { rotation: [0, Math.PI, 0] }
    }
  ],
  ports: [],
  leds: [
    { name: 'PWR', position: [0.22, 0.125, 0.19], color: '#37e0c9' },
    { name: 'HDD', position: [0.244, 0.126, 0.19], color: '#ffb648' }
  ]
};

export default template;
