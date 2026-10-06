/**
 * @File : web/src/devices/parts/front_panel.ts
 * @Time : 2026-10-06 11:00
 * @Author : Cetrp
 * @Description : 参数化前面板部件：丝印贴图、电源按键、Console/USB 面板、复位孔与系统指示灯。
 */

import * as THREE from 'three';

import {
  COLOR,
  chassis_material,
  label_texture,
  led_dot,
  panel_texture,
  plastic_material,
  rj45_jack,
  rounded_box,
  screw
} from '../part_kit';
import type { PartDefinition } from '../template_types';

/** 读取数值参数。 */
function number_param(params: Record<string, unknown>, key: string, fallback: number): number {
  const value = params[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** 读取字符串参数。 */
function text_param(params: Record<string, unknown>, key: string, fallback: string): string {
  const value = params[key];
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

/**
 * 前面板：贴丝印的面板片 + 电源按键 + 系统指示灯 + Console/USB 开口 + 复位孔。
 *
 * 参数：`width`、`height`、`background`、`brand_line`、`sub_line`、`power_button`、
 * `console`、`usb`、`reset_pinhole`、`led_color`。
 *
 * @param {object} context 构建上下文。
 * @returns {THREE.Group} 面板组。
 */
function build_front_panel(context: {
  spec: { params: Record<string, unknown> };
  template: { model_id: string; display_name: string };
}): THREE.Group {
  const { spec, template } = context;
  const width = number_param(spec.params, 'width', 0.442);
  const height = number_param(spec.params, 'height', 0.044);
  const background = text_param(spec.params, 'background', '#9aa4ae');
  const brand_line = text_param(spec.params, 'brand_line', template.display_name);
  const sub_line = text_param(spec.params, 'sub_line', template.model_id);
  const group = new THREE.Group();

  const panel_map = panel_texture({
    width: width,
    height: height,
    background: background,
    brand_line: brand_line,
    sub_line: sub_line
  });
  const panel_depth = Math.max(0.0018, height * 0.055);
  const panel_body = new THREE.Mesh(
    rounded_box(width * 0.997, height * 0.965, panel_depth, height * 0.025),
    chassis_material(background, { metalness: 0.68, roughness: 0.4 })
  );
  group.add(panel_body);
  const panel = new THREE.Mesh(
    new THREE.PlaneGeometry(width * 0.995, height * 0.98),
    new THREE.MeshPhysicalMaterial({
      map: panel_map,
      metalness: 0.5,
      roughness: 0.42,
      clearcoat: 0.06,
      clearcoatRoughness: 0.72,
      envMapIntensity: 0.72
    })
  );
  panel.position.z = panel_depth / 2 + 0.00015;
  group.add(panel);

  /* 左侧控制区的压边与面板固定螺钉。 */
  const rack_panel = width / Math.max(height, 0.001) >= 4;
  if (rack_panel) {
    const divider = new THREE.Mesh(
      new THREE.BoxGeometry(height * 0.018, height * 0.72, panel_depth * 0.42),
      plastic_material('#20262d', 0.82)
    );
    divider.position.set(-width * 0.265, 0, panel_depth * 0.45);
    group.add(divider);
  }
  for (const x of [-width * 0.482, width * 0.482]) {
    for (const y of [-height * 0.31, height * 0.31]) {
      const fastener = screw(Math.max(0.00115, height * 0.028));
      fastener.position.set(x, y, panel_depth * 0.58);
      group.add(fastener);
    }
  }

  const led_color = text_param(spec.params, 'led_color', COLOR.light_blue);
  if (spec.params.power_button !== false) {
    const button_radius = height * 0.085;
    const button_x = -width * 0.455;
    const button = new THREE.Mesh(
      new THREE.CylinderGeometry(button_radius, button_radius, height * 0.075, 24),
      plastic_material('#2c333c', 0.45)
    );
    button.rotation.x = Math.PI / 2;
    button.position.set(button_x, 0, panel_depth * 0.58);
    /* 标记为电源键：设备对象据此把左键点击映射为开关机。 */
    button.name = 'power_button';
    button.userData.power_button = true;
    group.add(button);
    /* 加大拾取盘（不可见），让电源键更好点。 */
    const pick = new THREE.Mesh(
      new THREE.CylinderGeometry(height * 0.18, height * 0.18, height * 0.13, 20),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false })
    );
    pick.rotation.x = Math.PI / 2;
    pick.position.copy(button.position);
    pick.name = 'power_button_pick';
    pick.userData.power_button = true;
    group.add(pick);
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(button_radius * 1.35, button_radius * 0.13, 8, 24),
      chassis_material('#b9c3cd', { metalness: 0.82, roughness: 0.24 })
    );
    ring.position.set(button_x, 0, panel_depth * 0.62);
    group.add(ring);
    const power_mark = new THREE.Mesh(
      new THREE.BoxGeometry(button_radius * 0.18, button_radius * 0.88, panel_depth * 0.16),
      chassis_material('#d9e1e8', { metalness: 0.5, roughness: 0.45 })
    );
    power_mark.position.set(button_x, button_radius * 0.18, panel_depth * 0.7);
    group.add(power_mark);
    const power_led = led_dot(led_color, height * 0.034);
    power_led.position.set(button_x, height * 0.2, panel_depth * 0.7);
    group.add(power_led);
  }
  if (spec.params.console !== false) {
    const console_width = Math.min(0.0142, height * 0.32);
    const console_height = Math.min(0.0122, height * 0.27);
    const console_jack = rj45_jack(console_width, console_height, height * 0.2);
    console_jack.position.set(-width * 0.39, -height * 0.16, panel_depth * 0.72);
    group.add(console_jack);
    const console_label = new THREE.Mesh(
      new THREE.PlaneGeometry(height * 0.42, height * 0.095),
      new THREE.MeshBasicMaterial({
        map: label_texture('CONSOLE', '#d7e0e9', 96),
        transparent: true,
        depthWrite: false
      })
    );
    console_label.position.set(-width * 0.39, -height * 0.39, panel_depth * 0.8);
    group.add(console_label);
  }
  if (spec.params.usb !== false) {
    const usb_group = new THREE.Group();
    const usb_shell = new THREE.Mesh(
      rounded_box(height * 0.3, height * 0.15, panel_depth * 1.8, height * 0.012),
      chassis_material('#c5cdd5', { metalness: 0.86, roughness: 0.24 })
    );
    usb_group.add(usb_shell);
    const usb_core = new THREE.Mesh(
      new THREE.BoxGeometry(height * 0.23, height * 0.075, panel_depth * 1.9),
      plastic_material('#2767a5', 0.56)
    );
    usb_core.position.z = panel_depth * 0.22;
    usb_group.add(usb_core);
    usb_group.position.set(-width * 0.335, height * 0.13, panel_depth * 0.5);
    group.add(usb_group);
  }
  if (spec.params.reset_pinhole !== false) {
    const pinhole = new THREE.Mesh(
      new THREE.CylinderGeometry(height * 0.03, height * 0.03, 0.004, 10),
      plastic_material('#0b0e12', 0.95)
    );
    pinhole.rotation.x = Math.PI / 2;
    pinhole.position.set(-width * 0.29, -height * 0.16, panel_depth * 0.72);
    group.add(pinhole);
  }
  group.userData.panel_size = { width: width, height: height };

  return group;
}

