/**
 * @File : web/src/editor/assembly_scene.ts
 * @Time : 2026-10-06 18:20
 * @Author : Cetrp
 * @Description : 设备工坊三维工作台：在独立场景里装配/编辑设备模板（部件可视化、选中高亮、
 *               爆炸查看、机架参考面），装配结果由模板装配器实时重建。
 */

import * as THREE from 'three';

import { assemble_device } from '../devices/assembler';
import { TransformGizmo } from './transform_gizmo';

import type { AssembledDevice } from '../devices/assembler';
import type { DeviceTemplate, PartSpec } from '../devices/template_types';
import type { GizmoDelta, GizmoHandle, GizmoMode } from './transform_gizmo';

/** 部件变换（工坊编辑结果，位置单位米、旋转单位弧度）。 */
export interface PartTransform {
  /** 位置（米，相对设备原点）。 */
  position: [number, number, number];
  /** 旋转（弧度）。 */
  rotation: [number, number, number];
  /** 缩放（倍数）。 */
  scale: [number, number, number];
}

/** 工作台回调。 */
export interface AssemblySceneCallbacks {
  /** 选中的部件变化。 */
  on_part_selected?: (part_id: string | null) => void;

  /** 部件变换提交（拖拽结束时触发一次，用于入历史栈）。 */
  on_transform_commit?: (part_id: string, transform: PartTransform) => void;
}

/**
 * 工坊三维工作台。
 */
export class AssemblyScene {
  /** 容器元素。 */
  private container: HTMLElement;

  /** 渲染器。 */
  private renderer: THREE.WebGLRenderer;

  /** 场景。 */
  private scene: THREE.Scene;

  /** 相机。 */
  private camera: THREE.PerspectiveCamera;

  /** 设备根组。 */
  private device_root: THREE.Group;

  /** 机架参考面。 */
  private reference_plate: THREE.Mesh;

  /** 网格辅助线。 */
  private grid_helper: THREE.GridHelper | null = null;

  /** 当前装配结果。 */
  private assembled: AssembledDevice | null = null;

  /** 选中高亮框。 */
  private selection_box: THREE.Box3Helper;

  /** 当前选中部件 ID。 */
  private selected_part_id: string | null = null;

  /** 回调。 */
  private callbacks: AssemblySceneCallbacks;

  /** 相机参数（球坐标）。 */
  private orbit = { theta: 0.9, phi: 1.15, radius: 1.2, target: new THREE.Vector3(0, 0, 0) };

  /** 变换 Gizmo。 */
  private gizmo = new TransformGizmo();

  /** 是否正在拖拽 Gizmo。 */
  private gizmo_dragging = false;

  /** Gizmo 拖拽中的原始状态（用于实时预览与提交）。 */
  private gizmo_drag: {
    part_id: string;
    object: THREE.Object3D;
    base_position: THREE.Vector3;
    base_rotation: THREE.Vector3;
    base_scale: THREE.Vector3;
    spec_position: THREE.Vector3;
    spec_rotation: THREE.Vector3;
    spec_scale: THREE.Vector3;
  } | null = null;

  /** 吸附步长（米，0 表示关闭）。 */
  private snap_step = 0.001;

  /** 交互状态。 */
  private dragging = false;
  private last_pointer = { x: 0, y: 0 };

  /** 动画句柄。 */
  private frame_handle = 0;

  /** 射线拾取。 */
  private raycaster = new THREE.Raycaster();

  /** 是否自动旋转。 */
  private auto_rotate = false;

