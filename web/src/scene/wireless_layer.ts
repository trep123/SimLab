/**
 * @File : web/src/scene/wireless_layer.ts
 * @Time : 2026-10-05 07:55
 * @Author : Cetrp
 * @Description : 无线效果图层：AP 覆盖圈、STA↔AP 关联线（按 RSSI 着色）、空中帧粒子与漫游提示。
 *               数据来自无线运行时（后端外部进程或浏览器内模型），前端只负责投影。
 */

import * as THREE from 'three';

import { utils } from '../core/constants';
import { RfLayer } from './rf_layer';

/** 关联线颜色阈值（dBm）。 */
const RSSI_GOOD_DBM = -55;
const RSSI_FAIR_DBM = -70;

/** 空中帧粒子上限。 */
const MAX_FRAMES = 60;

/** 空中帧飞行时长（秒）。 */
const FRAME_DURATION = 0.7;

/** 场景显示比例：1 米 = 2 场景单位（与设备建模的归一化一致）。 */
const DISPLAY_SCALE = 2;

/** 覆盖圈显示半径上限（场景单位），超出时以虚线提示真实覆盖更大。 */
const MAX_COVERAGE_UNITS = 13;

/** 一条关联线的可视对象。 */
interface AssociationVisual {
  key: string;
  line: THREE.Mesh;
  material: THREE.MeshBasicMaterial;
  sta_id: string;
  ap_id: string;
}

/**
 * 按 RSSI 选择颜色。
 *
 * @param {number} rssi_dbm 信号强度。
 * @returns {number} 颜色。
 */
export function rssi_color(rssi_dbm: number): number {
  if (rssi_dbm >= RSSI_GOOD_DBM) {
    return 0x2bff9a;
  }
  if (rssi_dbm >= RSSI_FAIR_DBM) {
    return 0xffb648;
  }
  return 0xff5d6c;
}

/** 信号场渐变贴图缓存（颜色 → 贴图）。 */
const FIELD_TEXTURE_CACHE = new Map<number, THREE.Texture>();

/**
 * 生成"信号场"径向渐变贴图：中心完全透明，边缘约 22% 淡色。
 *
 * @param {number} color 颜色（十六进制）。
 * @returns {THREE.Texture} 贴图。
 */
function radial_field_texture(color: number): THREE.Texture {
  const cached = FIELD_TEXTURE_CACHE.get(color);
  if (cached) {
    return cached;
  }
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const context = canvas.getContext('2d');
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  if (context) {
    const rgb = new THREE.Color(color);
    const red = Math.round(rgb.r * 255);
    const green = Math.round(rgb.g * 255);
    const blue = Math.round(rgb.b * 255);
    const gradient = context.createRadialGradient(128, 128, 8, 128, 128, 126);
    gradient.addColorStop(0, 'rgba(' + red + ',' + green + ',' + blue + ',0)');
    gradient.addColorStop(0.85, 'rgba(' + red + ',' + green + ',' + blue + ',0.02)');
    gradient.addColorStop(0.96, 'rgba(' + red + ',' + green + ',' + blue + ',0.08)');
    gradient.addColorStop(1, 'rgba(' + red + ',' + green + ',' + blue + ',0.15)');
    context.fillStyle = gradient;
    context.fillRect(0, 0, 256, 256);
  }
  FIELD_TEXTURE_CACHE.set(color, texture);

  return texture;
}

/**
 * 无线图层。
 */
export class WirelessLayer {
  /** 图层分组。 */
  group = new THREE.Group();

  /** AP 覆盖圈（device_id → 网格）。 */
  private coverage = new Map<string, THREE.Object3D>();

  /** 关联可视化（保留字段以兼容旧接口；无线波束由射频图层承担）。 */
  private associations = new Map<string, AssociationVisual>();

  /** 无线射频图层（波束 + 波前 + 信号源脉冲，不使用物理线缆）。 */
  private rf_layer: RfLayer = new RfLayer();

