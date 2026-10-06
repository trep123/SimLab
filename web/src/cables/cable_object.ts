/**
 * @File : web/src/cables/cable_object.ts
 * @Time : 2026-10-04 13:50
 * @Author : Cetrp
 * @Description : 线缆对象（真高仿走线）：两端连接器吸附到设备端口锚点，线缆本体用样条 + 管道生成，
 *               带自然垂度；支持拖拽整理走线（waypoints）、选中加粗、状态材质、电源发光与流动粒子。
 *
 *               坐标约定：线缆内部所有几何都写在"世界坐标"（与 CableLayer.group 同一坐标系），
 *               因此 CableLayer.group 必须保持单位变换（不要缩放/平移图层本身）。
 */

import * as THREE from 'three';

import { create_end_label } from './cable_labels';

import {
  build_cable_connector,
  connector_exit,
  connector_length,
  set_dust_cap
} from './connectors';

import type { CableKind } from './catalog';
import type { ConnectorType } from '../devices/template_types';
import type { PortAnchor } from '../devices/assembler';

/** 线缆端点：端口锚点 + 所属设备对象。 */
export interface CableEndpoint {
  /** 端口锚点（设备局部坐标）。 */
  anchor: PortAnchor;
  /** 设备对象（DeviceObject.group 或任意承载该锚点的对象）。 */
  device_object: THREE.Object3D;
}

/** 端点标识：起点 / 终点。 */
export type CableEndpointSide = 'from' | 'to';

/** 线缆对象构造参数。 */
export interface CableObjectOptions {
  /** 线缆类型。 */
  kind: CableKind;
  /** 起点端点。 */
  from: CableEndpoint;
  /** 终点端点。 */
  to: CableEndpoint;
  /** 场景比例（场景单位 / 米，缺省 1）。 */
  scene_scale?: number;
  /** 线缆 ID（缺省自动生成）。 */
  cable_id?: string;
  /** 初始状态（UP / DOWN / CONNECTING）。 */
  state?: string;
}

/** 连接器局部插入轴（局部 +Z 指向端口内部）。 */
const INSERT_AXIS = new THREE.Vector3(0, 0, 1);

/** 垂度系数（下垂量 = 水平距离 × 系数）。 */
const SAG_RATIO = 0.12;

/** 最小/最大垂度（米）。 */
/** 插入动画时长（秒）。 */
const INSERT_DURATION = 0.22;

/** 拔出动画总时长（秒）：轴向退出 + 悬垂。 */
const UNPLUG_DURATION = 0.55;

/** 拔出动画中"轴向退出"所占比例（其余时间用于悬垂）。 */
const UNPLUG_SEAT_RATIO = 0.4;

/** 插头悬垂最大下垂量（米，真机约 30 cm）。 */
const HANG_DROP_METERS = 0.3;

/** 场景地面高度（场景单位，用于限制悬垂量）。 */
const FLOOR_LEVEL_Y = -1.62;

/** 标签沿出线方向的偏移（米→场景单位由 scene_scale 换算）。 */
const LABEL_OFFSET = 0.35;

/** 标签抬高量（避免贴着线缆）。 */
const LABEL_LIFT = 0.12;

/** 插头座入深度比例（与 place_connector 保持一致）。 */
const SEAT_RATIO = 0.35;

/** 卡扣到位闪光时长（秒）。 */
const SEAT_FLASH_DURATION = 0.28;

/** 最小弯曲半径平滑迭代次数。 */
const BEND_RELAX_ITERATIONS = 12;

/**
 * 三点外接圆半径（用于最小弯曲半径判定；共线时视为无穷大）。
 *
 * @param {THREE.Vector3} a 点 A。
 * @param {THREE.Vector3} b 点 B。
 * @param {THREE.Vector3} c 点 C。
 * @returns {number} 外接圆半径。
 */
function triangle_circumradius(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3): number {
  const ab = a.distanceTo(b);
  const bc = b.distanceTo(c);
  const ca = c.distanceTo(a);
  const area = new THREE.Vector3()
    .subVectors(b, a)
    .cross(new THREE.Vector3().subVectors(c, a))
    .length();
  if (area < 1e-9) {
    return Number.POSITIVE_INFINITY;
  }

  return (ab * bc * ca) / (2 * area);
}

/** 插头座入深度（占连接器深度比例）。 */
const CONNECTOR_SEAT_RATIO = 0.35;

/** 避障采样数量（越多越贴合设备轮廓）。 */
const OBSTACLE_SAMPLE_COUNT = 48;

/** 落地走线高度（场景单位，略高于地面避免穿模）。 */
const FLOOR_ROUTE_HEIGHT = 0.12;

const MIN_SAG = 0.03;
const MAX_SAG = 0.6;

/** 出线段长度（水平距离 × 系数，再夹到上下限）——让线缆先"离开面板"再下垂。 */
const LEAD_RATIO = 0.12;
const MIN_LEAD = 0.05;
const MAX_LEAD = 0.35;

/** 选中时的线径加粗系数。 */
const SELECTED_RADIUS_FACTOR = 1.6;

/** 流动粒子数量。 */
const FLOW_PARTICLE_COUNT = 6;

/** CONNECTING 状态闪烁频率（Hz）。 */
const CONNECTING_BLINK_HZ = 1.6;

/** CONNECTING 状态闪烁色。 */
const CONNECTING_COLOR = '#ffb648';

/** 选中高亮色。 */
const SELECTED_COLOR = '#37e0c9';

/** 自动编号（未显式给 cable_id 时使用）。 */
let cable_serial = 0;

/**
 * 数值夹取。
 *
 * @param {number} value 输入值。
 * @param {number} min_value 下限。
 * @param {number} max_value 上限。
 * @returns {number} 夹取结果。
 */
function clamp_value(value: number, min_value: number, max_value: number): number {
  return Math.max(min_value, Math.min(max_value, value));
}

/**
 * 按线缆类别生成流动粒子几何（光纤=光脉冲，网线=数据包点，电源=能量点）。
 *
 * @param {CableKind} kind 线缆描述。
 * @param {number} radius 管道半径（世界单位）。
 * @returns {THREE.BufferGeometry} 粒子几何。
 */
function build_flow_geometry(kind: CableKind, radius: number): THREE.BufferGeometry {
  const size = Math.max(0.0015, radius);
  if (kind.category === 'copper') {
    return new THREE.BoxGeometry(size * 2.4, size * 2.4, size * 3.2);
  }
  if (kind.category === 'fiber') {
    return new THREE.SphereGeometry(size * 2.0, 10, 8);
  }
  return new THREE.SphereGeometry(size * 1.6, 10, 8);
}

