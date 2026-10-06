/**
 * @File : web/src/devices/parts/internal.ts
 * @Time : 2026-10-06 12:40
 * @Author : Cetrp
 * @Description : 参数化内部结构部件：主板、转发引擎芯片与内部走线槽（透视/爆炸视图用）。
 */

import * as THREE from 'three';

import { COLOR, main_board, plastic_material, chassis_material } from '../part_kit';
import type { PartDefinition } from '../template_types';

/** 读取数值参数。 */
function number_param(params: Record<string, unknown>, key: string, fallback: number): number {
  const value = params[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * 主板（含芯片阵列）。
 *
 * 参数：`width`、`depth`、`color`。
 *
 * @param {object} context 构建上下文。
 * @returns {THREE.Group} 主板组。
 */
function build_board(context: { spec: { params: Record<string, unknown> } }): THREE.Group {
  const { spec } = context;
  const width = number_param(spec.params, 'width', 0.4);
  const depth = number_param(spec.params, 'depth', 0.2);
  const group = main_board(width, depth);
  if (typeof spec.params.color === 'string') {
    const first = group.children[0] as THREE.Mesh;
    if (first && first.material) {
      (first.material as THREE.MeshStandardMaterial).color = new THREE.Color(spec.params.color);
    }
  }

  return group;
}

/**
 * 转发引擎芯片（带散热片与丝印）。
 *
 * 参数：`width`、`depth`、`height`。
 *
 * @param {object} context 构建上下文。
 * @returns {THREE.Group} 芯片组。
 */
function build_switch_chip(context: { spec: { params: Record<string, unknown> } }): THREE.Group {
  const { spec } = context;
  const width = number_param(spec.params, 'width', 0.032);
  const depth = number_param(spec.params, 'depth', 0.032);
  const height = number_param(spec.params, 'height', 0.0035);
  const group = new THREE.Group();
  const package_body = new THREE.Mesh(
    new THREE.BoxGeometry(width, height, depth),
    plastic_material('#141a20', 0.55)
  );
  group.add(package_body);
  const lid = new THREE.Mesh(
    new THREE.BoxGeometry(width * 0.86, height * 0.5, depth * 0.86),
    chassis_material(COLOR.silver, { metalness: 0.8, roughness: 0.3 })
  );
  lid.position.y = height * 0.7;
  group.add(lid);
  /* 引脚。 */
  const pins: THREE.Mesh[] = [];
  const pin_count = 8;
  for (let index = 0; index < pin_count; index += 1) {
    const pin = new THREE.Mesh(
      new THREE.BoxGeometry(width * 0.04, height * 0.4, depth * 0.04),
      chassis_material(COLOR.gold)
    );
    const offset = (index / (pin_count - 1) - 0.5) * width * 0.9;
    pin.position.set(offset, -height * 0.2, depth * 0.46);
    pins.push(pin);
    group.add(pin);
  }

  return group;
}

/** 内部结构部件注册表。 */
export const INTERNAL_PARTS: PartDefinition[] = [
  {
    kind: 'main_board',
    category: 'internal',
    label: '主板',
    defaults: { width: 0.4, depth: 0.2, color: '#1d3a2a' },
    schema: {
      width: { label: '宽（米）', min: 0.05, max: 0.6, step: 0.005 },
      depth: { label: '深（米）', min: 0.05, max: 0.4, step: 0.005 },
      color: { label: '板色', kind: 'color' }
    },
    build: build_board
  },
  {
    kind: 'switch_chip',
    category: 'internal',
    label: '转发引擎芯片',
    defaults: { width: 0.032, depth: 0.032, height: 0.0035 },
    schema: {
      width: { label: '宽（米）', min: 0.01, max: 0.08, step: 0.001 },
      depth: { label: '深（米）', min: 0.01, max: 0.08, step: 0.001 }
    },
    build: build_switch_chip
  }
];
