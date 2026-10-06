/**
 * @File : web/src/cables/cable_layer.ts
 * @Time : 2026-10-04 14:10
 * @Author : Cetrp
 * @Description : 场景线缆图层：按线缆记录增量增删改 CableObject，提供拖拽连线时的半截线缆预览、
 *               走线把手拾取判定与每帧更新；图层分组必须保持单位变换（线缆几何写在世界坐标）。
 */

import * as THREE from 'three';

import {
  CABLE_CATALOG,
  default_cable_id_for,
  get_cable_kind,
  order_kind_for_connector
} from './catalog';
import { CableObject } from './cable_object';
import { set_dust_cap } from './connectors';
import { label_map_for } from './cable_labels';

import type { CableKind } from './catalog';
import type { ConnectorType } from '../devices/template_types';
import type { PortAnchor } from '../devices/assembler';
import type { CableRecord } from '../data/types';

/** 线缆图层记录（上层场景/CableRecord 适配后的最小输入）。 */
export interface CableLayerRecord {
  /** 线缆 ID。 */
  cable_id: string;
  /** 线缆类型 ID（CABLE_CATALOG 的 cable_id，如 cat6/fiber_lc）；缺省按端口自动选型。 */
  cable_id_kind?: string | null;
  /** 起点设备与端口。 */
  from: { device_id: string; port: string };
  /** 终点设备与端口；null 表示只插了一端（由预览负责表现，图层跳过）。 */
  to: { device_id: string; port: string } | null;
  /** 链路状态（UP / DOWN / CONNECTING）。 */
  state: string;
}

/** 走线把手拾取结果。 */
/** 标签避让：分组尺寸（场景单位）。 */
const LABEL_GROUP_SIZE = 0.45;

/** 标签避让：横向错开步长。 */
const LABEL_SPREAD_X = 0.54;

/** 标签避让：沿端口轴向错开步长。 */
const LABEL_SPREAD_AXIS = 0.42;

/** 标签避让：纵向堆叠步长。 */
const LABEL_SPREAD_Y = 0.4;

export interface WaypointPick {
  /** 线缆 ID。 */
  cable_id: string;
  /** 控制点下标。 */
  waypoint_index: number;
  /** 命中的线缆对象。 */
  cable: CableObject;
}

/** 连接器局部插入轴。 */
const INSERT_AXIS = new THREE.Vector3(0, 0, 1);

/** 预览线缆缺省外伸长度（米）。 */
const PREVIEW_LEAD = 0.35;

/**
 * 把后端线缆记录适配成图层记录。
 *
 * @param {CableRecord[]} cables 后端线缆记录。
 * @param {Map<string, string>} [kinds] 可选的 cable_id → 线缆类型 ID 映射。
 * @returns {CableLayerRecord[]} 图层记录。
 */
export function layer_records_from_cables(
  cables: CableRecord[],
  kinds?: Map<string, string>
): CableLayerRecord[] {
  const records: CableLayerRecord[] = [];
  for (const cable of cables || []) {
    if (!cable || !cable.cable_id) {
      continue;
    }
    const declared = (kinds && kinds.get(cable.cable_id)) || cable.cable_type || '';
    records.push({
      cable_id: cable.cable_id,
      cable_id_kind: get_cable_kind(declared) ? declared : null,
      from: { device_id: cable.source.device_id, port: cable.source.port },
      to: cable.target
        ? { device_id: cable.target.device_id, port: cable.target.port }
        : null,
      state: cable.state || 'DOWN'
    });
  }

  return records;
}

/**
 * 拖拽连线预览：用一条"只有起点插在端口上"的线缆表现，终点跟随指针。
 */
class CablePreview {
  /** 预览分组（加入图层）。 */
  readonly group = new THREE.Group();

  /** 预览线缆对象。 */
  private cable: CableObject;

  /** 悬空端虚拟锚点（世界坐标，随指针移动）。 */
  private virtual_anchor: PortAnchor;

  /** 悬空端虚拟设备（单位变换，让虚拟锚点的局部坐标即世界坐标）。 */
  private virtual_object = new THREE.Object3D();