/**
 * 按线缆类别生成流动粒子颜色。
 *
 * @param {CableKind} kind 线缆描述。
 * @returns {string} 颜色（十六进制）。
 */
function flow_color_of(kind: CableKind): string {
  if (kind.category === 'fiber') {
    return '#fff3b0';
  }
  if (kind.category === 'copper') {
    return '#9fd0ff';
  }
  if (kind.category === 'power') {
    return '#ffd166';
  }
  return '#cfe8ff';
}

/**
 * 按线缆类别生成流动速度（每秒走完整条线缆的比例）。
 *
 * @param {CableKind} kind 线缆描述。
 * @returns {number} 速度。
 */
function flow_speed_of(kind: CableKind): number {
  if (kind.category === 'fiber') {
    return 0.55;
  }
  if (kind.category === 'copper') {
    return 0.35;
  }
  return 0.25;
}

/**
 * 高仿线缆对象：连接器 + 管道本体 + 流动粒子 + 走线把手。
 */
export class CableObject {
  /** 线缆 ID（供场景拾取与记录对应）。 */
  readonly cable_id: string;

  /** 线缆类型（只读）。 */
  readonly kind: CableKind;

  /** 两端连接器类型（只读）。 */
  readonly connector_types: [ConnectorType, ConnectorType];

  /** 根分组（世界坐标，加入 CableLayer.group）。 */
  readonly group = new THREE.Group();

  /** 走线控制点（世界坐标，曲线依次经过全部控制点）。 */
  readonly waypoints: THREE.Vector3[] = [];

  /** 线缆护套材质（供场景做高亮/调试，外部不要直接改）。 */
  readonly sheath_material: THREE.MeshStandardMaterial;

  /** 线缆护套网格（几何体随走线重算）。 */
  readonly sheath_mesh: THREE.Mesh;

  /** 是否已释放。 */
  disposed = false;

  /** 流动相位（0~1，只读展示，供调试与测试）。 */
  flow_phase = 0;

  /** 起点连接器组。 */
  private from_connector: THREE.Group;

  /** 终点连接器组。 */
  private to_connector: THREE.Group;

  /** 起点端点。 */
  private from_endpoint: CableEndpoint;

  /** 终点端点。 */
  private to_endpoint: CableEndpoint;

  /** 场景比例（场景单位 / 米）。 */
  private scene_scale: number;

  /** 是否使用地面走线（真机房布线观感）。 */
  private floor_route_value = true;

  /** 障碍物（设备包围盒）：线缆碰到时从上方或侧面绕过，不穿模。 */
  private obstacles: THREE.Box3[] = [];

  /** 绑扎带网格。 */
  private ties: THREE.Mesh[] = [];

  /** 插拔动画状态（插头轴向推进/退出 + 卡扣到位闪光）。 */
  private anim: { mode: 'insert' | 'unplug'; elapsed: number; duration: number } | null = null;

  /** 拔出动画结束回调。 */
  private unplug_done: (() => void) | null = null;

  /** 卡扣到位闪光剩余时间（秒）。 */
  private seat_flash = 0;

  /** 改插预览用的虚拟端点（世界坐标）。 */
  private virtual_endpoints = new Map<CableEndpointSide, THREE.Vector3>();

  /** 当前插头拉出量（0 = 完全插入，1 = 完全拔出），用于插拔动画。 */
  private seat_pull = 0;

  /** 正在悬垂的端点（拔出动画后半段使用）。 */
  private hang_sides: CableEndpointSide[] = [];

  /** 两端标签（默认 A-01 / B-01，可自定义）。 */
  private labels: { from: THREE.Sprite | null; to: THREE.Sprite | null } = {
    from: null,
    to: null
  };

  /** 标签文本（两端）。 */
  private label_texts: { from: string; to: string } = { from: '', to: '' };

  /** 标签避让偏移（世界坐标，由图层统一计算）。 */
  private label_offsets: { from: THREE.Vector3; to: THREE.Vector3 } = {
    from: new THREE.Vector3(),
    to: new THREE.Vector3()
  };

  /** 当前曲线。 */
  private route: THREE.CatmullRomCurve3;

  /** 流动粒子。 */
  private flow_mesh: THREE.InstancedMesh;

  /** 流动粒子材质。 */
  private flow_material: THREE.MeshBasicMaterial;

  /** 走线把手。 */
  private handles: THREE.Mesh[] = [];

  /** 当前状态（UP / DOWN / CONNECTING）。 */
  private state_value: string;

  /** 是否选中。 */
  private selected_value = false;

  /** 电源通断/发光强度（0~1）。 */
  private power_flow_value = 1;

  /** 闪烁累计时间（秒）。 */
  private blink_time = 0;

  /** 流动粒子临时矩阵。 */
  private flow_matrix = new THREE.Matrix4();

  /** 流动粒子临时四元数。 */
  private flow_quaternion = new THREE.Quaternion();

  /** 流动粒子临时缩放。 */
  private flow_scale = new THREE.Vector3(1, 1, 1);

  /**
   * 构造线缆对象。
   *
   * @param {CableObjectOptions} options 构造参数。
   */
  constructor(options: CableObjectOptions) {
    this.kind = options.kind;
    this.connector_types = [options.kind.connectors[0], options.kind.connectors[1]];
    this.scene_scale = options.scene_scale === undefined ? 1 : options.scene_scale;
    this.from_endpoint = options.from;
    this.to_endpoint = options.to;
    this.state_value = options.state || 'DOWN';
    cable_serial += 1;
    this.cable_id = options.cable_id || 'cable_' + cable_serial;
    this.group.name = 'cable_' + this.cable_id;
    this.group.userData.cable_id = this.cable_id;

    /* 真实护套是哑光 PVC/LSZH：高粗糙度、几乎不发光。 */
    this.sheath_material = new THREE.MeshStandardMaterial({
      color: new THREE.Color(this.kind.color),
      roughness: 0.78,
      metalness: this.kind.category === 'fiber' ? 0.06 : 0.03,
      emissive: new THREE.Color('#000000'),
      emissiveIntensity: 0
    });
    this.sheath_mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.sheath_material);
    this.sheath_mesh.name = 'cable_sheath';
    this.sheath_mesh.castShadow = true;
    this.sheath_mesh.userData.cable_id = this.cable_id;
    this.sheath_mesh.userData.is_cable_body = true;
    this.group.add(this.sheath_mesh);

