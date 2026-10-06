/**
 * @File : web/src/editor/transform_gizmo.ts
 * @Time : 2026-10-07 16:40
 * @Author : Cetrp
 * @Description : 工坊用变换 Gizmo：移动（轴向箭头 + 平面块）、旋转（三轴圆环）、
 *               缩放（轴向方块 + 中心均匀缩放）。交互风格对齐 3ds Max：
 *               点住手柄拖动为实时预览，松手才提交一次编辑（便于撤销）。
 */

import * as THREE from 'three';

/** Gizmo 模式。 */
export type GizmoMode = 'translate' | 'rotate' | 'scale' | 'none';

/** 拖拽类型。 */
export type GizmoHandleType = 'axis' | 'plane' | 'uniform' | 'rotate';

/** 命中的手柄。 */
export interface GizmoHandle {
  /** 手柄类型。 */
  type: GizmoHandleType;
  /** 轴（0=X，1=Y，2=Z；平面块与均匀缩放为 -1）。 */
  axis: number;
  /** 平面法向轴（仅 plane 类型有效）。 */
  normal_axis?: number;
}

/** 拖拽结果。 */
export interface GizmoDelta {
  /** 平移增量（本地单位：米）。 */
  translate: THREE.Vector3;
  /** 旋转增量（弧度，按轴）。 */
  rotate: THREE.Vector3;
  /** 缩放增量（倍数，按轴）。 */
  scale: THREE.Vector3;
}

/** 轴颜色（X 红 / Y 绿 / Z 蓝，与主流 DCC 一致）。 */
const AXIS_COLORS = [0xff5a6e, 0x2bff9a, 0x4aa8ff];

/** 手柄细分参数。 */
const SHAFT_LENGTH = 1;
const SHAFT_RADIUS = 0.022;
const HEAD_LENGTH = 0.22;
const HEAD_RADIUS = 0.062;
const PLANE_SIZE = 0.22;
const RING_RADIUS = 0.82;
const RING_TUBE = 0.014;
/** 独立于可见细环的宽拾取圈，避免必须精确点中不到 1px 的线条。 */
const ROTATE_PICK_TUBE = 0.085;
const SCALE_BOX = 0.075;

/** Gizmo 在屏幕上的目标像素高度（保持恒定视觉大小）。 */
const SCREEN_SIZE_PX = 132;

/**
 * 构造轴向材质（带自发光，暗场景下清晰可见）。
 *
 * @param {number} color 颜色。
 * @param {number} [opacity] 不透明度。
 * @returns {THREE.MeshBasicMaterial} 材质。
 */
function axis_material(color: number, opacity = 1): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color: new THREE.Color(color),
    transparent: opacity < 1,
    opacity: opacity,
    depthTest: false,
    depthWrite: false,
    toneMapped: false
  });
}

/**
 * 变换 Gizmo。
 */
export class TransformGizmo {
  /** 根组。 */
  readonly group = new THREE.Group();

  /** 当前模式。 */
  private mode_value: GizmoMode = 'translate';

  /** 平移组。 */
  private translate_group = new THREE.Group();

  /** 旋转组。 */
  private rotate_group = new THREE.Group();

  /** 缩放组。 */
  private scale_group = new THREE.Group();

  /** 手柄 → 语义映射。 */
  private handle_index = new Map<THREE.Object3D, GizmoHandle>();

  /** 拖拽状态。 */
  private drag: {
    handle: GizmoHandle;
    start: THREE.Vector3;
    start_angle: number;
    last_delta: GizmoDelta;
  } | null = null;

  /** 拖拽回调（实时预览）。 */
  on_drag: ((delta: GizmoDelta) => void) | null = null;

  /** 拖拽结束回调（提交编辑）。 */
  on_commit: ((delta: GizmoDelta) => void) | null = null;