  /**
   * 构造预览。
   *
   * @param {CableKind} kind 线缆类型。
   * @param {PortAnchor} anchor 起点锚点。
   * @param {THREE.Object3D} device_object 起点设备对象。
   * @param {number} scene_scale 场景比例。
   */
  constructor(
    kind: CableKind,
    anchor: PortAnchor,
    device_object: THREE.Object3D,
    scene_scale: number
  ) {
    this.group.name = 'cable_preview';
    this.virtual_object.userData.connector_scene_scale =
      Number(device_object.userData?.connector_scene_scale) || scene_scale;
    const ordered = order_kind_for_connector(kind, anchor.connector);
    this.virtual_anchor = {
      short_name: 'preview',
      name: 'preview',
      connector: ordered.connectors[1],
      position: new THREE.Vector3(),
      direction: new THREE.Vector3(0, 0, 1),
      speed_bps: 0,
      poe: false,
      group_id: 'preview',
      label: 'preview'
    };
    this.cable = new CableObject({
      kind: ordered,
      from: { anchor: anchor, device_object: device_object },
      to: { anchor: this.virtual_anchor, device_object: this.virtual_object },
      scene_scale: scene_scale,
      cable_id: 'preview',
      state: 'CONNECTING'
    });
    /* 悬空端还没插上：露出防尘帽。 */
    set_dust_cap(this.cable.connector_object('to'), true);
    /* 缺省目标：沿出线方向外伸一截，避免零长度曲线。 */
    const from_exit = this.cable.exit_world('from');
    const from_direction = this.cable.exit_direction('from');
    this.update_target(from_exit.clone().addScaledVector(from_direction, PREVIEW_LEAD));
    this.group.add(this.cable.group);
  }

  /**
   * 更新悬空端位置。
   *
   * @param {THREE.Vector3} world_point 指针世界坐标。
   * @returns {void}
   */
  update_target(world_point: THREE.Vector3): void {
    const previous = this.virtual_anchor.position.clone();
    const forward = world_point.clone().sub(previous);
    if (forward.lengthSq() > 1e-10) {
      /* 插头朝向前进方向，线缆从插头后方进入。 */
      this.virtual_anchor.direction.copy(forward.normalize());
    }
    this.virtual_anchor.position.copy(world_point);
    this.cable.refresh_route();
  }

  /**
   * 每帧更新（闪烁）。
   *
   * @param {number} delta_seconds 时间增量。
   * @returns {void}
   */
  update(delta_seconds: number): void {
    this.cable.update(delta_seconds);
  }

  /**
   * 悬空端世界坐标。
   *
   * @returns {THREE.Vector3} 世界坐标。
   */
  target_world(): THREE.Vector3 {
    return this.virtual_anchor.position.clone();
  }

  /**
   * 预览线缆（供场景检查连接器朝向）。
   *
   * @returns {CableObject} 线缆对象。
   */
  cable_object(): CableObject {
    return this.cable;
  }

  /**
   * 释放预览资源。
   *
   * @returns {void}
   */
  dispose(): void {
    this.cable.dispose();
    this.group.clear();
  }
}

/**
 * 场景线缆图层。
 */
export class CableLayer {
  /** 图层分组（保持单位变换）。 */
  readonly group = new THREE.Group();

  /** 线缆对象表（cable_id → 线缆）。 */
  private cables = new Map<string, CableObject>();

  /** 图层记录（cable_id → 记录），用于判定端点设备。 */
  private records = new Map<string, CableLayerRecord>();

  /** 已拔出、正在播放退线动画的线缆（不在 cables 索引里）。 */
  private detached = new Map<string, CableObject>();

  /** 用户自定义标签（cable_id → 两端文本）。 */
  private custom_labels = new Map<string, { from: string; to: string }>();

  /** 走线签名（用于判断是否需要重算曲线）。 */
  private signatures = new Map<string, string>();

  /** 拖拽预览。 */
  private preview: CablePreview | null = null;