  /** 当前关联数量（诊断与测试用）。 */
  private association_count = 0;

  /** 空中帧粒子。 */
  private frames: { sta_id: string; ap_id: string; progress: number; direction: string }[] = [];

  /** 帧粒子网格。 */
  private frame_mesh: THREE.InstancedMesh;

  /** 临时矩阵。 */
  private matrix = new THREE.Matrix4();

  /** 临时四元数。 */
  private quaternion = new THREE.Quaternion();

  /** 临时缩放。 */
  private scale = new THREE.Vector3(1, 1, 1);

  /** 临时颜色。 */
  private color = new THREE.Color();

  /**
   * 构造无线图层。
   */
  constructor() {
    this.frame_mesh = new THREE.InstancedMesh(
      new THREE.SphereGeometry(0.06, 8, 6),
      new THREE.MeshBasicMaterial({
        transparent: true,
        opacity: 0.95,
        blending: THREE.AdditiveBlending,
        depthWrite: false
      }),
      MAX_FRAMES
    );
    this.frame_mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const white = new THREE.Color(0xffffff);
    for (let i = 0; i < MAX_FRAMES; i += 1) {
      this.frame_mesh.setColorAt(i, white);
    }
    this.frame_mesh.count = 0;
    this.group.add(this.frame_mesh);
    /* 射频图层（波束/波前）与覆盖圈同属无线图层。 */
    this.group.add(this.rf_layer.group);
  }

  /**
   * 更新 AP 覆盖圈。
   *
   * @param {string} device_id AP 设备 ID。
   * @param {number} radius_m 覆盖半径（米）。
   * @param {number} utilization 信道利用率（0–1）。
   * @param {THREE.Vector3} position 设备位置。
   * @returns {void}
   */
  update_access_point(
    device_id: string,
    radius_m: number,
    utilization: number,
    position: THREE.Vector3
  ): void {
    const existing = this.coverage.get(device_id);
    const color = utilization > 0.7 ? 0xffb648 : 0x37e0c9;
    /* 覆盖圈按显示比例绘制并限制最大半径，避免几十米的覆盖把场景撑爆。 */
    const radius_units = Math.max(2.5, Math.min(radius_m * DISPLAY_SCALE, MAX_COVERAGE_UNITS));
    const geometry = new THREE.RingGeometry(radius_units - 0.16, radius_units, 72);
    if (existing && (existing as THREE.Mesh).isMesh) {
      const mesh = existing as THREE.Mesh;
      mesh.geometry.dispose();
      mesh.geometry = geometry;
      (mesh.material as THREE.MeshBasicMaterial).color.setHex(color);
      this.move_access_point(device_id, position);
      return;
    }
    const mesh = new THREE.Mesh(
      geometry,
      new THREE.MeshBasicMaterial({
        color: color,
        transparent: true,
        opacity: 0.2,
        side: THREE.DoubleSide,
        depthWrite: false
      })
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(position.x, 0.05, position.z);
    this.group.add(mesh);
    this.coverage.set(device_id, mesh);

    /* 覆盖范围被显示上限裁剪时，用虚线外圈提示真实覆盖更大。 */
    if (radius_m * DISPLAY_SCALE > MAX_COVERAGE_UNITS + 0.5) {
      const points: THREE.Vector3[] = [];
      for (let i = 0; i <= 96; i += 1) {
        const angle = (i / 96) * Math.PI * 2;
        points.push(
          new THREE.Vector3(
            Math.cos(angle) * (radius_units + 0.9),
            0.06,
            Math.sin(angle) * (radius_units + 0.9)
          )
        );
      }
      const outline = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(points),
        new THREE.LineDashedMaterial({
          color: color,
          dashSize: 0.5,
          gapSize: 0.4,
          transparent: true,
          opacity: 0.5
        })
      );
      outline.computeLineDistances();
      outline.position.set(position.x, 0, position.z);
      this.group.add(outline);
      this.coverage.set(device_id + ':outline', outline);
    }

    /* 覆盖范围：用径向渐变绘制"信号场"（中心透明、边缘渐显），
       避免相机进入覆盖圈时出现整屏色块。 */
    const fill = new THREE.Mesh(
      new THREE.CircleGeometry(radius_units - 0.16, 72),
      new THREE.MeshBasicMaterial({
        map: radial_field_texture(color),
        color: 0xffffff,
        transparent: true,
        opacity: 0.9,
        side: THREE.DoubleSide,
        depthWrite: false
      })
    );
    fill.rotation.x = -Math.PI / 2;
    fill.position.set(position.x, 0.04, position.z);
    this.group.add(fill);
    this.coverage.set(device_id + ':fill', fill);
  }