/**
 * 独立指示灯簇（不依赖面板）。参数：`color`、`count`、`spacing`、`radius`、`labels`。
 *
 * @param {object} context 构建上下文。
 * @returns {THREE.Group} 指示灯组。
 */
function build_led_cluster(context: { spec: { params: Record<string, unknown> } }): THREE.Group {
  const { spec } = context;
  const color = text_param(spec.params, 'color', COLOR.light_blue);
  const count = Math.max(1, Math.round(number_param(spec.params, 'count', 4)));
  const spacing = number_param(spec.params, 'spacing', 0.012);
  const radius = number_param(spec.params, 'radius', 0.0022);
  const group = new THREE.Group();
  for (let index = 0; index < count; index += 1) {
    const led = led_dot(color, radius);
    led.position.set((index - (count - 1) / 2) * spacing, 0, 0.002);
    group.add(led);
  }

  return group;
}

/** Cloud 节点顶面的立体云标识，与下联插座保持独立部件。 */
function build_cloud_emblem(context: { spec: { params: Record<string, unknown> } }): THREE.Group {
  const color = text_param(context.spec.params, 'color', '#71d7ff');
  const group = new THREE.Group();
  const material = new THREE.MeshPhysicalMaterial({
    color, metalness: 0.18, roughness: 0.24, clearcoat: 0.85, clearcoatRoughness: 0.18
  });
  const base = new THREE.Mesh(rounded_box(0.07, 0.018, 0.008, 0.006), material);
  base.position.y = -0.006;
  group.add(base);
  for (const [x, y, radius] of [[-0.025, 0.001, 0.018], [0, 0.009, 0.025], [0.027, 0, 0.017]]) {
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(radius, 16, 12), material);
    bulb.scale.z = 0.38;
    bulb.position.set(x, y, 0);
    group.add(bulb);
  }
  return group;
}

/** 前面板相关部件注册表。 */
export const FRONT_PANEL_PARTS: PartDefinition[] = [
  {
    kind: 'cloud_emblem', category: 'front_panel', label: 'Cloud 立体云标识',
    defaults: { color: '#71d7ff' },
    schema: { color: { label: '云标识颜色', kind: 'color' } },
    build: build_cloud_emblem
  },
  {
    kind: 'front_panel',
    category: 'front_panel',
    label: '前面板（丝印 + 按键 + LED）',
    defaults: {
      width: 0.442,
      height: 0.044,
      background: '#9aa4ae',
      brand_line: '',
      sub_line: '',
      power_button: true,
      console: true,
      usb: true,
      reset_pinhole: true,
      led_color: COLOR.light_blue
    },
    schema: {
      width: { label: '宽（米）', min: 0.05, max: 0.6, step: 0.001 },
      height: { label: '高（米）', min: 0.01, max: 0.3, step: 0.001 },
      background: { label: '面板底色', kind: 'color' },
      brand_line: { label: '品牌线', kind: 'text' },
      power_button: { label: '电源键', kind: 'boolean' },
      console: { label: 'Console 口', kind: 'boolean' },
      usb: { label: 'USB 口', kind: 'boolean' }
    },
    build: build_front_panel
  },
  {
    kind: 'led_cluster',
    category: 'front_panel',
    label: '指示灯簇',
    defaults: { color: COLOR.light_blue, count: 4, spacing: 0.012, radius: 0.0022 },
    schema: {
      color: { label: '颜色', kind: 'color' },
      count: { label: '数量', min: 1, max: 12, step: 1 },
      spacing: { label: '间距（米）', min: 0.004, max: 0.03, step: 0.0005 }
    },
    build: build_led_cluster
  }
];