  /** 场景比例（场景单位 / 米）。 */
  private scene_scale = 1;

  /** 当前选中的线缆 ID。 */
  private selected_cable_id: string | null = null;

  /**
   * 构造线缆图层。
   */
  constructor() {
    this.group.name = 'cable_layer';
    this.group.userData.is_cable_layer = true;
  }

  /**
   * 按记录增量同步线缆：新增/更新/删除，类型缺省时按端口自动选型。
   *
   * @param {CableLayerRecord[]} records 线缆记录。
   * @param {Map<string, THREE.Object3D>} device_objects 设备对象表（device_id → 设备组）。
   * @param {Map<string, Map<string, PortAnchor>>} anchors 锚点表（device_id → 端口短名 → 锚点）。
   * @param {number} [scene_scale] 场景比例（场景单位 / 米）。
   * @returns {void}
   */
  sync(
    records: CableLayerRecord[],
    device_objects: Map<string, THREE.Object3D>,
    anchors: Map<string, Map<string, PortAnchor>>,
    scene_scale = 1
  ): void {
    this.scene_scale = Math.max(1e-6, scene_scale);
    const seen = new Set<string>();
    for (const record of records || []) {
      if (!record || !record.cable_id || !record.to) {
        continue;
      }
      const from_object = device_objects.get(record.from.device_id);
      const to_object = device_objects.get(record.to.device_id);
      if (!from_object || !to_object) {
        continue;
      }
      const from_anchor = this.find_anchor(anchors, record.from.device_id, record.from.port);
      const to_anchor = this.find_anchor(anchors, record.to.device_id, record.to.port);
      if (!from_anchor || !to_anchor) {
        continue;
      }
      const kind = this.resolve_kind(record, from_anchor, to_anchor);
      if (!kind) {
        continue;
      }
      seen.add(record.cable_id);
      this.records.set(record.cable_id, record);
      let cable = this.cables.get(record.cable_id);
      if (cable && cable.kind.cable_id !== kind.cable_id) {
        this.remove_cable(record.cable_id);
        cable = undefined;
      }
      if (!cable) {
        cable = new CableObject({
          kind: kind,
          from: { anchor: from_anchor, device_object: from_object },
          to: { anchor: to_anchor, device_object: to_object },
          scene_scale: this.scene_scale,
          cable_id: record.cable_id,
          state: record.state || 'DOWN'
        });
        this.group.add(cable.group);
        this.cables.set(record.cable_id, cable);
        if (this.selected_cable_id === record.cable_id) {
          cable.set_selected(true);
        }
        this.signatures.set(record.cable_id, this.route_signature(cable, kind, from_anchor));
        continue;
      }
      const signature = this.route_signature(cable, kind, from_anchor);
      if (signature !== this.signatures.get(record.cable_id)) {
        cable.set_endpoint('from', from_anchor, from_object);
        cable.set_endpoint('to', to_anchor, to_object);
        cable.set_scene_scale(this.scene_scale);
        this.signatures.set(record.cable_id, signature);
      }
      cable.set_state(record.state || 'DOWN');
    }

    /* 线缆标签：默认按顺序 A-01 / B-01 …，用户自定义文本优先。 */
    const label_map = label_map_for(records || []);
    for (const [cable_id, labels] of label_map.entries()) {
      const cable = this.cables.get(cable_id);
      if (!cable) {
        continue;
      }
      const custom = this.custom_labels.get(cable_id);
      cable.set_label_text(
        custom && custom.from ? custom.from : labels.from,
        custom && custom.to ? custom.to : labels.to
      );
    }
    this.layout_labels();

    /* 清理已拔出的线缆。 */
    for (const cable_id of [...this.cables.keys()]) {
      if (!seen.has(cable_id)) {
        this.remove_cable(cable_id);
      }
    }
  }

