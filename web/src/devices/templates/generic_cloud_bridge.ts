import type { DeviceTemplate } from '../template_types';

const template: DeviceTemplate = {
  model_id: 'generic-cloud-bridge',
  vendor_id: 'generic',
  display_name: 'Cloud 桥接网络（4×GE）',
  device_type: 'cloud',
  dimensions: { width: 0.18, height: 0.05, depth: 0.12, u_height: 0 },
  rack_mountable: false,
  version: 1,
  origin: 'builtin',
  description: '上联到管理员开放的宿主 OVS 桥，下联 4 个以太网口接实验设备。',
  theme: { chassis_color: '#1b354d', accent_color: '#38bdf8' },
  parts: [
    { part_id: 'chassis', kind: 'desktop_chassis', category: 'chassis', label: 'Cloud 网关外壳',
      params: { width: 0.18, height: 0.05, depth: 0.12, color: '#1b354d' } },
    { part_id: 'panel', kind: 'front_panel', category: 'front_panel', label: '桥接状态面板',
      params: { width: 0.18, height: 0.05, background: '#244963', brand_line: 'SIMLAB CLOUD',
        sub_line: 'HOST BRIDGE  ·  4×GE', power_button: false, console: false,
        usb: false, reset_pinhole: false, led_color: '#38bdf8' },
      transform: { position: [0, 0, 0.0605] } },
    { part_id: 'cloud_symbol', kind: 'cloud_emblem', category: 'front_panel',
      label: '顶部立体云标识', params: { color: '#71d7ff' },
      transform: { position: [0, 0.026, -0.012], rotation: [-Math.PI / 2, 0, 0] } },
    { part_id: 'downlink', kind: 'port_row', category: 'port_module', label: '4×GE 下联口',
      params: { connector: 'rj45', rows: 1, columns: 4, pitch_x: 0.028,
        origin: [-0.042, -0.005, 0.0605], names: ['eth0', 'eth1', 'eth2', 'eth3'],
        speed_bps: 1000000000, group_id: 'downlink' } }
  ],
  ports: [],
  leds: [
    { name: 'HOST', position: [-0.07, 0.018, 0.063], color: '#38bdf8' },
    { name: 'LINK', position: [-0.055, 0.018, 0.063], color: '#2bff9a' }
  ]
};

export default template;
