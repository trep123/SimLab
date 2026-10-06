/**
 * @File : web/src/devices/thumbnailer.ts
 * @Time : 2026-10-07 15:10
 * @Author : Cetrp
 * @Description : 设备与线缆的三维缩略图：用共享离屏渲染器把模板/线缆渲染成 dataURL，
 *               供设备栏与线缆栏以 3D 图像展示（文字说明改为悬浮提示）。
 */

import * as THREE from 'three';

import { assemble_device } from './assembler';
import { template_scene_scale } from './template_device';
import { build_cable_connector } from '../cables/connectors';
import { get_cable_kind } from '../cables/catalog';

import type { DeviceTemplate } from './template_types';
import type { CableKind } from '../cables/catalog';

/** 缩略图宽度（像素）。 */
const THUMB_WIDTH = 176;

/** 缩略图高度（像素）。 */
const THUMB_HEIGHT = 120;

/** 缓存：model_id → dataURL。 */
const DEVICE_CACHE = new Map<string, string>();

/** 缓存：cable_id → dataURL。 */
const CABLE_CACHE = new Map<string, string>();

/** 共享渲染器（惰性创建）。 */
let renderer: THREE.WebGLRenderer | null = null;

/** 共享场景。 */
let scene: THREE.Scene | null = null;

/** 共享相机。 */
let camera: THREE.PerspectiveCamera | null = null;

/**
 * 初始化离屏渲染环境。
 *
 * @returns {boolean} 是否可用（无 WebGL 环境时返回 false）。
 */
function ensure_renderer(): boolean {
  if (renderer && scene && camera) {
    return true;
  }
  if (typeof document === 'undefined') {
    return false;
  }
  try {
    renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      preserveDrawingBuffer: true
    });
    renderer.setSize(THUMB_WIDTH, THUMB_HEIGHT, false);
    renderer.setPixelRatio(1.5);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    scene = new THREE.Scene();
    const key_light = new THREE.DirectionalLight(0xffffff, 2.1);
    key_light.position.set(1.4, 2.2, 2.0);
    scene.add(key_light);
    const fill_light = new THREE.DirectionalLight(0x8fc4ff, 0.9);
    fill_light.position.set(-2.0, 1.2, -1.4);
    scene.add(fill_light);
    scene.add(new THREE.HemisphereLight(0x9fd7ff, 0x101820, 0.85));
    camera = new THREE.PerspectiveCamera(38, THUMB_WIDTH / THUMB_HEIGHT, 0.001, 200);

    return true;
  } catch (error) {
    console.warn('缩略图渲染器初始化失败', error);

    return false;
  }
}

/**
 * 释放对象树资源。
 *
 * @param {THREE.Object3D} object 对象。
 * @returns {void}
 */
function dispose_tree(object: THREE.Object3D): void {
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.geometry) {
      mesh.geometry.dispose();
    }
    const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(material)) {
      material.forEach((item) => item.dispose());
    } else if (material) {
      material.dispose();
    }
  });
}

/**
 * 渲染当前场景为 dataURL。
 *
 * @returns {string} PNG dataURL；失败时返回空串。
 */
function render_data_url(): string {
  if (!renderer || !scene || !camera) {
    return '';
  }
  renderer.render(scene, camera);

  return renderer.domElement.toDataURL('image/png');
}

/**
 * 生成设备模板缩略图（右侧 3/4 俯视）。
 *
 * @param {DeviceTemplate} template 设备模板。
 * @returns {string} PNG dataURL；不可用时为空串。
 */
export function device_thumbnail(template: DeviceTemplate): string {
  const cache_key = template.model_id + '@' + (template.version || 1);
  const cached = DEVICE_CACHE.get(cache_key);
  if (cached !== undefined) {
    return cached;
  }
  if (!ensure_renderer() || !scene || !camera) {
    return '';
  }
  const assembled = assemble_device(template, { include_internal: false });
  const scale = template_scene_scale(template);
  const wrapper = new THREE.Group();
  wrapper.add(assembled.group);
  wrapper.scale.setScalar(1 / Math.max(0.001, scale));
  scene.add(wrapper);

  const box = new THREE.Box3().setFromObject(wrapper);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const radius = Math.max(size.x, size.y * 2.1, size.z) * 0.72;
  camera.position.set(center.x + radius * 0.95, center.y + radius * 0.72, center.z + radius * 1.1);
  camera.lookAt(center);
  camera.updateProjectionMatrix();
  const data_url = render_data_url();
  scene.remove(wrapper);
  dispose_tree(wrapper);
  if (data_url) {
    DEVICE_CACHE.set(cache_key, data_url);
  }

  return data_url;
}

/**
 * 生成线缆缩略图（连接器 + 一小段线材）。
 *
 * @param {CableKind} kind 线缆类型。
 * @returns {string} PNG dataURL；不可用时为空串。
 */
export function cable_thumbnail(kind: CableKind): string {
  const cached = CABLE_CACHE.get(kind.cable_id);
  if (cached !== undefined) {
    return cached;
  }
  if (!ensure_renderer() || !scene || !camera) {
    return '';
  }
  const wrapper = new THREE.Group();
  const connector = build_cable_connector(kind.connectors[0], kind);
  connector.rotation.y = -Math.PI * 0.18;
  wrapper.add(connector);
  /* 一小段线缆：用圆柱近似，颜色取自线缆目录。 */
  const sheath = new THREE.Mesh(
    new THREE.CylinderGeometry(0.0035, 0.0035, 0.055, 14),
    new THREE.MeshStandardMaterial({
      color: new THREE.Color(kind.color),
      roughness: 0.5,
      metalness: 0.05
    })
  );
  sheath.rotation.z = Math.PI / 2;
  sheath.rotation.y = Math.PI * 0.35;
  sheath.position.set(0.03, -0.008, -0.02);
  wrapper.add(sheath);
  scene.add(wrapper);
  const box = new THREE.Box3().setFromObject(wrapper);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const radius = Math.max(size.x, size.y, size.z) * 2.1 + 0.01;
  camera.position.set(center.x + radius, center.y + radius * 0.8, center.z + radius);
  camera.lookAt(center);
  camera.updateProjectionMatrix();
  const data_url = render_data_url();
  scene.remove(wrapper);
  dispose_tree(wrapper);
  if (data_url) {
    CABLE_CACHE.set(kind.cable_id, data_url);
  }

  return data_url;
}

/**
 * 按线缆 ID 生成缩略图。
 *
 * @param {string} cable_id 线缆目录 ID。
 * @returns {string} PNG dataURL。
 */
export function cable_thumbnail_by_id(cable_id: string): string {
  const kind = get_cable_kind(cable_id);

  return kind ? cable_thumbnail(kind) : '';
}

/**
 * 清空缩略图缓存（工坊保存后刷新用）。
 *
 * @returns {void}
 */
export function clear_thumbnail_cache(): void {
  DEVICE_CACHE.clear();
  CABLE_CACHE.clear();
}