  /**
   * 创建拖拽连线预览（半截线缆）。
   *
   * @param {CableKind | string} kind 线缆类型或类型 ID。
   * @param {PortAnchor} anchor 起点锚点。
   * @param {THREE.Object3D} device_object 起点设备对象。
   * @returns {CableKind | null} 实际使用的线缆类型；参数非法返回 null。
   */
  create_preview(
    kind: CableKind | string,
    anchor: PortAnchor,
    device_object: THREE.Object3D
  ): CableKind | null {
    const resolved = typeof kind === 'string' ? get_cable_kind(kind) : kind;
    if (!resolved || !anchor || !device_object) {
      return null;
    }
    this.cancel_preview();
    this.preview = new CablePreview(resolved, anchor, device_object, this.scene_scale);
    this.group.add(this.preview.group);

    return resolved;
  }

  /**
   * 更新预览的悬空端位置。
   *
   * @param {THREE.Vector3} world_point 指针世界坐标。
   * @returns {void}
   */
  update_preview(world_point: THREE.Vector3): void {
    if (!this.preview || !world_point) {
      return;
    }
    this.preview.update_target(world_point);
  }

  /**
   * 取消预览并释放资源。
   *
   * @returns {void}
   */
  cancel_preview(): void {
    if (!this.preview) {
      return;
    }
    this.preview.dispose();
    this.group.remove(this.preview.group);
    this.preview = null;
  }

  /**
   * 是否有预览在进行。
   *
   * @returns {boolean} 是否存在预览。
   */
  has_preview(): boolean {
    return this.preview !== null;
  }

  /**
   * 预览线缆对象（无预览时返回 null）。
   *
   * @returns {CableObject | null} 预览线缆。
   */
  preview_cable(): CableObject | null {
    return this.preview ? this.preview.cable_object() : null;
  }

  /**
   * 从拾取结果里判定是否点中走线把手。
   *
   * @param {THREE.Intersection[]} intersects 射线拾取结果（按距离排序）。
   * @returns {WaypointPick | null} 命中结果。
   */
  pick_waypoint(intersects: THREE.Intersection[]): WaypointPick | null {
    for (const hit of intersects || []) {
      const data = hit && hit.object ? hit.object.userData : null;
      if (!data || !data.is_waypoint_handle || !data.cable_id) {
        continue;
      }
      const cable = this.cables.get(data.cable_id);
      if (!cable) {
        continue;
      }

      return {
        cable_id: data.cable_id,
        waypoint_index: data.waypoint_index,
        cable: cable
      };
    }

    return null;
  }

  /**
   * 从拾取结果里判定点中的线缆（沿父级查找 cable_id）。
   *
   * @param {THREE.Intersection[]} intersects 射线拾取结果。
   * @returns {string | null} 线缆 ID。
   */
  pick_cable(intersects: THREE.Intersection[]): string | null {
    for (const hit of intersects || []) {
      let node: THREE.Object3D | null = hit ? hit.object : null;
      while (node) {
        if (node.userData && node.userData.cable_id && this.cables.has(node.userData.cable_id)) {
          return node.userData.cable_id as string;
        }
        node = node.parent;
      }
    }

    return null;
  }

  /**
   * 取线缆对象。
   *
   * @param {string} cable_id 线缆 ID。
   * @returns {CableObject | null} 线缆对象。
   */
  get_cable(cable_id: string): CableObject | null {
    const cable = this.cables.get(cable_id);

    return cable || null;
  }

  /**
   * 供场景射线拾取的线缆网格（递归拾取，命中后可沿父级找到 cable_id）。
   *
   * @returns {THREE.Object3D[]} 线缆分组数组。
   */
  pickable_meshes(): THREE.Object3D[] {
    return [...this.cables.values()].map((cable) => cable.group);
  }

  /**
   * 供场景射线拾取的走线把手网格（不含线缆本体，便于优先命中把手）。
   *
   * @returns {THREE.Object3D[]} 把手网格数组。
   */
  waypoint_meshes(): THREE.Object3D[] {
    const meshes: THREE.Object3D[] = [];
    for (const cable of this.cables.values()) {
      for (const handle of cable.waypoint_handles()) {
        meshes.push(handle);
      }
    }

    return meshes;
  }