    this.from_connector = build_cable_connector(this.connector_types[0], this.kind);
    this.from_connector.userData.cable_id = this.cable_id;
    /* 两端都插在端口上：收起防尘帽。 */
    set_dust_cap(this.from_connector, false);
    this.attach_strain_relief(this.from_connector, this.connector_types[0]);
    this.group.add(this.from_connector);
    this.to_connector = build_cable_connector(this.connector_types[1], this.kind);
    this.to_connector.userData.cable_id = this.cable_id;
    set_dust_cap(this.to_connector, false);
    this.attach_strain_relief(this.to_connector, this.connector_types[1]);
    this.group.add(this.to_connector);

    this.flow_material = new THREE.MeshBasicMaterial({
      color: new THREE.Color(flow_color_of(this.kind)),
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
    this.flow_mesh = new THREE.InstancedMesh(
      build_flow_geometry(this.kind, this.base_radius()),
      this.flow_material,
      FLOW_PARTICLE_COUNT
    );
    this.flow_mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.flow_mesh.frustumCulled = false;
    this.flow_mesh.count = 0;
    this.flow_mesh.userData.cable_id = this.cable_id;
    this.group.add(this.flow_mesh);

    const origin = new THREE.Vector3();
    this.route = new THREE.CatmullRomCurve3([origin.clone(), origin.clone()]);
    this.refresh_route();
    this.apply_state_material();
    this.apply_flow_visibility();
    /* 首次接线：播放"插头推入"动画。 */
    this.play_insert();
  }

  /**
   * 给连接器加应力释放护套（锥形橡胶套），让插头与线缆自然衔接。
   *
   * @param {THREE.Group} connector 连接器组。
   * @param {ConnectorType} connector_type 连接器类型。
   * @returns {void}
   * @private
   */
  private attach_strain_relief(connector: THREE.Group, connector_type: ConnectorType): void {
    const exit = connector_exit(connector_type, this.kind);
    /* 注意：护套是连接器组的子对象，而连接器组会整体乘以 scene_scale，
       因此这里必须用**米**为单位（此前误用场景单位，被二次放大成巨筒）。 */
    const unit = Math.max(1e-6, this.scene_scale);
    const radius = Math.max(1e-5, (this.sheath_radius() / unit) * 1.5);
    const length = 0.009;
    const boot = new THREE.Mesh(
      new THREE.CylinderGeometry(radius, radius * 0.7, length, 12, 1, true),
      new THREE.MeshStandardMaterial({
        color: new THREE.Color(this.kind.color).multiplyScalar(0.72),
        roughness: 0.85,
        metalness: 0.02,
        /* 单面渲染：避免相机靠近时看穿护套内壁形成"大片色块"。 */
        side: THREE.FrontSide
      })
    );
    /* 局部 +Z 为插入方向，护套沿出线方向（-Z）延伸。 */
    const direction = exit.direction.clone().normalize();
    const point = exit.offset.clone().addScaledVector(direction, length / 2);
    boot.position.copy(point);
    boot.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      direction.lengthSq() > 0 ? direction : new THREE.Vector3(0, 0, -1)
    );
    boot.userData.cable_id = this.cable_id;
    connector.add(boot);
  }


  /**
   * 设置虚拟端点（改插预览）：端点临时跟随指针，不影响真实接线。
   *
   * @param {CableEndpointSide} which 端点。
   * @param {THREE.Vector3} world_point 世界坐标。
   * @returns {void}
   */
  set_virtual_endpoint(which: CableEndpointSide, world_point: THREE.Vector3): void {
    this.virtual_endpoints.set(which, world_point.clone());
    this.place_connector(this.connector_object(which), which);
    this.refresh_route();
  }

  /**
   * 清除虚拟端点（回到真实锚点）。
   *
   * @param {CableEndpointSide} which 端点。
   * @returns {void}
   */
  clear_virtual_endpoint(which: CableEndpointSide): void {
    if (!this.virtual_endpoints.has(which)) {
      return;
    }
    this.virtual_endpoints.delete(which);
    this.place_connector(this.connector_object(which), which);
    this.refresh_route();
  }

  /**
   * 播放插入动画（轴向推入 + 卡扣到位闪光）。
   *
   * @returns {void}
   */
  play_insert(): void {
    this.anim = { mode: 'insert', elapsed: 0, duration: INSERT_DURATION };
    this.unplug_done = null;
  }

  /**
   * 播放拔出动画，结束后回调（用于延迟销毁）。
   *
   * @param {() => void} [on_done] 结束回调。
   * @returns {void}
   */
  play_unplug(on_done?: () => void): void {
    /* 两段式：先轴向退出（0~40%），再沿重力自然悬垂（40%~100%）。 */
    this.hang_sides.length = 0;
    this.hang_sides.push('from', 'to');
    this.anim = { mode: 'unplug', elapsed: 0, duration: UNPLUG_DURATION };
    this.unplug_done = on_done || null;
  }

  /**
   * 是否正在播放插拔动画。
   *
   * @returns {boolean} 是否动画中。
   */
  get animating(): boolean {
    return this.anim !== null;
  }

  /**
   * 槽内绑扎带（供图层挂载/清理）。
   *
   * @returns {THREE.Mesh[]} 绑扎带网格。
   */
  tie_meshes(): THREE.Mesh[] {
    return this.ties;
  }

  /**
   * 设置避障包围盒（不含本线缆两端所属设备）。
   *
   * @param {THREE.Box3[]} boxes 世界坐标包围盒。
   * @returns {void}
   */
  set_obstacles(boxes: THREE.Box3[]): void {
    this.obstacles = boxes;
    this.refresh_route();
  }

  /**
   * 确保存在 N 个可拖拽控制点（沿当前曲线等分取样）。
   *
   * 取样点落在曲线上，因此加入后线缆形状几乎不变，用户即可"抓住线缆拉动"调整走线。
   *
   * @param {number} count 期望的控制点数量。
   * @returns {number} 新增的控制点数量。
   */
  ensure_pull_waypoints(count: number): number {
    if (this.waypoints.length >= count) {
      return 0;
    }
    const existing = this.waypoints.length;
    for (let index = 1; index <= count; index += 1) {
      const t = index / (count + 1);
      this.waypoints.push(this.route.getPointAt(t).clone());
    }
    this.refresh_route();

    return this.waypoints.length - existing;
  }

  /**
   * 导出控制点（供持久化）。
   *
   * @returns {[number, number, number][]} 控制点数组。
   */
  export_waypoints(): [number, number, number][] {
    return this.waypoints.map((point) => [point.x, point.y, point.z]);
  }