  /**
   * 构造工作台。
   *
   * @param {HTMLElement} container 容器元素。
   * @param {AssemblySceneCallbacks} callbacks 回调。
   */
  constructor(container: HTMLElement, callbacks: AssemblySceneCallbacks = {}) {
    this.container = container;
    this.callbacks = callbacks;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(container.clientWidth, container.clientHeight, false);
    this.renderer.shadowMap.enabled = true;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.95;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = null;
    this.camera = new THREE.PerspectiveCamera(
      42,
      Math.max(1, container.clientWidth) / Math.max(1, container.clientHeight),
      0.001,
      60
    );
    /* 灯光：主光 + 补光 + 环境，保证金属拉丝质感可见。 */
    const key_light = new THREE.DirectionalLight(0xffffff, 1.5);
    key_light.position.set(1.6, 2.4, 2.2);
    key_light.castShadow = true;
    this.scene.add(key_light);
    const fill_light = new THREE.DirectionalLight(0x8fc4ff, 0.7);
    fill_light.position.set(-2.2, 1.2, -1.6);
    this.scene.add(fill_light);
    this.scene.add(new THREE.HemisphereLight(0x9fd7ff, 0x0b1117, 0.75));

    this.device_root = new THREE.Group();
    this.scene.add(this.device_root);

    /* 参考面：1U=44.45mm 网格，便于对齐部件。 */
    this.reference_plate = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1, 1, 1),
      new THREE.MeshStandardMaterial({
        color: 0x1b2430,
        metalness: 0.2,
        roughness: 0.9,
        transparent: true,
        opacity: 0.65,
        side: THREE.DoubleSide
      })
    );
    this.reference_plate.rotation.x = -Math.PI / 2;
    this.reference_plate.receiveShadow = true;
    this.scene.add(this.reference_plate);
    const grid = new THREE.GridHelper(1, 10, 0x2f4256, 0x1d2a38);
    this.scene.add(grid);

    this.selection_box = new THREE.Box3Helper(new THREE.Box3(), new THREE.Color(0x37e0c9));
    this.selection_box.visible = false;
    this.scene.add(this.selection_box);

    /* 变换 Gizmo：点住手柄拖动 → 实时预览，松手提交一次编辑。 */
    this.scene.add(this.gizmo.group);
    this.gizmo.on_drag = (delta) => {
      this._apply_gizmo_delta(delta, false);
    };
    this.gizmo.on_commit = (delta) => {
      this._apply_gizmo_delta(delta, true);
    };

    this.grid_helper = grid;

    this._bind_events();
    this._start();
  }

  /**
   * 设置 Gizmo 模式。
   *
   * @param {GizmoMode} mode 模式（translate / rotate / scale / none）。
   * @returns {void}
   */
  set_gizmo_mode(mode: GizmoMode): void {
    this.gizmo.set_mode(mode);
    this._sync_gizmo();
  }

  /**
   * 设置吸附步长。
   *
   * @param {number} step_m 步长（米，0 表示关闭吸附）。
   * @returns {void}
   */
  set_snap_step(step_m: number): void {
    this.snap_step = Math.max(0, step_m);
  }

  /**
   * 设置显示模式。
   *
   * @param {'shaded' | 'wireframe' | 'edged'} mode 显示模式。
   * @returns {void}
   */
  set_display_mode(mode: 'shaded' | 'wireframe' | 'edged'): void {
    const wireframe = mode === 'wireframe';
    const show_edges = mode === 'edged';
    this.scene.traverse((object) => {
      if ((object as THREE.LineSegments).isLineSegments) {
        object.visible = show_edges && object.userData.part_edges === true;
        return;
      }
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) {
        return;
      }
      const material = mesh.material as THREE.MeshStandardMaterial | undefined;
      if (material && 'wireframe' in material) {
        material.wireframe = wireframe;
      }
    });
  }

  /**
   * 显示/隐藏参考网格与地面。
   *
   * @param {boolean} visible 是否显示。
   * @returns {void}
   */
  set_grid_visible(visible: boolean): void {
    if (this.grid_helper) {
      this.grid_helper.visible = visible;
    }
    this.reference_plate.visible = visible;
  }

  /**
   * 载入并装配模板。
   *
   * @param {DeviceTemplate} template 设备模板。
   * @returns {void}
   */
  load_template(template: DeviceTemplate, options: { preserve_selection?: boolean } = {}): void {
    const previous_selection = this.selected_part_id;
    if (this.assembled) {
      this.device_root.remove(this.assembled.group);
      this._dispose_object(this.assembled.group);
    }
    const assembled = assemble_device(template, { include_internal: true });
    this.assembled = assembled;
    this.device_root.add(assembled.group);
    /* 参考面尺寸贴合设备投影；机架式设备给出 19 英寸安装宽度。 */
    const width = template.rack_mountable ? 0.4826 : Math.max(0.2, template.dimensions.width * 1.8);
    const depth = Math.max(0.2, template.dimensions.depth * 1.6);
    this.reference_plate.geometry.dispose();
    this.reference_plate.geometry = new THREE.PlaneGeometry(width, depth);
    this.reference_plate.position.y = -template.dimensions.height / 2 - 0.002;
    this.orbit.radius = Math.max(0.5, template.dimensions.width * 2.6);
    this.orbit.target.set(0, 0, 0);
    /* 保留选中：编辑参数会频繁重建几何，不能因此清空右侧参数表单。 */
    if (options.preserve_selection && previous_selection) {
      const still_exists = this.assembled
        ? this.assembled.removable_parts.some((item) => item.part_id === previous_selection)
        : false;
      this._apply_selection(still_exists ? previous_selection : null);
      return;
    }
    this.select_part(null);
  }

  /**
   * 选中部件（显示高亮框）。
   *
   * @param {string | null} part_id 部件 ID。
   * @returns {void}
   */
  select_part(part_id: string | null): void {
    this._apply_selection(part_id);
    this.callbacks.on_part_selected?.(part_id);
  }

  /**
   * 内部设置选中态（不回调），用于几何重建后恢复选中。
   *
   * @param {string | null} part_id 部件 ID。
   * @returns {void}
   * @private
   */
  private _apply_selection(part_id: string | null): void {
    this.selected_part_id = part_id;
    if (!this.assembled || !part_id) {
      this.selection_box.visible = false;
      return;
    }
    const entry = this.assembled.removable_parts.find((item) => item.part_id === part_id);
    if (!entry) {
      this.selection_box.visible = false;
      this.selected_part_id = null;
      return;
    }
    const box = new THREE.Box3().setFromObject(entry.object);
    this.selection_box.box.copy(box);
    this.selection_box.visible = true;
  }

  /**
   * 高亮指定部件（工坊里悬停部件列表时预览）。
   *
   * @param {string | null} part_id 部件 ID。
   * @returns {void}
   */
  highlight_part(part_id: string | null): void {
    if (!this.assembled) {
      return;
    }
    for (const entry of this.assembled.removable_parts) {
      entry.object.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (!mesh.isMesh) {
          return;
        }
        const material = mesh.material as THREE.MeshStandardMaterial;
        if (!material || !material.isMeshStandardMaterial) {
          return;
        }
        if (entry.part_id === part_id) {
          material.emissive = new THREE.Color(0x1d5f57);
          material.emissiveIntensity = 0.8;
        } else {
          material.emissiveIntensity = 0;
        }
      });
    }
  }

  /**
   * 设置爆炸间距（0 表示合拢）。
   *
   * @param {number} amount 爆炸系数（0–1）。
   * @returns {void}
   */
  set_explode(amount: number): void {
    if (!this.assembled) {
      return;
    }
    const index_map = new Map<string, number>();
    this.assembled.removable_parts.forEach((entry, index) => {
      index_map.set(entry.part_id, index);
    });
    const total = Math.max(1, this.assembled.removable_parts.length - 1);
    for (const entry of this.assembled.removable_parts) {
      const index = index_map.get(entry.part_id) || 0;
      const offset = (index / total - 0.5) * amount * 0.24;
      entry.object.position.y =
        (entry.object.userData.base_y === undefined
          ? entry.object.position.y
          : (entry.object.userData.base_y as number)) + offset;
      if (entry.object.userData.base_y === undefined) {
        entry.object.userData.base_y = entry.object.position.y - offset;
      }
    }
  }

  /**
   * 设置自动旋转。
   *
   * @param {boolean} enabled 是否旋转。
   * @returns {void}
   */
  set_auto_rotate(enabled: boolean): void {
    this.auto_rotate = enabled;
  }

  /**
   * 重新适配画布尺寸。
   *
   * @returns {void}
   */
  resize(): void {
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  /**
   * 释放资源。
   *
   * @returns {void}
   */
  dispose(): void {
    cancelAnimationFrame(this.frame_handle);
    this.renderer.domElement.removeEventListener('pointerdown', this._on_pointer_down);
    window.removeEventListener('pointermove', this._on_pointer_move);
    window.removeEventListener('pointerup', this._on_pointer_up);
    this.renderer.domElement.removeEventListener('wheel', this._on_wheel);
    this.renderer.domElement.removeEventListener('dblclick', this._on_double_click);
    if (this.assembled) {
      this._dispose_object(this.assembled.group);
    }
    this.renderer.dispose();
    if (this.renderer.domElement.parentElement === this.container) {
      this.container.removeChild(this.renderer.domElement);
    }
  }

  /**
   * 当前选中部件。
   *
   * @returns {string | null} 部件 ID。
   */
  get selected(): string | null {
    return this.selected_part_id;
  }

  /**
   * 绑定鼠标交互（旋转 / 缩放 / 选中）。
   *
   * @returns {void}
   * @private
   */
  private _bind_events(): void {
    const element = this.renderer.domElement;
    element.addEventListener('pointerdown', this._on_pointer_down);
    window.addEventListener('pointermove', this._on_pointer_move);
    window.addEventListener('pointerup', this._on_pointer_up);
    element.addEventListener('wheel', this._on_wheel, { passive: false });
    element.addEventListener('dblclick', this._on_double_click);
    /* 右键按下也允许旋转（工坊里右键菜单留给主场景）。 */
    element.addEventListener('contextmenu', (event) => event.preventDefault());
  }

  /** 指针按下：优先抓住 Gizmo 手柄。 */
  private _on_pointer_down = (event: PointerEvent): void => {
    this.last_pointer = { x: event.clientX, y: event.clientY };
    if (this._raycaster_from(event, this.raycaster)) {
      const hit = this.gizmo.pick(this.raycaster);
      const handle = hit ? this.gizmo.handle_of(hit.object) : null;
      if (handle && this._begin_gizmo_drag(handle)) {
        this.gizmo_dragging = true;
        return;
      }
    }
    this.dragging = true;
  };

  /** 指针移动：Gizmo 拖拽优先，否则旋转视角。 */
  private _on_pointer_move = (event: PointerEvent): void => {
    if (this.gizmo_dragging) {
      if (this._raycaster_from(event, this.raycaster)) {
        this.gizmo.move(this.raycaster);
      }
      return;
    }
    if (!this.dragging) {
      return;
    }
    const dx = event.clientX - this.last_pointer.x;
    const dy = event.clientY - this.last_pointer.y;
    this.last_pointer = { x: event.clientX, y: event.clientY };
    this.orbit.theta -= dx * 0.008;
    this.orbit.phi = THREE.MathUtils.clamp(this.orbit.phi - dy * 0.006, 0.12, Math.PI - 0.12);
  };

  /** 指针抬起：提交 Gizmo 编辑或点选部件。 */
  private _on_pointer_up = (event: PointerEvent): void => {
    if (this.gizmo_dragging) {
      this.gizmo_dragging = false;
      this.gizmo.end();
      return;
    }
    if (!this.dragging) {
      return;
    }
    this.dragging = false;
    const moved =
      Math.abs(event.clientX - this.last_pointer.x) + Math.abs(event.clientY - this.last_pointer.y);
    if (moved > 6 || !this.assembled) {
      return;
    }
    const rect = this.renderer.domElement.getBoundingClientRect();
    const pointer = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1
    );
    this.raycaster.setFromCamera(pointer, this.camera);
    const hits = this.raycaster.intersectObject(this.assembled.group, true);
    if (hits.length === 0) {
      this.select_part(null);
      return;
    }
    /* 从命中网格向上找到所属部件。 */
    let node: THREE.Object3D | null = hits[0].object;
    while (node && !node.userData.part_spec) {
      node = node.parent;
    }
    const spec = node && node.userData.part_spec ? (node.userData.part_spec as PartSpec) : null;
    this.select_part(spec ? spec.part_id : null);
  };

  /**
   * 由指针事件构造射线。
   *
   * @param {PointerEvent} event 指针事件。
   * @param {THREE.Raycaster} raycaster 复用对象。
   * @returns {boolean} 是否成功。
   * @private
   */
  private _raycaster_from(event: PointerEvent, raycaster: THREE.Raycaster): boolean {
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return false;
    }
    const pointer = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1
    );
    raycaster.setFromCamera(pointer, this.camera);

    return true;
  }

  /**
   * 开始 Gizmo 拖拽：记录部件当前变换与模板变换基准。
   *
   * @param {GizmoHandle} handle 手柄。
   * @returns {boolean} 是否开始成功。
   * @private
   */
  private _begin_gizmo_drag(handle: GizmoHandle): boolean {
    if (!this.selected_part_id || !this.assembled) {
      return false;
    }
    const entry = this.assembled.removable_parts.find(
      (item) => item.part_id === this.selected_part_id
    );
    if (!entry) {
      return false;
    }
    const spec = entry.spec;
    const transform = spec.transform || {};
    const spec_position = new THREE.Vector3(...(transform.position || [0, 0, 0]));
    const spec_rotation = new THREE.Vector3(...(transform.rotation || [0, 0, 0]));
    const scale = transform.scale || [1, 1, 1];
    const spec_scale = new THREE.Vector3(
      scale[0] === undefined ? 1 : scale[0],
      scale[1] === undefined ? 1 : scale[1],
      scale[2] === undefined ? 1 : scale[2]
    );
    this.gizmo_drag = {
      part_id: spec.part_id,
      object: entry.object,
      base_position: entry.object.position.clone(),
      base_rotation: new THREE.Vector3(
        entry.object.rotation.x,
        entry.object.rotation.y,
        entry.object.rotation.z
      ),
      base_scale: entry.object.scale.clone(),
      spec_position: spec_position,
      spec_rotation: spec_rotation,
      spec_scale: spec_scale
    };

    return this.gizmo.begin(handle, this.raycaster);
  }

  /** 滚轮缩放。 */
  private _on_wheel = (event: WheelEvent): void => {
    event.preventDefault();
    this.orbit.radius = THREE.MathUtils.clamp(
      this.orbit.radius * (1 + Math.sign(event.deltaY) * 0.08),
      0.2,
      6
    );
  };

  /** 双击复位视角。 */
  private _on_double_click = (): void => {
    this.orbit.theta = 0.9;
    this.orbit.phi = 1.15;
  };

  /**
   * 启动渲染循环。
   *
   * @returns {void}
   * @private
   */
  private _start(): void {
    const render = (): void => {
      this.frame_handle = requestAnimationFrame(render);
      if (this.auto_rotate) {
        this.orbit.theta += 0.0035;
      }
      const position = new THREE.Vector3(
        this.orbit.radius * Math.sin(this.orbit.phi) * Math.sin(this.orbit.theta),
        this.orbit.radius * Math.cos(this.orbit.phi),
        this.orbit.radius * Math.sin(this.orbit.phi) * Math.cos(this.orbit.theta)
      );
      this.camera.position.copy(this.orbit.target).add(position);
      this.camera.lookAt(this.orbit.target);
      if (this.selection_box.visible && this.selected_part_id && this.assembled) {
        const entry = this.assembled.removable_parts.find(
          (item) => item.part_id === this.selected_part_id
        );
        if (entry) {
          this.selection_box.box.setFromObject(entry.object);
        }
      }
      this._sync_gizmo();
      this.renderer.render(this.scene, this.camera);
    };
    render();
  }

  /**
   * 同步 Gizmo：跟随选中部件，无选中或拖拽中则隐藏。
   *
   * @returns {void}
   * @private
   */
  private _sync_gizmo(): void {
    if (!this.selected_part_id || !this.assembled || this.gizmo.mode === 'none') {
      this.gizmo.group.visible = false;
      return;
    }
    const entry = this.assembled.removable_parts.find(
      (item) => item.part_id === this.selected_part_id
    );
    if (!entry) {
      this.gizmo.group.visible = false;
      return;
    }
    this.gizmo.group.visible = true;
    const box = new THREE.Box3().setFromObject(entry.object);
    const center = box.getCenter(new THREE.Vector3());
    this.gizmo.place(center, this.camera);
  }

  /**
   * 应用 Gizmo 增量：实时预览（commit=false）或提交（commit=true）。
   *
   * @param {GizmoDelta} delta 增量。
   * @param {boolean} commit 是否提交。
   * @returns {void}
   * @private
   */
  private _apply_gizmo_delta(delta: GizmoDelta, commit: boolean): void {
    const drag = this.gizmo_drag;
    if (!drag) {
      return;
    }
    const parent = drag.object.parent;
    const parent_quaternion = parent
      ? parent.getWorldQuaternion(new THREE.Quaternion()).invert()
      : new THREE.Quaternion();
    const local_translate = delta.translate.clone().applyQuaternion(parent_quaternion);
    const object = drag.object;
    object.position.copy(drag.base_position).add(local_translate);
    object.rotation.set(
      drag.base_rotation.x + delta.rotate.x,
      drag.base_rotation.y + delta.rotate.y,
      drag.base_rotation.z + delta.rotate.z
    );
    object.scale.set(
      drag.base_scale.x * delta.scale.x,
      drag.base_scale.y * delta.scale.y,
      drag.base_scale.z * delta.scale.z
    );
    if (!commit) {
      return;
    }
    /* 提交模板绝对变换；旋转与 Three.js、模板定义统一使用弧度。 */
    const step = this.snap_step;
    const snap = (value: number): number => (step > 0 ? Math.round(value / step) * step : value);
    const position: [number, number, number] = [
      snap(drag.spec_position.x + local_translate.x),
      snap(drag.spec_position.y + local_translate.y),
      snap(drag.spec_position.z + local_translate.z)
    ];
    const rotation: [number, number, number] = [
      drag.spec_rotation.x + delta.rotate.x,
      drag.spec_rotation.y + delta.rotate.y,
      drag.spec_rotation.z + delta.rotate.z
    ];
    const scale: [number, number, number] = [
      drag.spec_scale.x * delta.scale.x,
      drag.spec_scale.y * delta.scale.y,
      drag.spec_scale.z * delta.scale.z
    ];
    this.gizmo_drag = null;
    this.callbacks.on_transform_commit?.(drag.part_id, { position, rotation, scale });
  }

  /**
   * 释放对象树中的几何与材质。
   *
   * @param {THREE.Object3D} object 对象。
   * @returns {void}
   * @private
   */
  private _dispose_object(object: THREE.Object3D): void {
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
}