  /**
   * 构造。
   */
  constructor() {
    this.group.name = 'transform_gizmo';
    this.group.renderOrder = 999;
    this.group.add(this.translate_group, this.rotate_group, this.scale_group);
    this._build_translate();
    this._build_rotate();
    this._build_scale();
    this.set_mode('translate');
  }

  /**
   * 当前模式。
   *
   * @returns {GizmoMode} 模式。
   */
  get mode(): GizmoMode {
    return this.mode_value;
  }

  /**
   * 是否正在拖拽。
   *
   * @returns {boolean} 是否拖拽中。
   */
  get dragging(): boolean {
    return this.drag !== null;
  }

  /**
   * 设置模式。
   *
   * @param {GizmoMode} mode 模式。
   * @returns {void}
   */
  set_mode(mode: GizmoMode): void {
    this.mode_value = mode;
    this.group.visible = mode !== 'none';
    this.translate_group.visible = mode === 'translate';
    this.rotate_group.visible = mode === 'rotate';
    this.scale_group.visible = mode === 'scale';
  }

  /**
   * 把 Gizmo 摆到目标点，并按相机距离保持屏幕尺寸恒定。
   *
   * @param {THREE.Vector3} world_position 目标世界坐标。
   * @param {THREE.Camera} camera 相机。
   * @returns {void}
   */
  place(world_position: THREE.Vector3, camera: THREE.Camera): void {
    this.group.position.copy(world_position);
    const distance = camera.position.distanceTo(world_position);
    const perspective = camera as THREE.PerspectiveCamera;
    const fov = perspective.fov === undefined ? 45 : perspective.fov;
    const visible_height = 2 * Math.tan((fov * Math.PI) / 360) * Math.max(0.001, distance);
    const height = (typeof window === 'undefined' ? 800 : window.innerHeight) || 800;
    const scale = (SCREEN_SIZE_PX / height) * visible_height;
    this.group.scale.setScalar(Math.max(1e-6, scale));
  }

  /**
   * 射线检测手柄。
   *
   * @param {THREE.Raycaster} raycaster 射线。
   * @returns {THREE.Intersection | null} 命中结果。
   */
  pick(raycaster: THREE.Raycaster): THREE.Intersection | null {
    if (this.mode_value === 'none') {
      return null;
    }
    const hits = raycaster.intersectObject(this.group, true);

    return hits.length > 0 ? hits[0] : null;
  }

  /**
   * 命中对象对应的手柄语义。
   *
   * @param {THREE.Object3D} object 命中对象。
   * @returns {GizmoHandle | null} 手柄语义。
   */
  handle_of(object: THREE.Object3D): GizmoHandle | null {
    let node: THREE.Object3D | null = object;
    while (node && !this.handle_index.has(node)) {
      node = node.parent;
    }

    return node ? (this.handle_index.get(node) as GizmoHandle) : null;
  }

  /**
   * 开始拖拽。
   *
   * @param {GizmoHandle} handle 手柄。
   * @param {THREE.Raycaster} raycaster 射线。
   * @returns {boolean} 是否开始成功。
   */
  begin(handle: GizmoHandle, raycaster: THREE.Raycaster): boolean {
    const origin = this.group.position.clone();
    if (handle.type === 'axis' || handle.type === 'uniform') {
      const axis = this._axis_vector(handle.axis);
      const point = this._closest_on_axis(raycaster, origin, axis);
      if (!point) {
        return false;
      }
      this.drag = {
        handle: handle,
        start: point,
        start_angle: 0,
        last_delta: this._empty_delta()
      };

      return true;
    }
    if (handle.type === 'plane') {
      const normal = this._axis_vector(handle.normal_axis === undefined ? 1 : handle.normal_axis);
      const point = this._intersect_plane(raycaster, origin, normal);
      if (!point) {
        return false;
      }
      this.drag = {
        handle: handle,
        start: point,
        start_angle: 0,
        last_delta: this._empty_delta()
      };

      return true;
    }
    /* 旋转：与圆环所在平面求交，记录起始角。 */
    const normal = this._axis_vector(handle.axis);
    const point = this._intersect_plane(raycaster, origin, normal);
    if (!point) {
      return false;
    }
    this.drag = {
      handle: handle,
      start: point,
      start_angle: this._angle_on_plane(origin, normal, point),
      last_delta: this._empty_delta()
    };

    return true;
  }