  /**
   * 导入控制点（从持久化恢复）。
   *
   * @param {[number, number, number][]} points 控制点数组。
   * @returns {void}
   */
  import_waypoints(points: [number, number, number][]): void {
    this.waypoints.length = 0;
    for (const point of points) {
      this.waypoints.push(new THREE.Vector3(point[0], point[1], point[2]));
    }
    this.refresh_route();
  }

  /**
   * 当前状态。
   *
   * @returns {string} 状态（UP / DOWN / CONNECTING）。
   */
  get state(): string {
    return this.state_value;
  }

  /**
   * 是否选中。
   *
   * @returns {boolean} 选中状态。
   */
  get selected(): boolean {
    return this.selected_value;
  }

  /**
   * 当前走线曲线（世界坐标，供场景挂载转发动画）。
   *
   * @returns {THREE.CatmullRomCurve3} 曲线。
   */
  get route_curve(): THREE.CatmullRomCurve3 {
    return this.route;
  }

  /**
   * 端点插入端面的世界坐标（即端口锚点世界坐标）。
   *
   * @param {CableEndpointSide} which 端点标识。
   * @returns {THREE.Vector3} 世界坐标。
   */
  endpoint_world(which: CableEndpointSide): THREE.Vector3 {
    const virtual = this.virtual_endpoints.get(which);
    if (virtual) {
      return virtual.clone();
    }
    const endpoint = which === 'from' ? this.from_endpoint : this.to_endpoint;
    endpoint.device_object.updateMatrixWorld(true);

    return endpoint.anchor.position.clone().applyMatrix4(endpoint.device_object.matrixWorld);
  }

  /**
   * 端点朝向（世界坐标，指向设备外部）。
   *
   * @param {CableEndpointSide} which 端点标识。
   * @returns {THREE.Vector3} 单位向量。
   */
  endpoint_direction(which: CableEndpointSide): THREE.Vector3 {
    const endpoint = which === 'from' ? this.from_endpoint : this.to_endpoint;
    endpoint.device_object.updateMatrixWorld(true);

    return endpoint.anchor.direction
      .clone()
      .transformDirection(endpoint.device_object.matrixWorld)
      .normalize();
  }

  /**
   * 端点连接器组（局部 +Z 为插入方向，原点在插入端面）。
   *
   * @param {CableEndpointSide} which 端点标识。
   * @returns {THREE.Group} 连接器组。
   */
  connector_object(which: CableEndpointSide): THREE.Group {
    return which === 'from' ? this.from_connector : this.to_connector;
  }

  /**
   * 连接器出线点（世界坐标，线缆本体从这里开始生长）。
   *
   * @param {CableEndpointSide} which 端点标识。
   * @returns {THREE.Vector3} 世界坐标。
   */
  exit_world(which: CableEndpointSide): THREE.Vector3 {
    const connector = this.connector_object(which);
    const connector_type = which === 'from' ? this.connector_types[0] : this.connector_types[1];
    this.group.updateMatrixWorld(true);
    const exit = connector_exit(connector_type, this.kind);

    return exit.offset.clone().applyMatrix4(connector.matrixWorld);
  }

  /**
   * 连接器出线方向（世界坐标，单位向量）。
   *
   * @param {CableEndpointSide} which 端点标识。
   * @returns {THREE.Vector3} 单位向量。
   */
  exit_direction(which: CableEndpointSide): THREE.Vector3 {
    const connector = this.connector_object(which);
    const connector_type = which === 'from' ? this.connector_types[0] : this.connector_types[1];
    this.group.updateMatrixWorld(true);
    const exit = connector_exit(connector_type, this.kind);

    return exit.direction.clone().transformDirection(connector.matrixWorld).normalize();
  }

  /**
   * 当前管道半径（世界单位）。
   *
   * @returns {number} 半径。
   */
  sheath_radius(): number {
    const factor = this.selected_value ? SELECTED_RADIUS_FACTOR : 1;

    return this.base_radius() * factor;
  }

  /**
   * 走线长度（米，按场景比例折算回真实长度）。
   *
   * @returns {number} 长度（米）。
   */
  route_length(): number {
    if (!this.route) {
      return 0;
    }

    return this.route.getLength() / Math.max(1e-6, this.scene_scale);
  }

  /**
   * 追加一个走线控制点。
   *
   * @param {THREE.Vector3} point 世界坐标。
   * @returns {number} 新控制点下标。
   */
  add_waypoint(point: THREE.Vector3): number {
    this.waypoints.push(point.clone());
    this.refresh_route();

    return this.waypoints.length - 1;
  }

  /**
   * 移动一个走线控制点。
   *
   * @param {number} index 控制点下标。
   * @param {THREE.Vector3} point 新的世界坐标。
   * @returns {boolean} 是否移动成功。
   */
  move_waypoint(index: number, point: THREE.Vector3): boolean {
    if (index < 0 || index >= this.waypoints.length) {
      return false;
    }
    this.waypoints[index].copy(point);
    this.refresh_route();

    return true;
  }

  /**
   * 删除一个走线控制点。
   *
   * @param {number} index 控制点下标。
   * @returns {boolean} 是否删除成功。
   */
  remove_waypoint(index: number): boolean {
    if (index < 0 || index >= this.waypoints.length) {
      return false;
    }
    this.waypoints.splice(index, 1);
    this.refresh_route();

    return true;
  }

  /**
   * 清除全部自定义走线，恢复自然悬垂路径。
   *
   * @returns {void}
   */
  reset_route(): void {
    this.waypoints.length = 0;
    this.refresh_route();
  }

  /**
   * 取走线把手（可拾取网格，userData 带 cable_id 与 waypoint_index）。
   *
   * @returns {THREE.Mesh[]} 把手数组（副本）。
   */
  waypoint_handles(): THREE.Mesh[] {
    return this.handles.slice();
  }

  /**
   * 重新吸附端点（改插到别的端口）。
   *
   * @param {CableEndpointSide} which 端点标识。
   * @param {PortAnchor} anchor 新锚点。
   * @param {THREE.Object3D} device_object 新设备对象。
   * @returns {void}
   */
  set_endpoint(which: CableEndpointSide, anchor: PortAnchor, device_object: THREE.Object3D): void {
    if (which === 'from') {
      this.from_endpoint = { anchor: anchor, device_object: device_object };
    } else {
      this.to_endpoint = { anchor: anchor, device_object: device_object };
    }
    this.refresh_route();
  }

  /**
   * 设置场景比例（线径随比例换算，走线重算）。
   *
   * @param {number} scene_scale 场景比例（场景单位 / 米）。
   * @returns {void}
   */
  set_scene_scale(scene_scale: number): void {
    this.scene_scale = Math.max(1e-6, scene_scale);
    this.refresh_route();
  }