  /**
   * 全部线缆 ID。
   *
   * @returns {string[]} 线缆 ID 列表。
   */
  cable_ids(): string[] {
    return [...this.cables.keys()];
  }

  /**
   * 线缆数量。
   *
   * @returns {number} 数量。
   */
  count(): number {
    return this.cables.size;
  }

  /**
   * 选中线缆（其余取消选中）。
   *
   * @param {string | null} cable_id 线缆 ID；null 表示全部取消选中。
   * @returns {void}
   */
  set_selected(cable_id: string | null): void {
    this.selected_cable_id = cable_id || null;
    for (const [id, cable] of this.cables.entries()) {
      cable.set_selected(id === this.selected_cable_id);
    }
  }

  /**
   * 当前选中的线缆 ID。
   *
   * @returns {string | null} 线缆 ID。
   */
  selected_id(): string | null {
    return this.selected_cable_id;
  }

  /**
   * 给某条线缆追加走线控制点。
   *
   * @param {string} cable_id 线缆 ID。
   * @param {THREE.Vector3} point 世界坐标。
   * @returns {number} 新控制点下标；线缆不存在返回 -1。
   */
  add_waypoint(cable_id: string, point: THREE.Vector3): number {
    const cable = this.cables.get(cable_id);
    if (!cable) {
      return -1;
    }

    return cable.add_waypoint(point);
  }

  /**
   * 移动某条线缆的走线控制点。
   *
   * @param {string} cable_id 线缆 ID。
   * @param {number} index 控制点下标。
   * @param {THREE.Vector3} point 世界坐标。
   * @returns {boolean} 是否成功。
   */
  move_waypoint(cable_id: string, index: number, point: THREE.Vector3): boolean {
    const cable = this.cables.get(cable_id);

    return cable ? cable.move_waypoint(index, point) : false;
  }

  /**
   * 删除某条线缆的走线控制点。
   *
   * @param {string} cable_id 线缆 ID。
   * @param {number} index 控制点下标。
   * @returns {boolean} 是否成功。
   */
  /**
   * 正在播放退线动画的线缆数量（测试与验收用）。
   *
   * @returns {number} 数量。
   */
  get detached_count(): number {
    return this.detached.size;
  }

  /**
   * 批量设置自定义标签（来自 store）。
   *
   * @param {Record<string, { from: string; to: string }>} labels cable_id → 两端文本。
   * @returns {void}
   */
  set_custom_labels(labels: Record<string, { from: string; to: string }>): void {
    this.custom_labels.clear();
    for (const [cable_id, value] of Object.entries(labels || {})) {
      this.custom_labels.set(cable_id, { from: value.from || '', to: value.to || '' });
    }
  }

  /**
   * 设置自定义标签文本（空串表示恢复默认 A-nn / B-nn）。
   *
   * @param {string} cable_id 线缆 ID。
   * @param {'from' | 'to'} side 端点。
   * @param {string} text 标签文本。
   * @param {string} fallback 默认文本（清空时使用）。
   * @returns {void}
   */
  set_custom_label(
    cable_id: string,
    side: 'from' | 'to',
    text: string,
    fallback: string
  ): void {
    const current = this.custom_labels.get(cable_id) || { from: '', to: '' };
    const next = { from: current.from, to: current.to };
    next[side] = text.trim();
    this.custom_labels.set(cable_id, next);
    const cable = this.cables.get(cable_id);
    if (cable) {
      const texts = cable.label_text;
      cable.set_label_text(
        side === 'from' ? next.from || fallback : texts.from,
        side === 'to' ? next.to || fallback : texts.to
      );
      this.layout_labels();
    }
  }

