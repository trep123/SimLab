/**
 * @File : web/src/devices/parts/cooling.ts
 * @Time : 2026-10-06 12:00
 * @Author : Cetrp
 * @Description : 参数化散热部件：风扇盘（多风扇 + 网罩）与散热鳍片。
 */

import * as THREE from 'three';

import {
  COLOR,
  chassis_material,
  fan_module,
  label_texture,
  plastic_material,
  rounded_box
} from '../part_kit';
import type { PartDefinition } from '../template_types';

/** 读取数值参数。 */
function number_param(params: Record<string, unknown>, key: string, fallback: number): number {
  const value = params[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * 风扇盘：一排风扇 + 金属网罩。
 *
 * 参数：`fan_count`、`fan_size`、`depth`、`grille`。
 *
 * @param {object} context 构建上下文。
 * @returns {THREE.Group} 风扇盘组。
 */
function build_fan_tray(context: { spec: { params: Record<string, unknown> } }): THREE.Group {
  const { spec } = context;
  const fan_count = Math.max(1, Math.round(number_param(spec.params, 'fan_count', 3)));
  const fan_size = number_param(spec.params, 'fan_size', 0.04);
  const depth = number_param(spec.params, 'depth', 0.028);
  const group = new THREE.Group();
  const frame = new THREE.Mesh(
    rounded_box(fan_size * fan_count + 0.006, fan_size + 0.006, depth, 0.0015),
    chassis_material(COLOR.chassis_dark, { metalness: 0.5, roughness: 0.5 })
  );
  group.add(frame);
  for (let index = 0; index < fan_count; index += 1) {
    const fan = fan_module(fan_size);
    /* 把护网与盘体外表面对齐，否则机箱背板会挡住扇叶，只剩一块黑色矩形。 */
    const guard_depth = fan_size * 0.24 * 0.56;
    fan.position.set(
      (index - (fan_count - 1) / 2) * fan_size,
      0,
      depth / 2 - guard_depth + 0.0016
    );
    group.add(fan);
  }
  if (spec.params.grille !== false) {
    /* 每枚风扇自带同心钢丝护网；此处只增加盘体型号铭牌，避免横向实心条遮住扇叶。 */
    const badge = new THREE.Mesh(
      new THREE.PlaneGeometry(Math.min(fan_size * fan_count * 0.4, 0.045), fan_size * 0.1),
      new THREE.MeshBasicMaterial({
        map: label_texture('FAN TRAY', '#aeb8c2', 192),
        transparent: true,
        depthWrite: false
      })
    );
    badge.position.set(0, -fan_size * 0.43, depth / 2 + 0.0012);
    badge.name = 'fan_tray_badge';
    group.add(badge);
  }

  return group;
}

/**
 * 散热鳍片阵列。
 *
 * 参数：`width`、`height`、`count`、`thickness`。
 *
 * @param {object} context 构建上下文。
 * @returns {THREE.Group} 鳍片组。
 */
function build_heatsink(context: { spec: { params: Record<string, unknown> } }): THREE.Group {
  const { spec } = context;
  const width = number_param(spec.params, 'width', 0.05);
  const height = number_param(spec.params, 'height', 0.014);
  const count = Math.max(2, Math.round(number_param(spec.params, 'count', 12)));
  const thickness = number_param(spec.params, 'thickness', 0.0012);
  const group = new THREE.Group();
  const base = new THREE.Mesh(
    new THREE.BoxGeometry(width, 0.002, height * 0.8),
    chassis_material(COLOR.silver, { metalness: 0.75, roughness: 0.35 })
  );
  group.add(base);
  for (let index = 0; index < count; index += 1) {
    const fin = new THREE.Mesh(
      new THREE.BoxGeometry(thickness, height, height * 0.78),
      chassis_material(COLOR.silver, { metalness: 0.75, roughness: 0.32 })
    );
    fin.position.set((index / (count - 1) - 0.5) * width * 0.96, height / 2, 0);
    group.add(fin);
  }

  return group;
}

/** 散热相关部件注册表。 */
export const COOLING_PARTS: PartDefinition[] = [
  {
    kind: 'fan_tray',
    category: 'cooling',
    label: '风扇盘',
    defaults: { fan_count: 3, fan_size: 0.04, depth: 0.028, grille: true },
    schema: {
      fan_count: { label: '风扇数', min: 1, max: 6, step: 1 },
      fan_size: { label: '风扇边长（米）', min: 0.02, max: 0.08, step: 0.002 },
      depth: { label: '厚度（米）', min: 0.01, max: 0.06, step: 0.002 }
    },
    build: build_fan_tray
  },
  {
    kind: 'heatsink',
    category: 'cooling',
    label: '散热鳍片',
    defaults: { width: 0.05, height: 0.014, count: 12, thickness: 0.0012 },
    schema: {
      width: { label: '宽（米）', min: 0.01, max: 0.15, step: 0.002 },
      height: { label: '高（米）', min: 0.004, max: 0.04, step: 0.001 },
      count: { label: '鳍片数', min: 2, max: 40, step: 1 }
    },
    build: build_heatsink
  }
];