  /**
   * 选中/取消选中：线径加粗 + 高亮，并显示走线把手。
   *
   * @param {boolean} selected 是否选中。
   * @returns {void}
   */
  set_selected(selected: boolean): void {
    this.selected_value = Boolean(selected);
    for (const handle of this.handles) {
      handle.visible = this.selected_value;
    }
    this.apply_state_material();
    this.apply_sheath_geometry();
  }

  /**
   * 设置链路状态（UP 亮 / DOWN 暗 / CONNECTING 闪烁）。
   *
   * @param {string} state 状态（UP / DOWN / CONNECTING）。
   * @returns {void}
   */
  set_state(state: string): void {
    this.state_value = state || 'DOWN';
    this.apply_state_material();
    this.apply_flow_visibility();
  }

  /**
   * 设置电源通断/发光强度（0~1，电源线用来表示通电与否）。
   *
   * @param {number} level 强度（0~1）。
   * @returns {void}
   */
  set_power_flow(level: number): void {
    this.power_flow_value = clamp_value(level, 0, 1);
    this.apply_state_material();
    this.apply_flow_visibility();
  }

  /**
   * 按当前端点与走线控制点重算曲线、管道与把手。
   *
   * @returns {void}
   */
  refresh_route(): void {
    if (this.disposed) {
      return;
    }
    this.group.updateMatrixWorld(true);
    this.place_connector(this.from_connector, 'from');
    this.place_connector(this.to_connector, 'to');
    this.group.updateMatrixWorld(true);
    const base_curve = new THREE.CatmullRomCurve3(this.route_points(), false, 'catmullrom', 0.5);
    this.route = this.avoid_obstacles(base_curve);
    this.apply_sheath_geometry();
    this.rebuild_handles();
    this.rebuild_ties();
    this.update_label_positions();
  }

  /**
   * 推进插拔动画：插头沿端口轴向推进/退出，结束时闪一下（卡扣到位）。
   *
   * @param {number} delta 时间增量（秒）。
   * @returns {void}
   * @private
   */
  private _update_plug_animation(delta: number): void {
    const anim = this.anim;
    if (!anim) {
      return;
    }
    anim.elapsed += delta;
    const progress = Math.min(1, anim.elapsed / anim.duration);
    /* 插入用 ease-out（先快后慢"顶到位"），拔出用 ease-in（先慢后快）。 */
    const eased =
      anim.mode === 'insert'
        ? 1 - Math.pow(1 - progress, 3)
        : progress * progress;
    const pull = anim.mode === 'insert' ? 1 - eased : eased;
    this.apply_connector_seat(pull);
    /* 拔出后半段：插头脱离端口后沿重力下垂（最多 HANG_DROP_METERS，且不穿地）。 */
    if (anim.mode === 'unplug' && progress > UNPLUG_SEAT_RATIO) {
      const hang_progress = (progress - UNPLUG_SEAT_RATIO) / (1 - UNPLUG_SEAT_RATIO);
      this.apply_hang(hang_progress);
    }
    if (progress < 1) {
      return;
    }
    if (anim.mode === 'insert') {
      this.flash_seat();
      this.anim = null;
      return;
    }
    for (const side of this.hang_sides) {
      this.virtual_endpoints.delete(side);
    }
    this.hang_sides.length = 0;
    const done = this.unplug_done;
    this.anim = null;
    this.unplug_done = null;
    if (done) {
      done();
    }
  }

  /**
   * 设置两端标签文本（A-01 / B-01）。
   *
   * @param {string} from_text 起点标签。
   * @param {string} to_text 终点标签。
   * @returns {void}
   */
  set_label_text(from_text: string, to_text: string): void {
    this.label_texts = { from: from_text, to: to_text };
    /* 标签是纯视觉对象：无 DOM（单元测试）时跳过创建。 */
    if (typeof document === 'undefined') {
      return;
    }
    for (const side of ['from', 'to'] as CableEndpointSide[]) {
      const existing = this.labels[side];
      if (existing) {
        this.group.remove(existing);
        existing.material.map?.dispose();
        existing.material.dispose();
      }
    }
    this.labels.from = create_end_label(from_text);
    this.labels.to = create_end_label(to_text);
    for (const side of ['from', 'to'] as CableEndpointSide[]) {
      const sprite = this.labels[side];
      if (sprite) {
        sprite.userData.cable_id = this.cable_id;
        /* 供射线拾取识别标签归属（点标签改文字）。 */
        sprite.userData.label_ref = { cable_id: this.cable_id, side: side };
        this.group.add(sprite);
      }
    }
    this.update_label_positions();
  }

  /**
   * 更新标签位置：贴在插头后方（沿出线方向偏移），始终面向相机。
   *
   * @returns {void}
   */
  update_label_positions(): void {
    for (const side of ['from', 'to'] as CableEndpointSide[]) {
      const sprite = this.labels[side];
      if (!sprite) {
        continue;
      }
      sprite.position.copy(this.label_position(side));
    }
  }

  /**
   * 标签锚点（未加避让偏移的世界坐标），供图层做避让排布。
   *
   * @param {CableEndpointSide} side 端点。
   * @returns {THREE.Vector3} 锚点。
   */
  label_anchor(side: CableEndpointSide): THREE.Vector3 {
    const exit = this.exit_world(side);
    const direction = this.exit_direction(side);
    const position = exit.clone().addScaledVector(direction, LABEL_OFFSET);
    position.y += LABEL_LIFT;

    return position;
  }

  /**
   * 标签最终位置 = 锚点 + 避让偏移（唯一位置来源，Sprite 与测试共用）。
   *
   * @param {CableEndpointSide} side 端点。
   * @returns {THREE.Vector3} 世界坐标。
   */
  label_position(side: CableEndpointSide): THREE.Vector3 {
    return this.label_anchor(side).add(this.label_offsets[side]);
  }

  /**
   * 设置标签避让偏移（图层统一计算后回填）。
   *
   * @param {CableEndpointSide} side 端点。
   * @param {THREE.Vector3} offset 偏移。
   * @returns {void}
   */
  set_label_offset(side: CableEndpointSide, offset: THREE.Vector3): void {
    this.label_offsets[side].copy(offset);
    this.update_label_positions();
  }

  /**
   * 取标签 Sprite（供射线拾取与测试）。
   *
   * @param {CableEndpointSide} side 端点。
   * @returns {THREE.Sprite | null} 标签对象。
   */
  label_object(side: CableEndpointSide): THREE.Sprite | null {
    return this.labels[side];
  }