  /**
   * 标签避让：把锚点相近的标签错开摆放（横向交替 + 纵向堆叠），避免互相遮挡。
   *
   * @returns {void}
   */
  layout_labels(): void {
    const entries: {
      cable: CableObject;
      side: 'from' | 'to';
      anchor: THREE.Vector3;
      axis: THREE.Vector3;
    }[] = [];
    for (const cable of this.cables.values()) {
      for (const side of ['from', 'to'] as ('from' | 'to')[]) {
        entries.push({
          cable: cable,
          side: side,
          anchor: cable.label_anchor(side),
          axis: cable.exit_direction(side)
        });
      }
    }
    const groups = new Map<string, typeof entries>();
    for (const entry of entries) {
      /* 按 0.6 场景单位量化分组：同一端口区的标签会落到同一组。 */
      const key = [
        Math.round(entry.anchor.x / LABEL_GROUP_SIZE),
        Math.round(entry.anchor.y / LABEL_GROUP_SIZE),
        Math.round(entry.anchor.z / LABEL_GROUP_SIZE)
      ].join(':');
      const bucket = groups.get(key) || [];
      bucket.push(entry);
      groups.set(key, bucket);
    }
    for (const bucket of groups.values()) {
      const total = bucket.length;
      bucket.forEach((entry, index) => {
        if (total <= 1) {
          entry.cable.set_label_offset(entry.side, new THREE.Vector3());
          return;
        }
        /* 以端口轴线为参考：沿横向交替 + 纵向分层，形成错落的标签墙。 */
        const lateral = new THREE.Vector3(0, 1, 0).cross(entry.axis).normalize();
        if (lateral.lengthSq() < 1e-6) {
          lateral.set(1, 0, 0);
        }
        const column = index % 2 === 0 ? -1 : 1;
        const row = Math.floor(index / 2);
        const offset = new THREE.Vector3()
          .addScaledVector(lateral, column * LABEL_SPREAD_X * (1 + Math.floor(index / 4) * 0.4))
          .addScaledVector(entry.axis, LABEL_SPREAD_AXIS * (1 + row * 0.35));
        offset.y += LABEL_SPREAD_Y * (row + 1);
        entry.cable.set_label_offset(entry.side, offset);
      });
    }
  }

  /**
   * 射线拾取标签（供"点标签改文字"）。
   *
   * @param {THREE.Raycaster} raycaster 射线。
   * @returns {{ cable_id: string, side: 'from' | 'to' } | null} 命中的标签。
   */
  pick_label(raycaster: THREE.Raycaster): { cable_id: string; side: 'from' | 'to' } | null {
    const targets: THREE.Object3D[] = [];
    for (const cable of this.cables.values()) {
      for (const side of ['from', 'to'] as ('from' | 'to')[]) {
        const sprite = cable.label_object(side);
        if (sprite) {
          targets.push(sprite);
        }
      }
    }
    const hits = raycaster.intersectObjects(targets, false);

    return hits.length > 0
      ? (hits[0].object.userData.label_ref as { cable_id: string; side: 'from' | 'to' })
      : null;
  }

  /**
   * 遍历当前线缆（含正在改插预览的线缆）。
   *
   * @returns {CableObject[]} 线缆数组。
   */
  iterate(): CableObject[] {
    return [...this.cables.values()];
  }

  /**
   * 改插预览：把指定端点临时挪到指针世界坐标（不改变真实接线）。
   *
   * @param {string} cable_id 线缆 ID。
   * @param {'from' | 'to'} side 端点。
   * @param {THREE.Vector3} world_point 指针世界坐标。
   * @returns {void}
   */
  set_endpoint_preview(cable_id: string, side: 'from' | 'to', world_point: THREE.Vector3): void {
    const cable = this.cables.get(cable_id);
    if (!cable) {
      return;
    }
    cable.set_virtual_endpoint(side, world_point);
  }

  /**
   * 结束改插预览：端点回到真实锚点。
   *
   * @param {string} cable_id 线缆 ID。
   * @param {'from' | 'to'} side 端点。
   * @returns {void}
   */
  clear_endpoint_preview(cable_id: string, side: 'from' | 'to'): void {
    const cable = this.cables.get(cable_id);
    if (!cable) {
      return;
    }
    cable.clear_virtual_endpoint(side);
  }

