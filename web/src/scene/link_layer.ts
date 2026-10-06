/**
 * @File : web/src/scene/link_layer.ts
 * @Time : 2026-10-05 07:20
 * @Author : Cetrp
 * @Description : 设备间链路图层：端口到端口的线缆（含垂度与插头跟随）、连线预览橡皮筋与数据包流动画
 * 。
 */

import * as THREE from 'three';

import { utils, SPEED_TEXT } from '../core/constants';

import type { DeviceObject } from './device_builder';
import type { CableRecord } from '../data/types';
import type { OpticalLink } from '../core/optical_model';

/** 线缆垂度系数（每米下垂量）。 */
const SAG_PER_METER = 0.12;

/** 最大同时存在的流动画数量。 */
const MAX_TRACES = 48;

/** 流动画时长（秒）。 */
const TRACE_DURATION = 0.9;

/** 光链路状态到线缆颜色（契约 §7：绿→黄→红）。 */
const OPTICAL_STATE_COLOR: Record<string, number> = {
  WORKING: 0x2bff9a,
  MARGINAL: 0xffb648,
  LOF: 0xff5d6c,
  LOS: 0xff5d6c,
  DYING_GASP: 0xff5d6c,
  OVERLOAD: 0xff8c42
};

/** 一条链路的可视对象。 */
interface LinkVisual {
  cable_id: string;
  curve: THREE.CatmullRomCurve3;
  mesh: THREE.Mesh;
  material: THREE.MeshStandardMaterial;
  from: { device_id: string; port: string };
  to: { device_id: string; port: string };
}

/** 一个数据包流动画。 */
interface TraceVisual {
  points: THREE.Vector3[];
  progress: number;
  color: number;
  speed: number;
}

/**
 * 端口世界坐标（设备对象 + 端口可视分组）。
 *
 * @param {DeviceObject} device_object 设备对象。
 * @param {string} port_name 端口短名。
 * @returns {THREE.Vector3 | null} 世界坐标。
 */
export function port_world_position(
  device_object: DeviceObject,
  port_name: string
): THREE.Vector3 | null {
  const anchor = device_object.anchor_for(port_name);
  if (anchor) {
    device_object.group.updateMatrixWorld(true);
    return anchor.position.clone().applyMatrix4(device_object.group.matrixWorld);
  }
  const visual = device_object.port_visuals.find(
    (item: { definition: { short_name: string } }) => item.definition.short_name === port_name
  );
  if (!visual) {
    return null;
  }
  const position = new THREE.Vector3();
  visual.group.getWorldPosition(position);
  return position;
}

/**
 * 设备间链路图层。
 */
export class LinkLayer {
  /** 图层分组。 */
  group = new THREE.Group();

  /** 链路可视对象（cable_id → 可视）。 */
  private links = new Map<string, LinkVisual>();

  /** 动态动画。 */
  private traces: TraceVisual[] = [];

  /** 动画粒子网格。 */
  private trace_mesh: THREE.InstancedMesh;

  /** 连线预览（橡皮筋）。 */
  private preview: THREE.Line;

  /** 预览端点。 */
  private preview_points: THREE.Vector3[] = [];

  /** ONU → 光链路状态（用于光纤着色）。 */
  private optical_links = new Map<string, OpticalLink>();

  /** 告警光圈（onu_id → 网格）。 */
  private alarm_rings = new Map<string, THREE.Mesh>();

  /** 临时矩阵。 */
  private matrix = new THREE.Matrix4();

  /** 临时四元数。 */
  private quaternion = new THREE.Quaternion();

  /** 临时缩放。 */
  private scale = new THREE.Vector3(1, 1, 1);