  /**
   * 当前标签文本。
   *
   * @returns {{ from: string, to: string }} 两端文本。
   */
  get label_text(): { from: string; to: string } {
    return { from: this.label_texts.from, to: this.label_texts.to };
  }

  /**
   * 插头悬垂：沿重力把已拔出的插头往下放（最多 30 cm，且被地面挡住）。
   *
   * @param {number} progress 悬垂进度（0 = 刚开始脱离，1 = 完全垂下）。
   * @returns {void}
   * @private
   */
  private apply_hang(progress: number): void {
    for (const side of this.hang_sides) {
      const port_world = this.endpoint_world(side);
      const outward = this.endpoint_direction(side);
      const active_type = side === 'from' ? this.connector_types[0] : this.connector_types[1];
      const length = connector_length(active_type, this.kind) * this.scene_scale;
      /* 先脱出端口，再沿重力下垂；下垂量受"端口到地面"的可用高度限制。 */
      const cleared = port_world.clone().addScaledVector(outward, length * 0.95);
      const available = Math.max(0.05, cleared.y - FLOOR_LEVEL_Y - this.sheath_radius());
      const drop = Math.min(HANG_DROP_METERS * this.scene_scale, available) * progress;
      const hanging = cleared.clone();
      hanging.y -= drop;
      this.virtual_endpoints.set(side, hanging);
    }
    this.refresh_route();
  }

  /**
   * 按"未插入程度"调整两端插头的轴向位置。
   *
   * @param {number} pull 0 = 完全插入，1 = 完全拔出。
   * @returns {void}
   * @private
   */
  private apply_connector_seat(pull: number): void {
    this.seat_pull = pull;
    /* refresh_route 内部会重新摆放两端接头（place_connector 会带上 seat_pull），
       因此这里只需更新一次即可让插头与走线同步跟随动画。 */
    this.refresh_route();
  }

  /**
   * 卡扣到位闪光：插头自发光短促增亮。
   *
   * @returns {void}
   * @private
   */
  private flash_seat(): void {
    this.seat_flash = SEAT_FLASH_DURATION;
  }

  /**
   * 推进卡扣闪光衰减。
   *
   * @param {number} delta 时间增量（秒）。
   * @returns {void}
   * @private
   */
  private _update_seat_flash(delta: number): void {
    if (this.seat_flash <= 0) {
      return;
    }
    this.seat_flash = Math.max(0, this.seat_flash - delta);
    const intensity = this.seat_flash / SEAT_FLASH_DURATION;
    for (const side of ['from', 'to'] as CableEndpointSide[]) {
      const connector = this.connector_object(side);
      connector.traverse((object) => {
        const mesh = object as THREE.Mesh;
        const material = mesh.material as THREE.MeshStandardMaterial | undefined;
        if (material && material.emissive && 'emissiveIntensity' in material) {
          material.emissiveIntensity = Math.max(material.emissiveIntensity, intensity * 0.8);
        }
      });
    }
  }

  /**
   * 重建槽内绑扎带（仅对贴在槽内的线段生效）。
   *
   * @returns {void}
   * @private
   */
  private rebuild_ties(): void {
    for (const tie of this.ties) {
      this.group.remove(tie);
    }
    this.ties = [];
  }

  /**
   * 避障：采样路径，凡落入设备包围盒的点抬到盒顶之上，再从修正后的点重建曲线。
   *
   * 效果与真机一致——线缆压过设备时从**设备上方**绕行（设备放在地上，下方没有空间），
   * 而不是直接从机箱里穿过去。
   *
   * @param {THREE.CatmullRomCurve3} curve 原始路径曲线。
   * @returns {THREE.CatmullRomCurve3} 修正后的曲线。
   * @private
   */
  private avoid_obstacles(curve: THREE.CatmullRomCurve3): THREE.CatmullRomCurve3 {
    const samples = curve.getPoints(OBSTACLE_SAMPLE_COUNT);
    let adjusted = false;
    if (this.obstacles.length > 0) {
      const clearance = Math.max(0.02, this.sheath_radius() * 1.6);
      const margin = clearance * 1.4;
      const box = new THREE.Box3();
      for (let index = 0; index < samples.length; index += 1) {
        const point = samples[index];
        for (const obstacle of this.obstacles) {
          /* 水平方向进入包围盒、且高度在盒体范围内 → 判定为穿模。 */
          box.copy(obstacle).expandByScalar(margin);
          const inside =
            point.x >= box.min.x &&
            point.x <= box.max.x &&
            point.z >= box.min.z &&
            point.z <= box.max.z &&
            point.y >= box.min.y &&
            point.y <= box.max.y;
          if (!inside) {
            continue;
          }
          /* 两种绕行方案取代价更小者：抬到设备上方 / 从设备侧面绕过。 */
          const lift_cost = box.max.y + clearance - point.y;
          const side_options = [
            { axis: 'x' as const, value: box.max.x + clearance },
            { axis: 'x' as const, value: box.min.x - clearance },
            { axis: 'z' as const, value: box.max.z + clearance },
            { axis: 'z' as const, value: box.min.z - clearance }
          ];
          let best_side = side_options[0];
          let best_cost = Number.POSITIVE_INFINITY;
          for (const option of side_options) {
            const cost = Math.abs(option.value - point[option.axis]);
            if (cost < best_cost) {
              best_cost = cost;
              best_side = option;
            }
          }
          if (best_cost <= lift_cost) {
            /* 侧面绕行更近：贴到设备侧边（机柜侧沿走线）。 */
            point[best_side.axis] = best_side.value;
          } else {
            point.y = box.max.y + clearance;
          }
          adjusted = true;
        }
      }
    }

    if (!adjusted) {
      return curve;
    }
    const smoothed = this.enforce_bend_radius(samples);

    return new THREE.CatmullRomCurve3(smoothed, false, 'catmullrom', 0.5);
  }

