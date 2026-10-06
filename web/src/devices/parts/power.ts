/**
 * @File : web/src/devices/parts/power.ts
 * @Time : 2026-10-06 11:20
 * @Author : Cetrp
 * @Description : 参数化电源部件：机架电源模块（IEC 口 + 开关 + 风扇）、桌面适配器插座与冗余电源位。
 */

import * as THREE from 'three';

import {
  COLOR,
  chassis_material,
  fan_module,
  iec_c14_jack,
  label_texture,
  plastic_material,
  rounded_box,
  vent_grille
} from '../part_kit';
import type { PartDefinition } from '../template_types';

/** 读取数值参数。 */
/**
 * 读取颜色参数（缺省回退）。
 *
 * @param {Record<string, unknown>} params 参数表。
 * @param {string} key 参数名。
 * @param {string} fallback 缺省值。
 * @returns {string} 颜色字符串。
 */
function color_param(params: Record<string, unknown>, key: string, fallback: string): string {
  const value = params[key];

  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

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
 * 机架电源模块：金属外壳 + IEC C14 插座 + 电源开关 + 进气风扇 + 把手。
 *
 * 参数：`width`、`height`、`depth`、`label`。
 *
 * @param {object} context 构建上下文。
 * @returns {THREE.Group} 电源模块组（`userData.port_slots` 含电源口锚点）。
 */
function build_psu_module(context: { spec: { params: Record<string, unknown> } }): THREE.Group {
  const { spec } = context;
  const width = number_param(spec.params, 'width', 0.1);
  const height = number_param(spec.params, 'height', 0.04);
  const depth = number_param(spec.params, 'depth', 0.2);
  const label = text_param(spec.params, 'label', 'PWR');
  const group = new THREE.Group();
  const shell = new THREE.Mesh(
    rounded_box(width, height, depth, 0.0014),
    chassis_material(COLOR.chassis_mid, { metalness: 0.65, roughness: 0.4 })
  );
  shell.name = 'psu_metal_shell';
  group.add(shell);

  /* 独立后挡板形成模块接缝，避免电源与机箱看起来像一整块。 */
  const rear_plate = new THREE.Mesh(
    rounded_box(width * 0.985, height * 0.94, 0.003, 0.0012),
    chassis_material('#505862', { metalness: 0.72, roughness: 0.4 })
  );
  rear_plate.position.z = depth / 2 + 0.0012;
  rear_plate.name = 'psu_rear_plate';
  group.add(rear_plate);

  const socket = iec_c14_jack();
  socket.position.set(width * 0.16, -height * 0.03, depth / 2 + 0.0045);
  socket.name = 'iec_c14_inlet';
  group.add(socket);

  const switch_bezel = new THREE.Mesh(
    rounded_box(width * 0.19, height * 0.32, 0.004, 0.001),
    plastic_material('#0b0e12', 0.72)
  );
  switch_bezel.position.set(-width * 0.29, height * 0.03, depth / 2 + 0.004);
  switch_bezel.name = 'psu_switch_bezel';
  group.add(switch_bezel);
  const rocker = new THREE.Mesh(
    rounded_box(width * 0.145, height * 0.235, 0.003, 0.0008),
    plastic_material('#9b272c', 0.42)
  );
  rocker.rotation.x = -0.12;
  rocker.position.set(-width * 0.29, height * 0.032, depth / 2 + 0.0062);
  rocker.name = 'psu_power_switch';
  group.add(rocker);

  const rating = new THREE.Mesh(
    new THREE.PlaneGeometry(width * 0.35, height * 0.1),
    new THREE.MeshBasicMaterial({
      map: label_texture('100-240V~', '#c8d0d8', 192),
      transparent: true,
      depthWrite: false
    })
  );
  rating.position.set(width * 0.15, height * 0.4, depth / 2 + 0.0075);
  rating.name = 'psu_rating_label';
  group.add(rating);

  for (const x of [-width * 0.45, width * 0.45]) {
    for (const y of [-height * 0.36, height * 0.36]) {
      const fastener = new THREE.Mesh(
        new THREE.CylinderGeometry(height * 0.035, height * 0.035, 0.0012, 14),
        chassis_material('#232930', { metalness: 0.7, roughness: 0.38 })
      );
      fastener.rotation.x = Math.PI / 2;
      fastener.position.set(x, y, depth / 2 + 0.004);
      fastener.name = 'psu_fastener';
      group.add(fastener);
    }
  }
  const handle = new THREE.Mesh(
    new THREE.TorusGeometry(height * 0.28, height * 0.05, 8, 20, Math.PI),
    chassis_material(COLOR.chassis_dark)
  );
  handle.rotation.y = Math.PI / 2;
  handle.position.set(width / 2 + 0.004, 0, 0);
  group.add(handle);
  const vents = new THREE.Mesh(
    vent_grille(width * 0.6, height * 0.5, 4, 0.002),
    plastic_material(COLOR.plastic_dark, 0.9)
  );
  vents.position.set(0, 0, -depth / 2 - 0.001);
  group.add(vents);
  const fan = fan_module(height * 0.7);
  fan.position.set(0, 0, -depth / 2 + height * 0.6);
  group.add(fan);
  group.userData.port_slots = [
    {
      short_name: label,
      name: label,
      connector: 'power_iec_c14',
      speed_bps: 0,
      position: [width * 0.16, -height * 0.03, depth / 2 + 0.009],
      direction: [0, 0, 1],
      label: label,
      group_id: 'power'
    }
  ];

  return group;
}

/**
 * 桌面电源适配器（小方块 + 线缆出口 + DC 插头）。
 *
 * 参数：`width`、`height`、`depth`。
 *
 * @param {object} context 构建上下文。
 * @returns {THREE.Group} 适配器组（`userData.port_slots` 含 DC 输出锚点）。
 */
function build_power_adapter(context: { spec: { params: Record<string, unknown> } }): THREE.Group {
  const { spec } = context;
  const width = number_param(spec.params, 'width', 0.05);
  const height = number_param(spec.params, 'height', 0.028);
  const depth = number_param(spec.params, 'depth', 0.075);
  const group = new THREE.Group();
  const shell = new THREE.Mesh(
    rounded_box(width, height, depth, 0.004),
    plastic_material('#14171c', 0.7)
  );
  group.add(shell);
  const plug = new THREE.Mesh(
    new THREE.BoxGeometry(width * 0.6, height * 0.3, 0.004),
    plastic_material(COLOR.plastic_gray, 0.6)
  );
  plug.position.set(0, 0, depth / 2 + 0.002);
  group.add(plug);
  group.userData.port_slots = [
    {
      short_name: 'DC',
      name: 'DC 输出',
      connector: 'power_dc_barrel',
      speed_bps: 0,
      position: [0, 0, -depth / 2 - 0.004],
      direction: [0, 0, -1],
      label: 'DC',
      group_id: 'power'
    }
  ];

  return group;
}

/**
 * 冗余电源位（空槽 + 挡板）。
 *
 * 参数：`width`、`height`、`depth`。
 *
 * @param {object} context 构建上下文。
 * @returns {THREE.Group} 挡板组。
 */
function build_psu_bay(context: { spec: { params: Record<string, unknown> } }): THREE.Group {
  const { spec } = context;
  const width = number_param(spec.params, 'width', 0.1);
  const height = number_param(spec.params, 'height', 0.04);
  const depth = number_param(spec.params, 'depth', 0.01);
  const group = new THREE.Group();
  const cover = new THREE.Mesh(
    rounded_box(width, height, depth, 0.001),
    chassis_material(COLOR.chassis_dark)
  );
  group.add(cover);
  const slots = new THREE.Mesh(
    vent_grille(width * 0.7, height * 0.6, 5, 0.002),
    plastic_material('#0b0e12', 0.95)
  );
  slots.position.z = depth / 2 + 0.0008;
  group.add(slots);

  return group;
}


/**
 * 锂聚合物电池包（平放薄板）：电芯本体 + 极耳/排线 + 容量丝印条。
 *
 * 坐标约定：X = 宽，Y = 厚（朝上），Z = 长；与主板/天线一样平铺在机身内部。
 *
 * @param {object} context 构建上下文。
 * @returns {THREE.Group} 电池组。
 */
function build_battery_pack(context: { spec: { params: Record<string, unknown> } }): THREE.Group {
  const { spec } = context;
  const width = number_param(spec.params, 'width', 0.045);
  const depth = number_param(spec.params, 'depth', 0.08);
  const height = number_param(spec.params, 'height', 0.0038);
  const color = color_param(spec.params, 'color', '#1d2733');
  const group = new THREE.Group();

  /* ① 电芯本体（软包，四角略圆）。 */
  const cell = new THREE.Mesh(
    rounded_box(width, height, depth, height * 0.45),
    plastic_material(color, 0.72)
  );
  group.add(cell);

  /* ② 顶面丝印条（容量/型号标签）。 */
  const label = new THREE.Mesh(
    new THREE.PlaneGeometry(width * 0.82, depth * 0.16),
    new THREE.MeshBasicMaterial({
      map: label_texture('Li-Po 4500mAh 3.87V', '#c9d4e0', 128),
      transparent: true,
      depthWrite: false
    })
  );
  label.rotation.x = -Math.PI / 2;
  label.position.set(0, height * 0.52, -depth * 0.18);
  group.add(label);

  /* ③ 极耳/排线（上沿一条黑色软排线）。 */
  const ribbon = new THREE.Mesh(
    rounded_box(width * 0.34, height * 0.4, depth * 0.08, height * 0.15),
    plastic_material('#0b0e12', 0.85)
  );
  ribbon.position.set(0, height * 0.1, depth * 0.5);
  group.add(ribbon);

  /* ④ 电芯分隔线（两段电芯的压痕）。 */
  const divider = new THREE.Mesh(
    new THREE.BoxGeometry(width * 0.96, height * 0.06, height * 0.3),
    plastic_material('#10161f', 0.9)
  );
  divider.position.set(0, height * 0.5, 0);
  group.add(divider);

  group.userData.chassis_size = { width: width, height: height, depth: depth };

  return group;
}

/** 电源相关部件注册表。 */
export const POWER_PARTS: PartDefinition[] = [
  {
    kind: 'battery_pack',
    category: 'power',
    label: '电池包（平放）',
    defaults: { width: 0.045, depth: 0.08, height: 0.0038, color: '#1d2733' },
    schema: {
      width: { label: '宽（米）', min: 0.01, max: 0.12, step: 0.0005 },
      depth: { label: '长（米）', min: 0.02, max: 0.16, step: 0.0005 },
      height: { label: '厚（米）', min: 0.001, max: 0.02, step: 0.0002 },
      color: { label: '颜色', kind: 'color' }
    },
    build: build_battery_pack
  },
  {
    kind: 'psu_module',
    category: 'power',
    label: '机架电源模块',
    defaults: { width: 0.1, height: 0.04, depth: 0.2, label: 'PWR' },
    schema: {
      width: { label: '宽（米）', min: 0.04, max: 0.2, step: 0.001 },
      height: { label: '高（米）', min: 0.02, max: 0.08, step: 0.001 },
      depth: { label: '深（米）', min: 0.05, max: 0.4, step: 0.005 },
      label: { label: '端口名', kind: 'text' }
    },
    build: build_psu_module
  },
  {
    kind: 'power_adapter',
    category: 'power',
    label: '桌面电源适配器',
    defaults: { width: 0.05, height: 0.028, depth: 0.075 },
    schema: {
      width: { label: '宽（米）', min: 0.02, max: 0.15, step: 0.001 },
      height: { label: '高（米）', min: 0.01, max: 0.08, step: 0.001 },
      depth: { label: '深（米）', min: 0.03, max: 0.2, step: 0.001 }
    },
    build: build_power_adapter
  },
  {
    kind: 'psu_bay',
    category: 'power',
    label: '冗余电源位（挡板）',
    defaults: { width: 0.1, height: 0.04, depth: 0.01 },
    schema: {
      width: { label: '宽（米）', min: 0.04, max: 0.2, step: 0.001 },
      height: { label: '高（米）', min: 0.02, max: 0.08, step: 0.001 }
    },
    build: build_psu_bay
  }
];