  /**
   * 构造链路图层。
   */
  constructor() {
    this.trace_mesh = new THREE.InstancedMesh(
      new THREE.SphereGeometry(0.085, 10, 8),
      new THREE.MeshBasicMaterial({
        transparent: true,
        opacity: 0.95,
        blending: THREE.AdditiveBlending,
        depthWrite: false
      }),
      MAX_TRACES
    );
    this.trace_mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const white = new THREE.Color(0xffffff);
    for (let i = 0; i < MAX_TRACES; i += 1) {
      this.trace_mesh.setColorAt(i, white);
    }
    this.trace_mesh.count = 0;
    this.group.add(this.trace_mesh);

    const preview_geometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(),
      new THREE.Vector3()
    ]);
    this.preview = new THREE.Line(
      preview_geometry,
      new THREE.LineDashedMaterial({
        color: 0x37e0c9,
        dashSize: 0.18,
        gapSize: 0.12,
        transparent: true,
        opacity: 0.9
      })
    );
    this.preview.computeLineDistances();
    this.preview.visible = false;
    this.group.add(this.preview);
  }

  /**
   * 同步链路：按线缆数据重建/更新管道。
   *
   * @param {CableRecord[]} cables 线缆数组。
   * @param {Map<string, DeviceObject>} device_objects 设备对象表。
   * @returns {void}
   */
  sync(
    cables: CableRecord[],
    device_objects: Map<string, DeviceObject>,
    optical_links?: OpticalLink[]
  ): void {
    if (optical_links) {
      this.optical_links.clear();
      for (const link of optical_links) {
        this.optical_links.set(link.onu_id, link);
      }
    }
    const seen = new Set<string>();
    for (const cable of cables) {
      if (!cable.target) {
        continue;
      }
      seen.add(cable.cable_id);
      const from_object = device_objects.get(cable.source.device_id);
      const to_object = device_objects.get(cable.target.device_id);
      if (!from_object || !to_object) {
        continue;
      }
      const from_position = port_world_position(from_object, cable.source.port);
      const to_position = port_world_position(to_object, cable.target.port);
      if (!from_position || !to_position) {
        continue;
      }
      const points = this._cable_points(from_position, to_position);
      const existing = this.links.get(cable.cable_id);
      const is_fiber = cable.cable_type === 'OPTICAL_FIBER';
      /* 光纤线缆按光链路状态着色：WORKING 绿 / MARGINAL 黄 / LOS 等红。 */
      const onu_id = is_onu_device(from_object)
        ? cable.source.device_id
        : is_onu_device(to_object)
          ? cable.target.device_id
          : null;
      const optical = onu_id ? this.optical_links.get(onu_id) : undefined;
      let color = cable.state === 'UP' ? (is_fiber ? 0xf7c73f : 0x3f8ee0) : 0x5a6472;
      let emissive_intensity = cable.state === 'UP' ? 0.25 : 0;
      if (is_fiber && optical) {
        color = OPTICAL_STATE_COLOR[optical.state] || 0xf7c73f;
        emissive_intensity = optical.state === 'WORKING' ? 0.45 : 0.75;
      }
      if (existing) {
        existing.curve = new THREE.CatmullRomCurve3(points);
        existing.mesh.geometry.dispose();
        existing.mesh.geometry = new THREE.TubeGeometry(
          existing.curve,
          32,
          is_fiber ? 0.035 : 0.05,
          7,
          false
        );
        existing.material.color.setHex(color);
        existing.material.emissive.setHex(cable.state === 'UP' ? color : 0x000000);
        existing.material.emissiveIntensity = emissive_intensity;
        existing.from = { device_id: cable.source.device_id, port: cable.source.port };
        existing.to = { device_id: cable.target.device_id, port: cable.target.port };
      } else {
        const curve = new THREE.CatmullRomCurve3(points);
        const material = new THREE.MeshStandardMaterial({
          color: color,
          roughness: 0.45,
          metalness: 0.08,
          emissive: cable.state === 'UP' ? color : 0x000000,
          emissiveIntensity: emissive_intensity
        });
        const mesh = new THREE.Mesh(
          new THREE.TubeGeometry(curve, 32, is_fiber ? 0.035 : 0.05, 7, false),
          material
        );
        mesh.castShadow = true;
        this.group.add(mesh);
        mesh.userData.cable_id = cable.cable_id;
      this.links.set(cable.cable_id, {
          cable_id: cable.cable_id,
          curve: curve,
          mesh: mesh,
          material: material,
          from: { device_id: cable.source.device_id, port: cable.source.port },
          to: { device_id: cable.target.device_id, port: cable.target.port }
        });
      }
    }

    /* 清理已拔出的线缆。 */
    for (const [cable_id, visual] of [...this.links.entries()]) {
      if (seen.has(cable_id)) {
        continue;
      }
      this.group.remove(visual.mesh);
      visual.mesh.geometry.dispose();
      visual.material.dispose();
      this.links.delete(cable_id);
    }

    this._sync_alarm_rings(device_objects);
  }

  /**
   * 可拾取的线缆网格（右键菜单与点击选择用）。
   *
   * @returns {THREE.Object3D[]} 网格列表（userData.cable_id 标识所属线缆）。
   */
  pickable_meshes(): THREE.Object3D[] {
    return [...this.links.values()].map((visual) => visual.mesh);
  }

  /**
   * 告警光圈：ONU 处于 LOS/LOF/OVERLOAD 等状态时在其周围绘制红色脉冲圆环。
   *
   * @param {Map<string, DeviceObject>} device_objects 设备对象表。
   * @returns {void}
   * @private
   */
  private _sync_alarm_rings(device_objects: Map<string, DeviceObject>): void {
    const active = new Set<string>();
    for (const [onu_id, optical] of this.optical_links.entries()) {
      const object = device_objects.get(onu_id);
      if (!object || !optical.alarm) {
        continue;
      }
      active.add(onu_id);
      const color =
        optical.alarm === 'OVERLOAD'
          ? 0xff8c42
          : optical.alarm === 'FIBER_LIMIT'
            ? 0xffb648
            : 0xff5d6c;
      const existing = this.alarm_rings.get(onu_id);
      if (existing) {
        (existing.material as THREE.MeshBasicMaterial).color.setHex(color);
        existing.position.set(object.group.position.x, 0.08, object.group.position.z);
        continue;
      }
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(1.5, 1.8, 48),
        new THREE.MeshBasicMaterial({
          color: color,
          transparent: true,
          opacity: 0.75,
          side: THREE.DoubleSide,
          depthWrite: false
        })
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(object.group.position.x, 0.08, object.group.position.z);
      this.group.add(ring);
      this.alarm_rings.set(onu_id, ring);
    }
    for (const [onu_id, ring] of [...this.alarm_rings.entries()]) {
      if (active.has(onu_id)) {
        continue;
      }
      this.group.remove(ring);
      ring.geometry.dispose();
      (ring.material as THREE.Material).dispose();
      this.alarm_rings.delete(onu_id);
    }
  }

  /**
   * 计算线缆控制点（两端出线方向 + 中间下垂）。
   *
   * @param {THREE.Vector3} from 起点。
   * @param {THREE.Vector3} to 终点。
   * @returns {THREE.Vector3[]} 控制点。
   * @private
   */
  private _cable_points(from: THREE.Vector3, to: THREE.Vector3): THREE.Vector3[] {
    const distance = from.distanceTo(to);
    const sag = distance * SAG_PER_METER;
    const middle = from.clone().add(to).multiplyScalar(0.5);
    const lift = Math.max(0.25, Math.min(0.9, distance * 0.12));
    const control_a = from
      .clone()
      .lerp(to, 0.25)
      .add(new THREE.Vector3(0, lift, 0));
    const control_b = from
      .clone()
      .lerp(to, 0.75)
      .add(new THREE.Vector3(0, lift, 0));
    middle.y -= sag;
    return [from.clone(), control_a, middle, control_b, to.clone()];
  }

  /**
   * 显示连线预览（橡皮筋）。
   *
   * @param {THREE.Vector3 | null} from 起点，null 表示隐藏。
   * @param {THREE.Vector3} [to] 终点。
   * @returns {void}
   */
  set_preview(from: THREE.Vector3 | null, to?: THREE.Vector3): void {
    if (!from || !to) {
      this.preview.visible = false;
      return;
    }
    this.preview_points = [from.clone(), to.clone()];
    this.preview.geometry.dispose();
    this.preview.geometry = new THREE.BufferGeometry().setFromPoints(this.preview_points);
    this.preview.computeLineDistances();
    this.preview.visible = true;
  }

  /**
   * 播放端到端转发动画。
   *
   * @param {string[]} path 设备路径。
   * @param {number} hop_index 当前跳序号。
   * @param {Map<string, DeviceObject>} device_objects 设备对象表。
   * @param {string | null} in_port 入端口。
   * @param {string | null} out_port 出端口。
   * @returns {void}
   */
  play_forward(
    path: string[],
    hop_index: number,
    device_objects: Map<string, DeviceObject>,
    in_port: string | null,
    out_port: string | null
  ): void {
    const current_id = path[hop_index];
    const current = device_objects.get(current_id);
    if (!current) {
      return;
    }
    const points: THREE.Vector3[] = [];
    if (in_port) {
      const position = port_world_position(current, in_port);
      if (position) {
        points.push(position);
      }
    }
    if (out_port) {
      const position = port_world_position(current, out_port);
      if (position) {
        points.push(position);
      }
      const next_id = path[hop_index + 1];
      const next = next_id ? device_objects.get(next_id) : null;
      if (next) {
        const link = [...this.links.values()].find(
          (item) =>
            item.from.device_id === current_id &&
            item.from.port === out_port &&
            item.to.device_id === next_id
        );
        if (link) {
          const link_points = link.curve.getPoints(10);
          points.push(...link_points);
        }
      }
    }
    if (points.length < 2) {
      return;
    }
    if (this.traces.length >= MAX_TRACES) {
      this.traces.shift();
    }
    this.traces.push({ points: points, progress: 0, color: 0x37e0c9, speed: 1 / TRACE_DURATION });
  }

  /**
   * 每帧更新流动画。
   *
   * @param {number} delta_seconds 时间增量。
   * @returns {void}
   */
  update(delta_seconds: number): void {
    /* 告警光圈呼吸效果。 */
    for (const ring of this.alarm_rings.values()) {
      const material = ring.material as THREE.MeshBasicMaterial;
      material.opacity = 0.35 + 0.45 * Math.abs(Math.sin(performance.now() / 420));
      const scale = 1 + 0.06 * Math.sin(performance.now() / 300);
      ring.scale.set(scale, scale, 1);
    }
    for (const trace of this.traces) {
      trace.progress += delta_seconds * trace.speed;
    }
    this.traces = this.traces.filter((trace) => trace.progress <= 1);
    const color = new THREE.Color();
    let count = 0;
    for (const trace of this.traces) {
      const segments = trace.points.length - 1;
      const scaled = utils.clamp(trace.progress, 0, 0.999) * segments;
      const index = Math.floor(scaled);
      const local = scaled - index;
      const point = trace.points[index].clone().lerp(trace.points[index + 1], local);
      color.setHex(trace.color);
      this.matrix.compose(point, this.quaternion, this.scale);
      this.trace_mesh.setMatrixAt(count, this.matrix);
      this.trace_mesh.setColorAt(count, color);
      count += 1;
    }
    this.trace_mesh.count = count;
    this.trace_mesh.instanceMatrix.needsUpdate = true;
    if (this.trace_mesh.instanceColor) {
      this.trace_mesh.instanceColor.needsUpdate = true;
    }
  }

  /**
   * 链路数量。
   *
   * @returns {number} 数量。
   */
  count(): number {
    return this.links.size;
  }

  /**
   * 释放资源。
   *
   * @returns {void}
   */
  dispose(): void {
    for (const visual of this.links.values()) {
      visual.mesh.geometry.dispose();
      visual.material.dispose();
    }
    this.links.clear();
    this.trace_mesh.geometry.dispose();
    (this.trace_mesh.material as THREE.Material).dispose();
  }
}

/**
 * 判断设备对象是否为 ONU（依据 Manifest 光能力）。
 *
 * @param {DeviceObject} object 设备对象。
 * @returns {boolean} 是否为 ONU。
 */
function is_onu_device(object: DeviceObject): boolean {
  const manifest = object.runtime_device ? object.runtime_device.manifest : null;
  if (!manifest) {
    return false;
  }
  return (
    manifest.device_type === 'onu' || Boolean(manifest.optical && manifest.optical.role === 'onu')
  );
}

/**
 * 端口速率到颜色。
 *
 * @param {number} speed_bps 速率（bps）。
 * @returns {number} 颜色。
 */
export function speed_color(speed_bps: number): number {
  const text = SPEED_TEXT[speed_bps] || '1000M';
  if (text === '10G') {
    return 0x37e0c9;
  }
  if (text === '100M') {
    return 0xffb648;
  }
  return 0x2bff9a;
}