  /**
   * 最小弯曲半径约束：对折角过小的顶点做多轮平滑，直到满足半径要求。
   *
   * 线缆不能被折成直角——真机的铜缆/光纤都有最小弯曲半径，这里用
   * "相邻三点外接圆半径 ≥ MIN_BEND_RADIUS" 作为约束，用拉普拉斯平滑逼近。
   *
   * @param {THREE.Vector3[]} samples 采样点（会被复制，不修改入参）。
   * @returns {THREE.Vector3[]} 平滑后的点。
   * @private
   */
  private enforce_bend_radius(samples: THREE.Vector3[]): THREE.Vector3[] {
    const points = samples.map((point) => point.clone());
    if (points.length < 3) {
      return points;
    }
    /* 目标最小弯曲半径：约 4 倍线径（Cat6 真机要求 4×外径），并给下限防止过平滑。 */
    const min_radius = Math.max(0.12, this.sheath_radius() * 4);
    for (let iteration = 0; iteration < BEND_RELAX_ITERATIONS; iteration += 1) {
      let violated = false;
      const next = points.map((point) => point.clone());
      for (let index = 1; index < points.length - 1; index += 1) {
        const previous = points[index - 1];
        const current = points[index];
        const following = points[index + 1];
        const radius = triangle_circumradius(previous, current, following);
        if (radius >= min_radius) {
          continue;
        }
        violated = true;
        /* 折角过急：把顶点往邻居中点方向拉，摊平折角。 */
        const middle = previous.clone().add(following).multiplyScalar(0.5);
        next[index] = current.clone().lerp(middle, 0.5);
      }
      for (let index = 1; index < points.length - 1; index += 1) {
        points[index].copy(next[index]);
      }
      if (!violated) {
        break;
      }
    }

    return points;
  }

  /**
   * 每帧更新：状态闪烁与流动粒子（光纤光脉冲 / 网线数据包点 / 电源能量点）。
   *
   * @param {number} delta_seconds 时间增量（秒）。
   * @returns {void}
   */
  update(delta_seconds: number): void {
    if (this.disposed) {
      return;
    }
    const delta = Math.max(0, delta_seconds || 0);
    this._update_plug_animation(delta);
    this._update_seat_flash(delta);
    if (this.state_value === 'CONNECTING') {
      this.blink_time += delta;
      const blink = 0.5 + 0.5 * Math.sin(this.blink_time * Math.PI * 2 * CONNECTING_BLINK_HZ);
      this.sheath_material.emissiveIntensity = 0.05 + 0.35 * blink;
    }
    if (this.state_value !== 'UP' || this.power_flow_value <= 0.01) {
      this.flow_phase = 0;
      this.flow_mesh.count = 0;
      return;
    }
    this.flow_phase =
      (this.flow_phase + delta * flow_speed_of(this.kind) * this.power_flow_value) % 1;
    this.update_flow_instances();
    this.flow_mesh.count = FLOW_PARTICLE_COUNT;
  }