  /**
   * 为每条线缆下发避障包围盒（排除线缆两端所属设备，否则会把自己"抬"起来）。
   *
   * @param {Map<string, { device_id: string; box: THREE.Box3 }[]>} obstacles 各设备的包围盒。
   * @returns {void}
   */
  apply_obstacles(obstacles: { device_id: string; box: THREE.Box3 }[]): void {
    for (const [cable_id, cable] of this.cables.entries()) {
      const record = this.records.get(cable_id);
      const endpoints: string[] = [];
      if (record) {
        endpoints.push(record.from.device_id);
        if (record.to) {
          endpoints.push(record.to.device_id);
        }
      }
      const boxes = obstacles
        .filter((item) => endpoints.indexOf(item.device_id) < 0)
        .map((item) => item.box);
      cable.set_obstacles(boxes);
    }
  }

  /**
   * 确保线缆有可拖拽控制点。
   *
   * @param {string} cable_id 线缆 ID。
   * @param {number} count 控制点数量。
   * @returns {number} 新增数量。
   */
  ensure_pull_waypoints(cable_id: string, count: number): number {
    const cable = this.cables.get(cable_id);

    return cable ? cable.ensure_pull_waypoints(count) : 0;
  }

  /**
   * 导出控制点。
   *
   * @param {string} cable_id 线缆 ID。
   * @returns {[number, number, number][]} 控制点数组。
   */
  export_waypoints(cable_id: string): [number, number, number][] {
    const cable = this.cables.get(cable_id);

    return cable ? cable.export_waypoints() : [];
  }

  /**
   * 导入控制点（场景同步时恢复用户拉动过的走线）。
   *
   * @param {string} cable_id 线缆 ID。
   * @param {[number, number, number][]} points 控制点数组。
   * @returns {void}
   */
  import_waypoints(cable_id: string, points: [number, number, number][]): void {
    const cable = this.cables.get(cable_id);
    if (cable && points.length > 0) {
      cable.import_waypoints(points);
    }
  }

  remove_waypoint(cable_id: string, index: number): boolean {
    const cable = this.cables.get(cable_id);

    return cable ? cable.remove_waypoint(index) : false;
  }

  /**
   * 恢复某条线缆的自然悬垂走线。
   *
   * @param {string} cable_id 线缆 ID。
   * @returns {boolean} 是否成功。
   */
  reset_route(cable_id: string): boolean {
    const cable = this.cables.get(cable_id);
    if (!cable) {
      return false;
    }
    cable.reset_route();

    return true;
  }

  /**
   * 每帧更新全部线缆与预览。
   *
   * @param {number} delta_seconds 时间增量（秒）。
   * @returns {void}
   */
  update(delta_seconds: number): void {
    for (const cable of this.cables.values()) {
      cable.update(delta_seconds);
    }
    if (this.preview) {
      this.preview.update(delta_seconds);
    }
  }

  /**
   * 释放全部线缆与预览。
   *
   * @returns {void}
   */
  dispose(): void {
    this.cancel_preview();
    for (const cable of this.cables.values()) {
      cable.dispose();
    }
    this.cables.clear();
    this.signatures.clear();
    this.selected_cable_id = null;
    this.group.clear();
  }

  /**
   * 删除一条线缆。
   *
   * @param {string} cable_id 线缆 ID。
   * @returns {void}
   * @private
   */
  private remove_cable(cable_id: string): void {
    const cable = this.cables.get(cable_id);
    if (!cable) {
      return;
    }
    /* 真机拔线：插头先退出端口（动画），结束后再销毁对象。
       注意：即使插入动画尚未播完也要走退线流程（play_unplug 会接管当前动画）。 */
    this.detached.set(cable_id, cable);
    this.cables.delete(cable_id);
    this.records.delete(cable_id);
    this.signatures.delete(cable_id);
    cable.play_unplug(() => {
      this._dispose_cable(cable_id);
    });
  }

  /**
   * 真正销毁线缆对象并清理索引。
   *
   * @param {string} cable_id 线缆 ID。
   * @returns {void}
   * @private
   */
  private _dispose_cable(cable_id: string): void {
    const cable = this.cables.get(cable_id) || this.detached.get(cable_id) || null;
    if (!cable) {
      return;
    }
    cable.dispose();
    this.group.remove(cable.group);
    this.cables.delete(cable_id);
    this.records.delete(cable_id);
    this.signatures.delete(cable_id);
    this.detached.delete(cable_id);
  }