  /** 拖动 AP 时同步移动圆环、渐变填充和裁剪范围虚线。 */
  move_access_point(device_id: string, position: THREE.Vector3): void {
    this.coverage.get(device_id)?.position.set(position.x, 0.05, position.z);
    this.coverage.get(device_id + ':fill')?.position.set(position.x, 0.04, position.z);
    this.coverage.get(device_id + ':outline')?.position.set(position.x, 0, position.z);
  }

  /**
   * 更新关联线。
   *
   * @param {string} sta_id STA 设备。
   * @param {string} ap_id AP 设备。
   * @param {number} rssi_dbm 信号强度。
   * @param {THREE.Vector3} sta_position STA 位置。
   * @param {THREE.Vector3} ap_position AP 位置。
   * @returns {void}
   */
  update_association(
    sta_id: string,
    ap_id: string,
    rssi_dbm: number,
    sta_position: THREE.Vector3,
    ap_position: THREE.Vector3
  ): void {
    /* 无线连接不使用任何物理线缆：交由射频图层以波束 + 扩散波前表达。 */
    this.rf_layer.set_visible(true);
    this.rf_layer.sync(
      [{ sta_device_id: sta_id, ap_device_id: ap_id, rssi_dbm: rssi_dbm }],
      new Map([
        [sta_id, sta_position],
        [ap_id, ap_position]
      ]),
      new Set<string>()
    );
    this.association_count += 1;
  }

  /**
   * 同步全部无线关联（一次性传入，避免逐条重复计算位置表）。
   *
   * @param {{sta_device_id: string; ap_device_id: string; rssi_dbm: number}[]} associations 关联列表。
   * @param {Map<string, THREE.Vector3>} positions 设备位置表。
   * @param {Set<string>} waiting_sta 已上电但未关联的 STA。
   * @returns {void}
   */
  sync_associations(
    associations: { sta_device_id: string; ap_device_id: string; rssi_dbm: number }[],
    positions: Map<string, THREE.Vector3>,
    waiting_sta: Set<string>
  ): void {
    this.rf_layer.set_visible(true);
    this.rf_layer.sync(associations, positions, waiting_sta);
    this.association_count = associations.length;
  }

  /**
   * 推进射频图层动画（波前扩散、信号源脉冲与空中帧飞行）。
   *
   * @param {number} delta_seconds 时间步长。
   * @returns {void}
   */
  update_rf(delta_seconds: number): void {
    this.rf_layer.update(delta_seconds);
  }