  /**
   * 释放几何体与材质。
   *
   * @returns {void}
   */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.flow_mesh.count = 0;
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    this.group.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh && !(mesh as THREE.InstancedMesh).isInstancedMesh) {
        return;
      }
      if (mesh.geometry) {
        geometries.add(mesh.geometry);
      }
      const material = mesh.material;
      if (Array.isArray(material)) {
        for (const item of material) {
          materials.add(item);
        }
      } else if (material) {
        materials.add(material);
      }
    });
    for (const geometry of geometries) {
      geometry.dispose();
    }
    for (const material of materials) {
      material.dispose();
    }
    this.handles = [];
    this.ties = [];
    this.waypoints.length = 0;
    this.group.clear();
    if (this.group.parent) {
      this.group.parent.remove(this.group);
    }
  }

  /**
   * 基础管道半径（未选中时，世界单位）。
   *
   * @returns {number} 半径。
   * @private
   */
  private base_radius(): number {
    return Math.max(0.0005, (this.kind.diameter_m * this.scene_scale) / 2);
  }

  /**
   * 走线把手半径（世界单位）。
   *
   * @returns {number} 半径。
   * @private
   */
  private handle_radius(): number {
    return Math.max(0.008, this.kind.diameter_m * this.scene_scale * 2.5);
  }

  /**
   * 把连接器摆到端口锚点上：位置 = 锚点世界坐标，局部 +Z 指向端口内部（插入方向）。
   *
   * @param {THREE.Group} connector 连接器组。
   * @param {CableEndpointSide} which 端点标识。
   * @returns {void}
   * @private
   */
  private place_connector(connector: THREE.Group, which: CableEndpointSide): void {
    const endpoint = which === 'from' ? this.from_endpoint : this.to_endpoint;
    const world_position = this.endpoint_world(which);
    const outward = this.endpoint_direction(which);
    /* 锚点 direction 指向设备外部；插入方向与之相反，连接器本体因此露在机箱外侧。 */
    const insert_direction = outward.clone().negate();
    /* 往端口里再推进约 35% 插头长度，让接头真正"坐进"插座（而不是贴着面板悬着）；
       插拔动画期间再叠加当前拉出量（seat_pull：0 = 已插入，1 = 完全拔出）。 */
    const active_type = which === 'from' ? this.connector_types[0] : this.connector_types[1];
    const endpoint_scene_scale =
      Number(endpoint.device_object.userData?.connector_scene_scale) || this.scene_scale;
    const length = connector_length(active_type, this.kind) * endpoint_scene_scale;
    const seat = length * CONNECTOR_SEAT_RATIO;
    connector.position
      .copy(world_position)
      .addScaledVector(insert_direction, seat - length * this.seat_pull * 0.95);
    connector.quaternion.setFromUnitVectors(INSERT_AXIS, insert_direction);
    connector.scale.setScalar(endpoint_scene_scale);
  }

  /**
   * 计算曲线控制点：出线段 + 走线控制点（或自然垂点）+ 入线段。
   *
   * @returns {THREE.Vector3[]} 控制点。
   * @private
   */
  private route_points(): THREE.Vector3[] {
    const from_exit = this.exit_world('from');
    const to_exit = this.exit_world('to');
    const from_direction = this.exit_direction('from');
    const to_direction = this.exit_direction('to');
    const span = from_exit.distanceTo(to_exit);
    const lead = clamp_value(span * LEAD_RATIO, MIN_LEAD, MAX_LEAD);
    const points: THREE.Vector3[] = [
      from_exit,
      from_exit.clone().addScaledVector(from_direction, lead)
    ];
    if (this.waypoints.length > 0) {
      for (const waypoint of this.waypoints) {
        points.push(waypoint.clone());
      }
    } else if (this.floor_route_value) {
      /* 真机房走线：从设备出线后垂到地面、贴地走一段再升到对端端口。 */
      const floor_points = this.floor_route_points(
        from_exit,
        to_exit,
        from_direction,
        to_direction
      );
      for (const point of floor_points) {
        points.push(point);
      }
    } else {
      points.push(this.sag_point(from_exit, to_exit));
    }
    points.push(to_exit.clone().addScaledVector(to_direction, lead));
    points.push(to_exit);

    return points;
  }

  /**
   * 自然垂点：下垂量与两端水平距离相关（越远垂得越多，但有上下限）。
   *
   * @param {THREE.Vector3} from_point 起点（出线点）。
   * @param {THREE.Vector3} to_point 终点（出线点）。
   * @returns {THREE.Vector3} 垂点。
   * @private
   */
  private sag_point(from_point: THREE.Vector3, to_point: THREE.Vector3): THREE.Vector3 {
    const middle = from_point.clone().add(to_point).multiplyScalar(0.5);
    const horizontal = Math.hypot(to_point.x - from_point.x, to_point.z - from_point.z);
    middle.y -= clamp_value(horizontal * SAG_RATIO, MIN_SAG, MAX_SAG);

    return middle;
  }

  /**
   * 地面走线控制点：出线 → 落地 → 地面折线（带一处狗腿）→ 上升。
   *
   * 真实机房里线缆不会在空中拉直线，而是顺设备后方落到地面/线槽再走，
   * 这里用"落地 + 地面折线 + 上升"三点近似，并保留最小弯曲半径。
   *
   * @param {THREE.Vector3} from_exit 起点出线点（世界坐标）。
   * @param {THREE.Vector3} to_exit 终点出线点（世界坐标）。
   * @param {THREE.Vector3} from_direction 起点出线方向。
   * @param {THREE.Vector3} to_direction 终点出线方向。
   * @returns {THREE.Vector3[]} 控制点（不含两端出线点）。
   * @private
   */
  private floor_route_points(
    from_exit: THREE.Vector3,
    to_exit: THREE.Vector3,
    from_direction: THREE.Vector3,
    to_direction: THREE.Vector3
  ): THREE.Vector3[] {
    const floor_y = FLOOR_ROUTE_HEIGHT;
    const lead = clamp_value(from_exit.distanceTo(to_exit) * 0.12, 0.6, 2.4);
    const start_drop = from_exit.clone().addScaledVector(from_direction, lead);
    start_drop.y = floor_y;
    const end_drop = to_exit.clone().addScaledVector(to_direction, lead);
    end_drop.y = floor_y;
    /* 地面中点做一处横向偏移，形成自然的狗腿（避免两条线完全重合）。 */
    const middle = start_drop.clone().add(end_drop).multiplyScalar(0.5);
    const direction_x = end_drop.x - start_drop.x;
    const direction_z = end_drop.z - start_drop.z;
    const length = Math.max(1e-6, Math.hypot(direction_x, direction_z));
    const offset = clamp_value(length * 0.1, 0.25, 1.1);
    middle.x += (-direction_z / length) * offset;
    middle.z += (direction_x / length) * offset;

    return [start_drop, middle, end_drop];
  }

  /**
   * 按当前曲线重建管道几何体（选中时加粗）。
   *
   * @returns {void}
   * @private
   */
  private apply_sheath_geometry(): void {
    if (this.disposed) {
      return;
    }
    const previous = this.sheath_mesh.geometry;
    const segments = Math.max(32, this.route.points.length * 12);
    this.sheath_mesh.geometry = new THREE.TubeGeometry(
      this.route,
      segments,
      this.sheath_radius(),
      8,
      false
    );
    if (previous) {
      previous.dispose();
    }
  }

  /**
   * 重建走线把手。
   *
   * @returns {void}
   * @private
   */
  private rebuild_handles(): void {
    for (const handle of this.handles) {
      this.group.remove(handle);
      handle.geometry.dispose();
      (handle.material as THREE.Material).dispose();
    }
    this.handles = [];
    const radius = this.handle_radius();
    for (let index = 0; index < this.waypoints.length; index += 1) {
      const handle = new THREE.Mesh(
        new THREE.SphereGeometry(radius, 12, 10),
        new THREE.MeshStandardMaterial({
          color: new THREE.Color(SELECTED_COLOR),
          emissive: new THREE.Color(SELECTED_COLOR),
          emissiveIntensity: 0.7,
          transparent: true,
          opacity: 0.92,
          depthWrite: false
        })
      );
      handle.position.copy(this.waypoints[index]);
      handle.name = 'waypoint_handle';
      handle.userData.cable_id = this.cable_id;
      handle.userData.waypoint_index = index;
      handle.userData.is_waypoint_handle = true;
      handle.visible = this.selected_value;
      this.group.add(handle);
      this.handles.push(handle);
    }
  }

  /**
   * 按状态刷新护套材质（UP 亮 / DOWN 暗 / CONNECTING 闪烁基准 / 选中高亮）。
   *
   * @returns {void}
   * @private
   */
  private apply_state_material(): void {
    const base_color = new THREE.Color(this.kind.color);
    const is_dim = this.state_value === 'DOWN' || this.state_value === 'ERROR';
    if (is_dim) {
      this.sheath_material.color.copy(base_color).multiplyScalar(0.45);
      this.sheath_material.emissive.setHex(0x000000);
      this.sheath_material.emissiveIntensity = 0;
    } else if (this.state_value === 'CONNECTING') {
      this.sheath_material.color.copy(base_color);
      this.sheath_material.emissive.set(CONNECTING_COLOR);
      this.sheath_material.emissiveIntensity = 0.7;
    } else {
      this.sheath_material.color.copy(base_color);
      /* 只保留极弱自发光表示"链路已通"，避免整根线像霓虹灯管。 */
      this.sheath_material.emissive.copy(base_color);
      this.sheath_material.emissiveIntensity =
        0.04 + 0.08 * (this.kind.category === 'power' ? this.power_flow_value : 1);
    }
    if (this.selected_value) {
      this.sheath_material.emissive.set(SELECTED_COLOR);
      this.sheath_material.emissiveIntensity = Math.max(
        0.55,
        this.sheath_material.emissiveIntensity + 0.4
      );
    }
  }

  /**
   * 流动粒子的显隐（仅 UP 且通电时显示）。
   *
   * @returns {void}
   * @private
   */
  private apply_flow_visibility(): void {
    const visible = this.state_value === 'UP' && this.power_flow_value > 0.01;
    this.flow_mesh.visible = visible;
    if (!visible) {
      this.flow_mesh.count = 0;
    }
  }

  /**
   * 按当前相位摆放流动粒子。
   *
   * @returns {void}
   * @private
   */
  private update_flow_instances(): void {
    for (let index = 0; index < FLOW_PARTICLE_COUNT; index += 1) {
      const progress = (this.flow_phase + index / FLOW_PARTICLE_COUNT) % 1;
      const point = this.route.getPointAt(progress);
      this.flow_matrix.compose(point, this.flow_quaternion, this.flow_scale);
      this.flow_mesh.setMatrixAt(index, this.flow_matrix);
    }
    this.flow_mesh.instanceMatrix.needsUpdate = true;
  }
}