  /**
   * 推进已拔出线缆的退线动画，动画结束后自动销毁。
   *
   * @param {number} delta 时间增量（秒）。
   * @returns {void}
   */
  update_detached(delta: number): void {
    for (const [cable_id, cable] of [...this.detached.entries()]) {
      cable.update(delta);
      if (!cable.animating) {
        this._dispose_cable(cable_id);
      }
    }
  }

  /**
   * 取锚点。
   *
   * @param {Map<string, Map<string, PortAnchor>>} anchors 锚点表。
   * @param {string} device_id 设备 ID。
   * @param {string} port 端口短名。
   * @returns {PortAnchor | null} 锚点。
   * @private
   */
  private find_anchor(
    anchors: Map<string, Map<string, PortAnchor>>,
    device_id: string,
    port: string
  ): PortAnchor | null {
    const device_anchors = anchors ? anchors.get(device_id) : null;
    if (!device_anchors) {
      return null;
    }

    return device_anchors.get(port) || null;
  }

  /**
   * 选定线缆类型：记录指定且合法优先，否则按起点端口缺省选型，再退到终点端口/网线。
   *
   * @param {CableLayerRecord} record 线缆记录。
   * @param {PortAnchor} from_anchor 起点锚点。
   * @param {PortAnchor} to_anchor 终点锚点。
   * @returns {CableKind | null} 线缆类型。
   * @private
   */
  private resolve_kind(
    record: CableLayerRecord,
    from_anchor: PortAnchor,
    to_anchor: PortAnchor
  ): CableKind | null {
    const declared = get_cable_kind(record.cable_id_kind || '');
    if (declared) {
      return order_kind_for_connector(declared, from_anchor.connector);
    }
    const by_from = get_cable_kind(default_cable_id_for(from_anchor.connector));
    if (by_from) {
      return order_kind_for_connector(by_from, from_anchor.connector);
    }
    const by_to = get_cable_kind(default_cable_id_for(to_anchor.connector));
    if (by_to) {
      return order_kind_for_connector(by_to, from_anchor.connector);
    }

    return CABLE_CATALOG[0] || null;
  }

  /**
   * 走线签名：端点世界坐标/端口/设备/比例任一变化都要重算曲线。
   *
   * @param {CableObject} cable 线缆对象。
   * @param {CableKind} kind 线缆类型。
   * @param {PortAnchor} from_anchor 起点锚点。
   * @returns {string} 签名。
   * @private
   */
  private route_signature(cable: CableObject, kind: CableKind, from_anchor: PortAnchor): string {
    const from_world = cable.endpoint_world('from');
    const from_direction = cable.endpoint_direction('from');
    const to_world = cable.endpoint_world('to');
    const to_direction = cable.endpoint_direction('to');

    return [
      kind.cable_id,
      kind.connectors.join('>'),
      this.scene_scale,
      from_anchor.short_name,
      this.round_vector(from_world),
      this.round_vector(from_direction),
      this.round_vector(to_world),
      this.round_vector(to_direction)
    ].join('|');
  }

  /**
   * 向量取整（签名用，避免浮点噪声导致反复重建）。
   *
   * @param {THREE.Vector3} point 向量。
   * @returns {string} 文本。
   * @private
   */
  private round_vector(point: THREE.Vector3): string {
    return point.x.toFixed(5) + ',' + point.y.toFixed(5) + ',' + point.z.toFixed(5);
  }
}

/**
 * 连接器类型到线缆类型 ID 的便捷查询（供 UI 直接取缺省线缆）。
 *
 * @param {ConnectorType} connector 端口连接器类型。
 * @returns {CableKind | null} 缺省线缆类型。
 */
export function default_kind_for_connector(connector: ConnectorType): CableKind | null {
  return get_cable_kind(default_cable_id_for(connector));
}