  /**
   * 清理不存在的关联线与覆盖圈。
   *
   * @param {Set<string>} active_ap_ids 存活 AP。
   * @param {Set<string>} active_association_keys 存活关联。
   * @returns {void}
   */
  prune(active_ap_ids: Set<string>, active_association_keys: Set<string>): void {
    for (const [device_id, object] of [...this.coverage.entries()]) {
      const owner_id = device_id.split(':')[0];
      if (active_ap_ids.has(owner_id)) {
        continue;
      }
      this.group.remove(object);
      const renderable = object as THREE.Mesh;
      if (renderable.geometry) {
        renderable.geometry.dispose();
      }
      const material = renderable.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(material)) {
        material.forEach((item) => item.dispose());
      } else if (material) {
        material.dispose();
      }
      this.coverage.delete(device_id);
    }
    for (const [key, visual] of [...this.associations.entries()]) {
      if (active_association_keys.has(key)) {
        continue;
      }
      void visual;
      this.group.remove(visual.line);
      visual.line.geometry.dispose();
      visual.material.dispose();
      this.associations.delete(key);
    }
  }

  /**
   * 播放空中帧。
   *
   * @param {string} sta_id STA。
   * @param {string} ap_id AP。
   * @param {string} direction 方向（uplink/downlink）。
   * @returns {void}
   */
  play_frame(sta_id: string, ap_id: string, direction: string): void {
    if (this.frames.length >= MAX_FRAMES) {
      this.frames.shift();
    }
    this.frames.push({ sta_id: sta_id, ap_id: ap_id, progress: 0, direction: direction });
  }

  /**
   * 每帧更新。
   *
   * @param {number} delta_seconds 时间增量。
   * @param {(device_id: string) => THREE.Vector3 | null} position_of 设备位置查询。
   * @returns {void}
   */
  update(delta_seconds: number, position_of: (device_id: string) => THREE.Vector3 | null): void {
    for (const frame of this.frames) {
      frame.progress += delta_seconds / FRAME_DURATION;
    }
    this.frames = this.frames.filter((frame) => frame.progress <= 1);

    let count = 0;
    for (const frame of this.frames) {
      const sta = position_of(frame.sta_id);
      const ap = position_of(frame.ap_id);
      if (!sta || !ap) {
        continue;
      }
      const from = frame.direction === 'uplink' ? sta : ap;
      const to = frame.direction === 'uplink' ? ap : sta;
      const point = from
        .clone()
        .lerp(to, frame.progress)
        .add(new THREE.Vector3(0, 0.3 + Math.sin(frame.progress * Math.PI) * 0.25, 0));
      this.matrix.compose(point, this.quaternion, this.scale);
      this.frame_mesh.setMatrixAt(count, this.matrix);
      this.color.setHex(frame.direction === 'uplink' ? 0x37e0c9 : 0x8ab6ff);
      this.frame_mesh.setColorAt(count, this.color);
      count += 1;
    }
    this.frame_mesh.count = count;
    this.frame_mesh.instanceMatrix.needsUpdate = true;
    if (this.frame_mesh.instanceColor) {
      this.frame_mesh.instanceColor.needsUpdate = true;
    }
  }

  /**
   * 显示 / 隐藏。
   *
   * @param {boolean} visible 是否可见。
   * @returns {void}
   */
  set_visible(visible: boolean): void {
    this.group.visible = visible;
  }

  /**
   * 释放资源。
   *
   * @returns {void}
   */
  dispose(): void {
    for (const object of this.coverage.values()) {
      const renderable = object as THREE.Mesh;
      if (renderable.geometry) {
        renderable.geometry.dispose();
      }
      const material = renderable.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(material)) {
        material.forEach((item) => item.dispose());
      } else if (material) {
        material.dispose();
      }
    }
    for (const visual of this.associations.values()) {
      visual.line.geometry.dispose();
      visual.material.dispose();
    }
    this.rf_layer.dispose();
    this.coverage.clear();
    this.associations.clear();
    this.frame_mesh.geometry.dispose();
    (this.frame_mesh.material as THREE.Material).dispose();
  }
}

/**
 * 关联质量文本。
 *
 * @param {number} rssi_dbm 信号强度。
 * @returns {string} 中文描述。
 */
export function rssi_text(rssi_dbm: number): string {
  if (rssi_dbm >= RSSI_GOOD_DBM) {
    return '优';
  }
  if (rssi_dbm >= RSSI_FAIR_DBM) {
    return '良';
  }
  return '弱';
}

/**
 * 数值裁剪工具（供外部复用）。
 *
 * @param {number} value 值。
 * @param {number} min 下界。
 * @param {number} max 上界。
 * @returns {number} 结果。
 */
export function clamp_value(value: number, min: number, max: number): number {
  return utils.clamp(value, min, max);
}
