/**
 * @File : web/src/devices/parts/wireless.ts
 * @Time : 2026-10-06 11:40
 * @Author : Cetrp
 * @Description : 参数化无线部件：外置天线阵列、内置天线阵子与射频前端（供无线图层以波束形式呈现）。
 */

import * as THREE from 'three';

import { COLOR, antenna_rod, chassis_material, plastic_material, rounded_box } from '../part_kit';
import type { PartDefinition } from '../template_types';

/** 读取数值参数。 */
function number_param(params: Record<string, unknown>, key: string, fallback: number): number {
  const value = params[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** 读取布尔参数。 */
function boolean_param(params: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = params[key];
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * 外置天线阵列：可配置数量、长度、倾斜角与排布（两侧 / 后侧 / 顶部）。
 *
 * 参数：`count`、`length`、`radius`、`tilt_deg`、`spread`、`side`（left/right/rear/top）、`position`。
 *
 * @param {object} context 构建上下文。
 * @returns {THREE.Group} 天线阵列组（`userData.rf_anchors` 供射频图层画波束）。
 */
function build_antenna_array(context: { spec: { params: Record<string, unknown> } }): THREE.Group {
  const { spec } = context;
  const count = Math.max(1, Math.round(number_param(spec.params, 'count', 2)));
  const length = number_param(spec.params, 'length', 0.12);
  const radius = number_param(spec.params, 'radius', 0.0055);
  const tilt = (number_param(spec.params, 'tilt_deg', 18) * Math.PI) / 180;
  const spread = number_param(spec.params, 'spread', 0.028);
  const side = typeof spec.params.side === 'string' ? spec.params.side : 'rear';
  const position = (spec.params.position as number[]) || [0, 0, 0];
  const group = new THREE.Group();
  group.position.set(Number(position[0]) || 0, Number(position[1]) || 0, Number(position[2]) || 0);
  const anchors: { position: [number, number, number]; direction: [number, number, number] }[] = [];
  for (let index = 0; index < count; index += 1) {
    const offset = (index - (count - 1) / 2) * spread;
    const antenna = antenna_rod(length, radius);
    if (side === 'left' || side === 'right') {
      const sign = side === 'left' ? -1 : 1;
      antenna.position.set(offset, 0, 0);
      antenna.rotation.z = sign * -tilt;
      antenna.rotation.x = -0.25;
      anchors.push({
        position: [offset, length * 0.55, 0],
        direction: [sign * Math.sin(tilt), Math.cos(tilt), 0.2]
      });
    } else if (side === 'top') {
      antenna.position.set(offset, 0, 0);
      antenna.rotation.x = tilt;
      anchors.push({ position: [offset, length * 0.55, 0], direction: [0, 1, Math.sin(tilt)] });
    } else {
      antenna.position.set(offset, 0, 0);
      antenna.rotation.x = Math.PI - tilt;
      anchors.push({ position: [offset, length * 0.4, -length * 0.3], direction: [0, 0.35, -1] });
    }
    group.add(antenna);
  }
  if (boolean_param(spec.params, 'base_plate', true)) {
    const plate = new THREE.Mesh(
      rounded_box(spread * count + 0.012, 0.004, 0.016, 0.0015),
      plastic_material(COLOR.plastic_dark, 0.6)
    );
    group.add(plate);
  }
  group.userData.rf_anchors = anchors;

  return group;
}

/**
 * 内置天线阵子（贴片天线阵列，仅供透视视图观察，不产生外露结构）。
 *
 * 参数：`columns`、`rows`、`pitch`、`size`。
 *
 * @param {object} context 构建上下文。
 * @returns {THREE.Group} 阵子组。
 */
function build_internal_antenna(context: {
  spec: { params: Record<string, unknown> };
}): THREE.Group {
  const { spec } = context;
  const columns = Math.max(1, Math.round(number_param(spec.params, 'columns', 2)));
  const rows = Math.max(1, Math.round(number_param(spec.params, 'rows', 2)));
  const pitch = number_param(spec.params, 'pitch', 0.014);
  const size = number_param(spec.params, 'size', 0.01);
  const group = new THREE.Group();
  const items: THREE.Mesh[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const patch = new THREE.Mesh(
        new THREE.BoxGeometry(size, 0.0012, size * 0.7),
        chassis_material(COLOR.gold, { metalness: 0.8, roughness: 0.35 })
      );
      patch.position.set((column - (columns - 1) / 2) * pitch, 0, (row - (rows - 1) / 2) * pitch);
      items.push(patch);
      group.add(patch);
    }
  }
  group.userData.rf_anchors = [
    { position: [0, size * 0.6, 0], direction: [0, 1, 0] },
    { position: [0, 0, size * 0.6], direction: [0, 0, 1] }
  ];

  return group;
}

/** 无线相关部件注册表。 */
export const WIRELESS_PARTS: PartDefinition[] = [
  {
    kind: 'antenna_array',
    category: 'wireless',
    label: '外置天线阵列',
    defaults: {
      count: 2,
      length: 0.12,
      radius: 0.0055,
      tilt_deg: 18,
      spread: 0.028,
      side: 'rear',
      position: [0, 0.014, -0.04],
      base_plate: true
    },
    schema: {
      count: { label: '天线数量', min: 1, max: 8, step: 1 },
      length: { label: '天线长度（米）', min: 0.03, max: 0.3, step: 0.005 },
      tilt_deg: { label: '倾角（度）', min: 0, max: 90, step: 1 },
      spread: { label: '间距（米）', min: 0.008, max: 0.06, step: 0.002 },
      side: { label: '安装位置', kind: 'select', min: 0, max: 0 }
    },
    build: build_antenna_array
  },
  {
    kind: 'internal_antenna',
    category: 'wireless',
    label: '内置天线阵子',
    defaults: { columns: 2, rows: 2, pitch: 0.014, size: 0.01 },
    schema: {
      columns: { label: '列数', min: 1, max: 4, step: 1 },
      rows: { label: '行数', min: 1, max: 4, step: 1 },
      pitch: { label: '间距（米）', min: 0.005, max: 0.03, step: 0.001 }
    },
    build: build_internal_antenna
  }
];
