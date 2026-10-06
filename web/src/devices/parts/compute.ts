/**
 * @File : web/src/devices/parts/compute.ts
 * @Time : 2026-10-06 12:20
 * @Author : Cetrp
 * @Description : 参数化计算/操作部件：笔记本屏幕与转轴、手机屏幕、键盘区与触控板。
 */

import * as THREE from 'three';

import {
  COLOR,
  keyboard_deck,
  plastic_material,
  rounded_box,
  screen_panel,
  trs
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
 * 笔记本屏幕总成：屏幕 + 边框 + 转轴。
 *
 * 参数：`width`、`height`、`angle_deg`、`glow`。
 *
 * @param {object} context 构建上下文。
 * @returns {THREE.Group} 屏幕组。
 */
function build_laptop_lid(context: { spec: { params: Record<string, unknown> } }): THREE.Group {
  const { spec } = context;
  const width = number_param(spec.params, 'width', 0.34);
  const height = number_param(spec.params, 'height', 0.215);
  const angle = (number_param(spec.params, 'angle_deg', 104) * Math.PI) / 180;
  const glow = text_param(spec.params, 'glow', '#16233a');
  const group = new THREE.Group();
  const lid_pivot = new THREE.Group();
  const lid = new THREE.Group();
  const shell = new THREE.Mesh(
    rounded_box(width, height, 0.008, 0.004),
    plastic_material(COLOR.chassis_mid, 0.4)
  );
  shell.position.y = height / 2;
  lid.add(shell);
  const screen = screen_panel(width * 0.94, height * 0.9, glow);
  screen.position.set(0, height / 2, 0.005);
  screen.name = 'vnc_screen';
  const screen_surface = screen.getObjectByName('screen_surface');
  if (screen_surface) {
    screen_surface.name = 'vnc_screen_surface';
  }
  screen.userData.vnc_screen_size = { width: width * 0.94, height: height * 0.9 };
  lid.add(screen);
  /* 转轴与开合角。 */
  const hinge = new THREE.Mesh(
    new THREE.CylinderGeometry(0.006, 0.006, width * 0.92, 16),
    plastic_material(COLOR.plastic_dark, 0.5)
  );
  hinge.rotation.z = Math.PI / 2;
  group.add(hinge);
  /* 以铰链为轴旋转：90° 为竖直，104° 表示向后打开 14°，底边始终贴住转轴。 */
  lid_pivot.rotation.x = -(angle - Math.PI / 2);
  lid_pivot.add(lid);
  group.add(lid_pivot);
  group.userData.lid = lid;

  return group;
}

/**
 * 键盘与触控板区。
 *
 * 参数：`width`、`depth`、`rows`、`columns`、`touchpad`。
 *
 * @param {object} context 构建上下文。
 * @returns {THREE.Group} 键盘组。
 */
function build_keyboard(context: { spec: { params: Record<string, unknown> } }): THREE.Group {
  const { spec } = context;
  const width = number_param(spec.params, 'width', 0.3);
  const depth = number_param(spec.params, 'depth', 0.11);
  const rows = Math.max(1, Math.round(number_param(spec.params, 'rows', 5)));
  const columns = Math.max(4, Math.round(number_param(spec.params, 'columns', 14)));
  const group = new THREE.Group();
  const deck = keyboard_deck(width, depth, rows, columns);
  group.add(deck);
  if (spec.params.touchpad !== false) {
    const pad = new THREE.Mesh(
      rounded_box(width * 0.28, 0.0012, depth * 0.42, 0.001),
      plastic_material('#2f353d', 0.35)
    );
    pad.position.set(0, 0.0018, depth * 0.72);
    group.add(pad);
  }
  group.userData.keyboard_matrix = trs(0, 0, 0);

  return group;
}

/**
 * 手机屏幕与机身前面板。
 *
 * 参数：`width`、`height`、`glow`。
 *
 * @param {object} context 构建上下文。
 * @returns {THREE.Group} 屏幕组。
 */
function build_phone_screen(context: { spec: { params: Record<string, unknown> } }): THREE.Group {
  const { spec } = context;
  const width = number_param(spec.params, 'width', 0.066);
  const height = number_param(spec.params, 'height', 0.138);
  const glow = text_param(spec.params, 'glow', '#101826');
  const group = new THREE.Group();
  const screen = new THREE.Mesh(
    new THREE.PlaneGeometry(width, height),
    new THREE.MeshStandardMaterial({
      color: new THREE.Color(glow),
      emissive: new THREE.Color('#3f7fd0'),
      emissiveIntensity: 0.55,
      roughness: 0.2,
      metalness: 0.1
    })
  );
  screen.position.z = 0.0046;
  group.add(screen);
  const notch = new THREE.Mesh(
    rounded_box(width * 0.32, height * 0.02, 0.002, 0.002),
    plastic_material('#0b0e12', 0.4)
  );
  notch.position.set(0, height * 0.47, 0.005);
  group.add(notch);

  return group;
}

/** 计算/操作部件注册表。 */
export const COMPUTE_PARTS: PartDefinition[] = [
  {
    kind: 'laptop_lid',
    category: 'compute',
    label: '笔记本屏幕总成',
    defaults: { width: 0.34, height: 0.215, angle_deg: 104, glow: '#16233a' },
    schema: {
      width: { label: '宽（米）', min: 0.15, max: 0.45, step: 0.005 },
      height: { label: '高（米）', min: 0.1, max: 0.3, step: 0.005 },
      angle_deg: { label: '开合角（度）', min: 90, max: 180, step: 1 }
    },
    build: build_laptop_lid
  },
  {
    kind: 'keyboard',
    category: 'compute',
    label: '键盘与触控板',
    defaults: { width: 0.3, depth: 0.11, rows: 5, columns: 14, touchpad: true },
    schema: {
      width: { label: '宽（米）', min: 0.1, max: 0.4, step: 0.005 },
      depth: { label: '深（米）', min: 0.05, max: 0.2, step: 0.005 },
      rows: { label: '键行数', min: 1, max: 8, step: 1 },
      columns: { label: '每行键数', min: 4, max: 20, step: 1 }
    },
    build: build_keyboard
  },
  {
    kind: 'phone_screen',
    category: 'compute',
    label: '手机屏幕',
    defaults: { width: 0.066, height: 0.138, glow: '#101826' },
    schema: {
      width: { label: '宽（米）', min: 0.04, max: 0.15, step: 0.001 },
      height: { label: '高（米）', min: 0.06, max: 0.25, step: 0.001 }
    },
    build: build_phone_screen
  }
];