  /**
   * 拖拽中：根据射线算出增量并回调。
   *
   * @param {THREE.Raycaster} raycaster 射线。
   * @returns {GizmoDelta | null} 增量（未拖拽时为 null）。
   */
  move(raycaster: THREE.Raycaster): GizmoDelta | null {
    const drag = this.drag;
    if (!drag) {
      return null;
    }
    const origin = this.group.position.clone();
    const delta = this._empty_delta();
    if (drag.handle.type === 'axis') {
      const axis = this._axis_vector(drag.handle.axis);
      const point = this._closest_on_axis(raycaster, origin, axis);
      if (!point) {
        return null;
      }
      const amount = point.clone().sub(drag.start).dot(axis);
      if (this.mode_value === 'scale') {
        delta.scale.setComponent(drag.handle.axis, 1 + amount / SHAFT_LENGTH);
      } else {
        delta.translate.copy(axis).multiplyScalar(amount);
      }
    } else if (drag.handle.type === 'plane') {
      const normal_axis = drag.handle.normal_axis === undefined ? 1 : drag.handle.normal_axis;
      const normal = this._axis_vector(normal_axis);
      const point = this._intersect_plane(raycaster, origin, normal);
      if (!point) {
        return null;
      }
      const offset = point.sub(drag.start);
      /* 平面拖拽：去掉法向分量。 */
      offset.addScaledVector(normal, -offset.dot(normal));
      delta.translate.copy(offset);
    } else if (drag.handle.type === 'uniform') {
      const axis = this._axis_vector(drag.handle.axis);
      const point = this._closest_on_axis(raycaster, origin, axis);
      if (!point) {
        return null;
      }
      const amount = point.clone().sub(drag.start).dot(axis);
      delta.scale.setScalar(Math.max(0.05, 1 + amount / (SHAFT_LENGTH * 1.6)));
    } else if (drag.handle.type === 'rotate') {
      const normal = this._axis_vector(drag.handle.axis);
      const point = this._intersect_plane(raycaster, origin, normal);
      if (!point) {
        return null;
      }
      const angle = this._angle_on_plane(origin, normal, point);
      let difference = angle - drag.start_angle;
      while (difference > Math.PI) {
        difference -= Math.PI * 2;
      }
      while (difference < -Math.PI) {
        difference += Math.PI * 2;
      }
      delta.rotate.setComponent(drag.handle.axis, difference);
    } else {
      return null;
    }
    drag.last_delta = delta;
    this.on_drag?.(delta);

    return delta;
  }

  /**
   * 结束拖拽并提交。
   *
   * @returns {GizmoDelta | null} 本次拖拽的最终增量。
   */
  end(): GizmoDelta | null {
    const drag = this.drag;
    this.drag = null;
    if (!drag) {
      return null;
    }
    this.on_commit?.(drag.last_delta);

    return drag.last_delta;
  }

  /**
   * 释放几何与材质。
   *
   * @returns {void}
   */
  dispose(): void {
    this.group.traverse((object) => {
      const mesh = object as THREE.Mesh;
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
    this.handle_index.clear();
  }

  /**
   * 空增量。
   *
   * @returns {GizmoDelta} 增量。
   * @private
   */
  private _empty_delta(): GizmoDelta {
    return {
      translate: new THREE.Vector3(),
      rotate: new THREE.Vector3(),
      scale: new THREE.Vector3(1, 1, 1)
    };
  }

  /**
   * 轴向量。
   *
   * @param {number} axis 轴序号。
   * @returns {THREE.Vector3} 单位向量。
   * @private
   */
  private _axis_vector(axis: number): THREE.Vector3 {
    const vector = new THREE.Vector3();
    vector.setComponent(Math.max(0, Math.min(2, axis)), 1);

    return vector;
  }

  /**
   * 射线与"过 origin 沿 axis 的直线"的最近点。
   *
   * @param {THREE.Raycaster} raycaster 射线。
   * @param {THREE.Vector3} origin 直线起点。
   * @param {THREE.Vector3} axis 直线方向。
   * @returns {THREE.Vector3 | null} 最近点。
   * @private
   */
  private _closest_on_axis(
    raycaster: THREE.Raycaster,
    origin: THREE.Vector3,
    axis: THREE.Vector3
  ): THREE.Vector3 | null {
    const ray = raycaster.ray;
    const direction = axis.clone().normalize();
    const w0 = new THREE.Vector3().subVectors(origin, ray.origin);
    const a = direction.dot(direction);
    const b = direction.dot(ray.direction);
    const c = ray.direction.dot(ray.direction);
    const d = direction.dot(w0);
    const e = ray.direction.dot(w0);
    const denominator = a * c - b * b;
    if (Math.abs(denominator) < 1e-8) {
      return null;
    }
    const t = (b * e - c * d) / denominator;

    return origin.clone().addScaledVector(direction, t);
  }

  /**
   * 射线与平面求交。
   *
   * @param {THREE.Raycaster} raycaster 射线。
   * @param {THREE.Vector3} origin 平面上一点。
   * @param {THREE.Vector3} normal 平面法向。
   * @returns {THREE.Vector3 | null} 交点。
   * @private
   */
  private _intersect_plane(
    raycaster: THREE.Raycaster,
    origin: THREE.Vector3,
    normal: THREE.Vector3
  ): THREE.Vector3 | null {
    const unit_normal = normal.clone().normalize();
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(unit_normal, origin);
    const point = new THREE.Vector3();

    return raycaster.ray.intersectPlane(plane, point) ? point : null;
  }

  /**
   * 平面内角度（用于旋转）。
   *
   * @param {THREE.Vector3} origin 圆心。
   * @param {THREE.Vector3} normal 平面法向。
   * @param {THREE.Vector3} point 平面上的点。
   * @returns {number} 弧度角。
   * @private
   */
  private _angle_on_plane(
    origin: THREE.Vector3,
    normal: THREE.Vector3,
    point: THREE.Vector3
  ): number {
    const z_axis = new THREE.Vector3(0, 0, 1);
    const x_axis = new THREE.Vector3(1, 0, 0);
    const reference = Math.abs(normal.z) < 0.9 ? z_axis : x_axis;
    const u = new THREE.Vector3().crossVectors(normal, reference).normalize();
    const v = new THREE.Vector3().crossVectors(normal, u).normalize();
    const offset = point.clone().sub(origin);

    return Math.atan2(offset.dot(v), offset.dot(u));
  }

  /**
   * 注册手柄语义。
   *
   * @param {THREE.Object3D} object 对象。
   * @param {GizmoHandle} handle 语义。
   * @returns {void}
   * @private
   */
  private _register(object: THREE.Object3D, handle: GizmoHandle): void {
    object.userData.gizmo_handle = handle;
    this.handle_index.set(object, handle);
  }

  /**
   * 构造平移手柄。
   *
   * @returns {void}
   * @private
   */
  private _build_translate(): void {
    for (let axis = 0; axis < 3; axis += 1) {
      const color = AXIS_COLORS[axis];
      const material = axis_material(color);
      const shaft = new THREE.Mesh(
        new THREE.CylinderGeometry(SHAFT_RADIUS, SHAFT_RADIUS, SHAFT_LENGTH, 10),
        material
      );
      const head = new THREE.Mesh(new THREE.ConeGeometry(HEAD_RADIUS, HEAD_LENGTH, 14), material);
      const direction = this._axis_vector(axis);
      const up_axis = new THREE.Vector3(0, 1, 0);
      const quaternion = new THREE.Quaternion().setFromUnitVectors(up_axis, direction);
      shaft.quaternion.copy(quaternion);
      shaft.position.copy(direction).multiplyScalar(SHAFT_LENGTH / 2);
      head.quaternion.copy(quaternion);
      head.position.copy(direction).multiplyScalar(SHAFT_LENGTH + HEAD_LENGTH / 2);
      this._register(shaft, { type: 'axis', axis: axis });
      this._register(head, { type: 'axis', axis: axis });
      this.translate_group.add(shaft, head);

      /* 平面块：法向为另外两轴之一，用于双轴拖动。 */
      const normal_axis = (axis + 1) % 3;
      const plane_mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(PLANE_SIZE, PLANE_SIZE),
        axis_material(color, 0.45)
      );
      plane_mesh.lookAt(this._axis_vector(normal_axis));
      const offset = this._axis_vector(axis).add(this._axis_vector((axis + 2) % 3));
      plane_mesh.position.copy(offset).multiplyScalar(PLANE_SIZE * 0.9);
      this._register(plane_mesh, { type: 'plane', axis: axis, normal_axis: normal_axis });
      this.translate_group.add(plane_mesh);
    }
  }

  /**
   * 构造旋转手柄（三轴圆环 + 刻度）。
   *
   * @returns {void}
   * @private
   */
  private _build_rotate(): void {
    for (let axis = 0; axis < 3; axis += 1) {
      const material = axis_material(AXIS_COLORS[axis]);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(RING_RADIUS, RING_TUBE, 8, 64), material);
      const normal = this._axis_vector(axis);
      ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
      this._register(ring, { type: 'rotate', axis: axis });

      /* 命中圈不参与绘制，但覆盖可见圆环周围约 17px 的区域，方便鼠标拖动。 */
      const pick_material = new THREE.MeshBasicMaterial({
        colorWrite: false,
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0
      });
      const pick_ring = new THREE.Mesh(
        new THREE.TorusGeometry(RING_RADIUS, ROTATE_PICK_TUBE, 8, 64),
        pick_material
      );
      pick_ring.quaternion.copy(ring.quaternion);
      pick_ring.name = `rotate_pick_ring_${axis}`;
      this._register(pick_ring, { type: 'rotate', axis: axis });
      this.rotate_group.add(pick_ring, ring);
    }
  }

  /**
   * 构造缩放手柄（轴向方块 + 中心均匀缩放）。
   *
   * @returns {void}
   * @private
   */
  private _build_scale(): void {
    for (let axis = 0; axis < 3; axis += 1) {
      const color = AXIS_COLORS[axis];
      const material = axis_material(color);
      const direction = this._axis_vector(axis);
      const up_axis = new THREE.Vector3(0, 1, 0);
      const quaternion = new THREE.Quaternion().setFromUnitVectors(up_axis, direction);
      const shaft = new THREE.Mesh(
        new THREE.CylinderGeometry(RING_TUBE, RING_TUBE, SHAFT_LENGTH, 8),
        material
      );
      shaft.quaternion.copy(quaternion);
      shaft.position.copy(direction).multiplyScalar(SHAFT_LENGTH / 2);
      const box = new THREE.Mesh(new THREE.BoxGeometry(SCALE_BOX, SCALE_BOX, SCALE_BOX), material);
      box.position.copy(direction).multiplyScalar(SHAFT_LENGTH);
      this._register(shaft, { type: 'axis', axis: axis });
      this._register(box, { type: 'axis', axis: axis });
      this.scale_group.add(shaft, box);
    }
    const center = new THREE.Mesh(
      new THREE.BoxGeometry(SCALE_BOX * 1.2, SCALE_BOX * 1.2, SCALE_BOX * 1.2),
      axis_material(0xf0f4f8)
    );
    this._register(center, { type: 'uniform', axis: 1 });
    this.scale_group.add(center);
  }
}
