/**
 * @File : web/src/scene/scene_manager.ts
 * @Time : 2026-10-05 08:40
 * @Author : Cetrp
 * @Description : 多设备三维场景管理器：机柜/设备摆放、视图控制、端口拾取、设备拖动、连线交互、
 *               设备间线缆、转发动画与无线效果的统一驱动（React 只负责面板，三维由本类管理）。
 */

import * as THREE from 'three';

import { utils, DEVICE_STATE } from '../core/constants';
import { DeviceObject } from './device_builder';
import { LinkLayer, port_world_position } from './link_layer';
import { WirelessLayer } from './wireless_layer';
import { CableLayer, default_kind_for_connector } from '../cables/cable_layer';
import { layer_records_from_cables } from '../cables/cable_layer';
import { get_registry } from '../data/assets';
import { pointer_facing_plane_point, pointer_plane_point } from './pointer_plane';
import { use_store } from '../core/store';
import {
  DEFAULT_RENDER_SETTINGS,
  normalize_render_settings,
  resolve_render_profile
} from '../core/render_settings';
import { template_cache_key } from '../devices/registry';

import type { CableObject } from '../cables/cable_object';
import type { CableRecord, PortState, WirelessSnapshot } from '../data/types';
import type { OpticalSnapshot } from '../core/optical_model';
import type { DeviceRuntime } from '../core/device_runtime';
import type { DisplayMode, ViewPreset } from '../core/store';
import type { RenderProfile, RenderSettings } from '../core/render_settings';

/** 视角预设。 */
const VIEW_PRESETS: Record<ViewPreset, { theta: number; phi: number; radius: number }> = {
  front: { theta: 0, phi: 1.5, radius: 22 },
  iso: { theta: 0.66, phi: 1.05, radius: 24 },
  top: { theta: 0, phi: 0.22, radius: 26 },
  back: { theta: Math.PI, phi: 1.45, radius: 22 },
  close: { theta: 0.35, phi: 1.3, radius: 9 }
};

/** 场景回调。 */
export interface SceneCallbacks {
  on_port_click: (device_id: string, port: PortState) => void;
  on_power_click: (device_id: string) => void;
  on_background_click: () => void;

  /** 点击机身：选中设备（在 3D 平台里直接选择设备）。 */
  on_device_select?: (device_id: string) => void;

  /** 点击 PC 显示器：打开交互式 VNC 大画面。 */
  on_screen_click?: (device_id: string) => void;

  /** 右键菜单：命中设备 / 端口 / 线缆 / 空白。 */
  on_context_menu?: (target: {
    kind: 'device' | 'port' | 'cable' | 'background';
    device_id?: string;
    port?: string;
    cable_id?: string;
    client_x: number;
    client_y: number;
  }) => void;

  /** 世界坐标（地面）上的拖放：从设备栏/线缆栏拖入（含屏幕坐标，供端口命中判定）。 */
  on_drop?: (payload: {
    type: string;
    value: string;
    x: number;
    z: number;
    client_x: number;
    client_y: number;
    hit_port: { device_id: string; port: string } | null;
  }) => void;
  on_device_move: (device_id: string, position: { x: number; y: number; z: number }) => void;

  /** 点击线缆标签：请求编辑文本。 */
  on_label_click?: (cable_id: string, side: 'from' | 'to', current_text: string) => void;

  /** 拖动线缆端点改插到新端口（side: from / to）。 */
  on_cable_replug?: (
    cable_id: string,
    side: 'from' | 'to',
    device_id: string,
    port: string
  ) => void;
  on_hover: (info: { device_id: string; port: string; label: string } | null) => void;
}

/** 场景同步参数。 */
export interface SceneSyncOptions {
  /** 用户拉动过的线缆走线控制点。 */
  cable_waypoints?: Record<string, [number, number, number][]>;

  /** 用户自定义线缆标签。 */
  cable_labels?: Record<string, { from: string; to: string }>;
  devices: DeviceRuntime[];
  cables: CableRecord[];
  selected_device_id: string | null;
  selected_port: string | null;
  display_mode: DisplayMode;
  flow_enabled: boolean;
  auto_rotate: boolean;
  link_source: { device_id: string; port: string } | null;
  wireless: WirelessSnapshot | null;
  optical: OpticalSnapshot | null;
  /** 已上电但尚未关联的 STA（用于显示"搜索信号"脉冲）。 */
  wireless_waiting_sta?: string[];

  /** 线缆栏选中的线缆类型（决定半截线缆与最终线缆种类）。 */
  pending_cable_kind?: string | null;
}

/** 一台三维计算设备上的 noVNC 实时纹理。 */
interface VncScreenBinding {
  surface: THREE.Mesh;
  texture: THREE.CanvasTexture;
  material: THREE.MeshBasicMaterial;
  original_material: THREE.Material | THREE.Material[];
  canvas: HTMLCanvasElement;
  updated_at: number;
}

/**
 * 轨道控制器（自实现，支持鼠标与触控）。
 */
class Orbit {
  /** 相机。 */
  camera: THREE.PerspectiveCamera;

  /** 画布。 */
  dom: HTMLCanvasElement;

  /** 目标点。 */
  target = new THREE.Vector3(0, 0, 0);

  /** 球坐标（当前）。 */
  spherical = new THREE.Spherical(24, 1.05, 0.66);

  /** 球坐标（目标）。 */
  wanted = new THREE.Spherical(24, 1.05, 0.66);

  /** 最近 / 最远距离。 */
  min_radius = 1.25;

  /** 最远距离。 */
  max_radius = 70;

  /** 自动旋转。 */
  auto_rotate = false;

  /** 指针表（场景管理器在拖拽设备时会临时接管）。 */
  pointers = new Map<number, { x: number; y: number }>();

  /** 交互模式。 */
  mode: string | null = null;

  /** 上一次指针位置。 */
  private last: { x: number; y: number } | null = null;

  /** 双指间距。 */
  private pinch_distance = 0;

  /** 双指中心。 */
  private mid_point: { x: number; y: number } | null = null;

  /** 是否正在拖动视图。 */
  dragging = false;

  /** 外部接管：为 true 时忽略所有指针事件（拖线缆/拖动设备时冻结视角）。 */
  suspended = false;

  /**
   * 挂起视角操作（清空已记录的指针，避免拖动线缆时相机跟着转）。
   *
   * @returns {void}
   */
  suspend(): void {
    this.suspended = true;
    this.pointers.clear();
    this.mode = null;
    this.last = null;
    this.mid_point = null;
    this.dragging = false;
  }

  /**
   * 恢复视角操作。
   *
   * @returns {void}
   */
  resume(): void {
    this.suspended = false;
  }

  /**
   * @param {THREE.PerspectiveCamera} camera 相机。
   * @param {HTMLCanvasElement} dom 画布。
   */
  constructor(camera: THREE.PerspectiveCamera, dom: HTMLCanvasElement) {
    this.camera = camera;
    this.dom = dom;
    dom.addEventListener('pointerdown', (event) => this._on_down(event));
    dom.addEventListener('pointermove', (event) => this._on_move(event));
    dom.addEventListener('pointerup', (event) => this._on_up(event));
    dom.addEventListener('pointercancel', (event) => this._on_up(event));
    dom.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault();
        this.wanted.radius = utils.clamp(
          this.wanted.radius * (1 + Math.sign(event.deltaY) * 0.09),
          this.min_radius,
          this.max_radius
        );
      },
      { passive: false }
    );
    dom.addEventListener('contextmenu', (event) => event.preventDefault());
  }

  /**
   * 指针按下。
   *
   * @param {PointerEvent} event 事件。
   * @returns {void}
   * @private
   */
  private _on_down(event: PointerEvent): void {
    if (this.suspended) {
      return;
    }
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (this.pointers.size === 1) {
      this.mode = event.button === 2 || event.shiftKey ? 'pan' : 'rotate';
      this.last = { x: event.clientX, y: event.clientY };
    } else if (this.pointers.size === 2) {
      this.mode = 'pinch';
      this.pinch_distance = this._distance();
      this.mid_point = this._center();
    }
  }

  /**
   * 指针移动。
   *
   * @param {PointerEvent} event 事件。
   * @returns {void}
   * @private
   */
  private _on_move(event: PointerEvent): void {
    if (this.suspended || !this.pointers.has(event.pointerId)) {
      return;
    }
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (this.mode === 'rotate' && this.last) {
      const delta_x = event.clientX - this.last.x;
      const delta_y = event.clientY - this.last.y;
      if (Math.abs(delta_x) + Math.abs(delta_y) > 2) {
        this.dragging = true;
      }
      this.wanted.theta -= delta_x * 0.0055;
      this.wanted.phi = utils.clamp(this.wanted.phi - delta_y * 0.0055, 0.1, 1.52);
      this.last = { x: event.clientX, y: event.clientY };
    } else if (this.mode === 'pan' && this.last) {
      this._pan(event.clientX - this.last.x, event.clientY - this.last.y);
      this.last = { x: event.clientX, y: event.clientY };
      this.dragging = true;
    } else if (this.mode === 'pinch' && this.pointers.size >= 2 && this.mid_point) {
      const distance = this._distance();
      const center = this._center();
      if (this.pinch_distance > 0) {
        this.wanted.radius = utils.clamp(
          this.wanted.radius * (this.pinch_distance / distance),
          this.min_radius,
          this.max_radius
        );
      }
      this._pan(center.x - this.mid_point.x, center.y - this.mid_point.y);
      this.pinch_distance = distance;
      this.mid_point = center;
    }
  }

  /**
   * 指针抬起。
   *
   * @param {PointerEvent} event 事件。
   * @returns {void}
   * @private
   */
  private _on_up(event: PointerEvent): void {
    this.pointers.delete(event.pointerId);
    if (this.pointers.size === 0) {
      this.mode = null;
      this.last = null;
      this.dragging = false;
    } else if (this.pointers.size === 1) {
      this.mode = 'rotate';
      const remaining = [...this.pointers.values()][0];
      this.last = { x: remaining.x, y: remaining.y };
    }
  }

  /**
   * 双指间距。
   *
   * @returns {number} 距离。
   * @private
   */
  private _distance(): number {
    const values = [...this.pointers.values()];
    return Math.hypot(values[0].x - values[1].x, values[0].y - values[1].y) || 1;
  }

  /**
   * 双指中心。
   *
   * @returns {{x: number; y: number}} 中心点。
   * @private
   */
  private _center(): { x: number; y: number } {
    const values = [...this.pointers.values()];
    return { x: (values[0].x + values[1].x) / 2, y: (values[0].y + values[1].y) / 2 };
  }

  /**
   * 平移目标点。
   *
   * @param {number} delta_x 横向位移。
   * @param {number} delta_y 纵向位移。
   * @returns {void}
   * @private
   */
  private _pan(delta_x: number, delta_y: number): void {
    const scale = this.wanted.radius * 0.0016;
    const right = new THREE.Vector3();
    const up = new THREE.Vector3();
    this.camera.matrixWorld.extractBasis(right, up, new THREE.Vector3());
    this.target.addScaledVector(right, -delta_x * scale).addScaledVector(up, delta_y * scale);
    this.target.x = utils.clamp(this.target.x, -20, 20);
    this.target.y = utils.clamp(this.target.y, -5, 8);
    this.target.z = utils.clamp(this.target.z, -20, 20);
  }

  /**
   * 应用视角预设。
   *
   * @param {ViewPreset} preset 预设名。
   * @returns {void}
   */
  set_view(preset: ViewPreset): void {
    const target = VIEW_PRESETS[preset] || VIEW_PRESETS.iso;
    this.wanted.theta = target.theta;
    this.wanted.phi = target.phi;
    this.wanted.radius = target.radius;
    this.target.set(0, 0, 0);
  }

  /**
   * 每帧更新。
   *
   * @returns {void}
   */
  update(): void {
    if (this.auto_rotate) {
      this.wanted.theta += 0.003;
    }
    this.spherical.theta = utils.lerp(this.spherical.theta, this.wanted.theta, 0.12);
    this.spherical.phi = utils.lerp(this.spherical.phi, this.wanted.phi, 0.12);
    this.spherical.radius = utils.lerp(this.spherical.radius, this.wanted.radius, 0.12);
    this.spherical.makeSafe();
    this.camera.position
      .copy(this.target)
      .add(new THREE.Vector3().setFromSpherical(this.spherical));
    this.camera.lookAt(this.target);
  }
}

/**
 * 多设备场景管理器。
 */
/** 抓取线缆端点的屏幕半径（像素）。 */
const ENDPOINT_PICK_RADIUS_PX = 26;

/** 可选中的线缆控制点数量（抓取点）。 */
const PULL_WAYPOINT_COUNT = 3;

/** 走线控制点的最低高度（场景单位，避免拉到地面以下）。 */
const FLOOR_MIN_Y = 0.03;

export class SceneManager {
  /** 渲染器。 */
  renderer: THREE.WebGLRenderer;

  /** 场景。 */
  scene: THREE.Scene;

  /** 相机。 */
  camera: THREE.PerspectiveCamera;

  /** 轨道控制。 */
  orbit: Orbit;

  /** 设备对象表。 */
  device_objects = new Map<string, DeviceObject>();

  /** 链路图层。 */
  link_layer = new LinkLayer();

  /** 无线图层。 */
  wireless_layer = new WirelessLayer();

  /** 已上电但尚未关联的 STA（显示"搜索信号"脉冲）。 */
  wireless_waiting_sta: string[] = [];

  /** 真高仿线缆图层：线缆从真实接口锚点长出，支持拖拽整理走线。 */
  cable_layer = new CableLayer();

  /** 正在拖拽的走线把手。 */
  waypoint_drag: { cable_id: string; index: number; y?: number } | null = null;

  /** 正在拖拽的线缆端点（改插）。 */
  endpoint_drag: { cable_id: string; side: 'from' | 'to' } | null = null;

  /** 改插候选端口（悬停高亮）。 */
  private replug_candidate: { device_id: string; port: string } | null = null;

  /** 连线预览起点。 */
  link_source_anchor: { device_id: string; port: string } | null = null;

  /** 是否正在显示半截线缆预览。 */
  preview_active = false;

  /** 回调。 */
  private callbacks: SceneCallbacks;

  /** 容器。 */
  private container: HTMLElement;

  /** 拾取目标（网格 → 设备 / 端口）。 */
  private pick_index = new Map<
    THREE.Object3D,
    { device_id: string; port: string | null; kind: string }
  >();

  /** 拖动状态。 */
  private drag: {
    device_id: string;
    pointer_id: number;
    start_x: number;
    start_y: number;
    origin: THREE.Vector3;
    /** 按下时指针在设备水平面上的落点（保持抓取偏移，实现严格跟手）。 */
    grab: THREE.Vector3;
    moved: boolean;
  } | null = null;

  /** 当前视图状态。 */
  private state: SceneSyncOptions = {
    devices: [],
    cables: [],
    selected_device_id: null,
    selected_port: null,
    display_mode: 'shell',
    flow_enabled: true,
    auto_rotate: false,
    link_source: null,
    wireless: null,
    optical: null
  };


  /** 指针按下信息。 */
  private pointer_down: { x: number; y: number; time: number } | null = null;

  /** 上一帧时间。 */
  private last_time = performance.now();

  /** 累计时间。 */
  private time_accumulator = 0;

  /** 动画帧句柄。 */
  private frame_handle = 0;

  /** 当前画质预算。 */
  private render_profile: RenderProfile = resolve_render_profile('auto');

  /** 当前画面设置。 */
  private render_settings: RenderSettings = { ...DEFAULT_RENDER_SETTINGS };

  /** 上一次真正绘制的时间，用于低配帧率上限。 */
  private last_render_time = 0;

  /** PMREM 环境贴图，低画质可临时关闭。 */
  private environment_texture: THREE.Texture | null = null;

  /** 全部可调光源。 */
  private adjustable_lights: THREE.Light[] = [];

  /** 主方向光，负责实时阴影。 */
  private key_light: THREE.DirectionalLight | null = null;

  /** 鼠标位置（用于连线预览）。 */

  /** 悬停信息缓存。 */
  private hover_key = '';

  /** 每台 PC/笔记本独立的 noVNC CanvasTexture。 */
  private vnc_screens = new Map<string, VncScreenBinding>();

  /**
   * @param {object} options 参数。
   * @param {HTMLElement} options.container 容器。
   * @param {SceneCallbacks} options.callbacks 回调。
   */
  constructor(options: { container: HTMLElement; callbacks: SceneCallbacks }) {
    this.container = options.container;
    this.callbacks = options.callbacks;
    /* 右键菜单：命中设备/端口/线缆/空白，交给 React 渲染菜单。 */
    options.container.addEventListener(
      'contextmenu',
      this._on_context_menu as unknown as EventListener
    );
    /* 从设备栏/线缆栏拖入场景（HTML5 拖放）。 */
    options.container.addEventListener('dragover', (event) => event.preventDefault());
    options.container.addEventListener('drop', this._on_drop as unknown as EventListener);

    this.renderer = new THREE.WebGLRenderer({
      antialias: this.render_profile.resolved_quality !== 'low',
      alpha: true,
      powerPreference:
        this.render_profile.resolved_quality === 'low' ? 'low-power' : 'high-performance',
      precision: this.render_profile.resolved_quality === 'low' ? 'mediump' : 'highp'
    });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.96;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 400);
    this.orbit = new Orbit(this.camera, this.renderer.domElement);

    this._setup_environment();
    this._setup_lights();
    this._setup_ground();
    this._bind_events();
    this.scene.add(this.link_layer.group);
    this.scene.add(this.wireless_layer.group);
    this.scene.add(this.cable_layer.group);
    this.set_render_settings(DEFAULT_RENDER_SETTINGS);
  }

  /**
   * 程序化环境贴图。
   *
   * @returns {void}
   * @private
   */
  private _setup_environment(): void {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 256;
    const context = canvas.getContext('2d')!;
    const gradient = context.createLinearGradient(0, 0, 0, 256);
    gradient.addColorStop(0, '#5b7fa8');
    gradient.addColorStop(0.45, '#26303c');
    gradient.addColorStop(1, '#080a0e');
    context.fillStyle = gradient;
    context.fillRect(0, 0, 512, 256);
    context.fillStyle = 'rgba(255,255,255,.9)';
    context.fillRect(40, 26, 180, 16);
    context.fillRect(300, 44, 150, 12);
    context.fillStyle = 'rgba(120,220,255,.5)';
    context.fillRect(0, 186, 512, 10);
    const texture = new THREE.CanvasTexture(canvas);
    texture.mapping = THREE.EquirectangularReflectionMapping;
    const generator = new THREE.PMREMGenerator(this.renderer);
    try {
      this.environment_texture = generator.fromEquirectangular(texture).texture;
      this.scene.environment = this.environment_texture;
    } catch (error) {
      console.warn('环境贴图生成失败', error);
    }
    texture.dispose();
    try {
      generator.dispose();
    } catch (error) {
      console.warn('PMREM 释放失败', error);
    }
  }

  /**
   * 光照。
   *
   * @returns {void}
   * @private
   */
  private _setup_lights(): void {
    /* 降低无方向环境光，保留接口凹槽与钣金折边的明暗关系。 */
    const ambient = new THREE.AmbientLight(0xffffff, 0.16);
    const hemisphere = new THREE.HemisphereLight(0xa8c8ef, 0x080b10, 0.46);
    this.scene.add(ambient);
    this.scene.add(hemisphere);
    const key = new THREE.DirectionalLight(0xfff7e8, 2.8);
    key.position.set(12, 18, 14);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.left = -22;
    key.shadow.camera.right = 22;
    key.shadow.camera.top = 22;
    key.shadow.camera.bottom = -22;
    key.shadow.camera.near = 0.5;
    key.shadow.camera.far = 60;
    key.shadow.bias = -0.00065;
    key.shadow.normalBias = 0.035;
    this.scene.add(key);
    this.key_light = key;
    const fill = new THREE.DirectionalLight(0x7aaeff, 0.9);
    fill.position.set(-14, 8, -10);
    this.scene.add(fill);
    const rim = new THREE.PointLight(0x37e0c9, 10, 34, 2);
    rim.position.set(0, 4, 12);
    this.scene.add(rim);

    /* 两块摄影棚柔光板只提供宽阔高光，用于读出喷涂钢板与塑料外壳的材质差异。 */
    const front_softbox = new THREE.RectAreaLight(0xdbeaff, 5.2, 12, 6);
    front_softbox.position.set(-4, 9, 12);
    front_softbox.lookAt(0, 0, 0);
    this.scene.add(front_softbox);
    const side_softbox = new THREE.RectAreaLight(0xffe7c2, 3.4, 8, 5);
    side_softbox.position.set(13, 5, -5);
    side_softbox.lookAt(0, 0, 0);
    this.scene.add(side_softbox);
    const rear_softbox = new THREE.RectAreaLight(0xb7d2f4, 2.6, 10, 4);
    rear_softbox.position.set(-7, 6, -13);
    rear_softbox.lookAt(0, 0, 0);
    this.scene.add(rear_softbox);
    this.adjustable_lights = [
      ambient,
      hemisphere,
      key,
      fill,
      rim,
      front_softbox,
      side_softbox,
      rear_softbox
    ];
    for (const light of this.adjustable_lights) {
      light.userData.base_intensity = light.intensity;
    }
  }

  /**
   * 应用画质、阴影、光照和曝光设置。低档会降低像素比、帧率、VNC 上传频率并关闭环境反射。
   */
  set_render_settings(settings: Partial<RenderSettings>): void {
    this.render_settings = normalize_render_settings({ ...this.render_settings, ...settings });
    this.render_profile = resolve_render_profile(this.render_settings.quality);
    const device_ratio = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1;
    this.renderer.setPixelRatio(Math.min(device_ratio, this.render_profile.pixel_ratio));
    this.resize();
    this.renderer.toneMappingExposure = this.render_settings.exposure;
    const effective_shadows =
      this.render_settings.shadows_enabled && this.render_profile.resolved_quality !== 'low';
    this.renderer.shadowMap.enabled = effective_shadows;
    if (this.key_light) {
      this.key_light.castShadow = effective_shadows;
      const shadow_size = this.render_profile.shadow_map_size;
      if (this.key_light.shadow.mapSize.x !== shadow_size) {
        this.key_light.shadow.mapSize.set(shadow_size, shadow_size);
        this.key_light.shadow.map?.dispose();
        this.key_light.shadow.map = null;
      }
    }
    this.scene.environment = this.render_profile.environment_enabled
      ? this.environment_texture
      : null;
    const light_scale = this.render_settings.lighting_enabled
      ? this.render_settings.lighting_intensity
      : 0.025;
    for (const light of this.adjustable_lights) {
      light.intensity = Number(light.userData.base_intensity || 0) * light_scale;
    }
  }

  /**
   * 地面与网格。
   *
   * @returns {void}
   * @private
   */
  private _setup_ground(): void {
    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(42, 64),
      new THREE.MeshStandardMaterial({ color: 0x0a1119, roughness: 0.72, metalness: 0.25 })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -1.62;
    ground.receiveShadow = true;
    this.scene.add(ground);

    const grid = new THREE.GridHelper(80, 80, 0x1d4a63, 0x122430);
    grid.position.y = -1.605;
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.4;
    this.scene.add(grid);
  }

  /**
   * 绑定指针事件。
   *
   * @returns {void}
   * @private
   */
  private _bind_events(): void {
    const canvas = this.renderer.domElement;
    canvas.addEventListener('pointerdown', (event) => {
      this.pointer_down = { x: event.clientX, y: event.clientY, time: performance.now() };
      if (event.button !== 0 || event.shiftKey) {
        return;
      }
      /* ⓪ 优先命中线缆标签（点标签改文字）。 */
      const label_hit = this._pick_label(event.clientX, event.clientY);
      if (label_hit) {
        const cable = this.cable_layer.get_cable(label_hit.cable_id);
        const current = cable
          ? label_hit.side === 'from'
            ? cable.label_text.from
            : cable.label_text.to
          : '';
        this.callbacks.on_label_click?.(label_hit.cable_id, label_hit.side, current);
        this.pointer_down = null;
        return;
      }
      /* ① 优先抓线缆端点（拖到别的端口 = 改插）。 */
      const endpoint = this._pick_cable_endpoint(event.clientX, event.clientY);
      if (endpoint) {
        this.endpoint_drag = endpoint;
        this.orbit.suspend();
        this.cable_layer.set_selected(endpoint.cable_id);
        canvas.style.cursor = 'grabbing';
        if (canvas.setPointerCapture) {
          try {
            canvas.setPointerCapture(event.pointerId);
          } catch (error) {
            void error;
          }
        }
        return;
      }
      /* ① 优先拾取走线把手（拖动整理走线）。 */
      const waypoint_hit = this._pick_waypoint(event.clientX, event.clientY);
      if (waypoint_hit) {
        this.waypoint_drag = {
          cable_id: waypoint_hit.cable_id,
          index: waypoint_hit.waypoint_index
        };
        /* 拖动走线期间冻结视角，否则相机跟着一起转，很难精准拉动。 */
        this.orbit.suspend();
        this.cable_layer.set_selected(waypoint_hit.cable_id);
        canvas.style.cursor = 'grabbing';
        try {
          canvas.setPointerCapture(event.pointerId);
        } catch (error) {
          /* 合成指针事件或指针已释放时会抛错，忽略即可。 */
          void error;
        }
        return;
      }
      /* ② 选中线缆：自动生成 3 个可拖拽控制点，可直接抓住线缆拉动调整走线。 */
      const cable_id = this._pick_cable(event.clientX, event.clientY);
      if (cable_id) {
        this.cable_layer.ensure_pull_waypoints(cable_id, PULL_WAYPOINT_COUNT);
        this.cable_layer.set_selected(cable_id);
        /* 在线缆本体上按下即进入拉动：同样冻结视角。 */
        const cable = this.cable_layer.get_cable(cable_id);
        if (cable && cable.waypoints.length > 0) {
          const grabbed = this._nearest_waypoint_index(cable, event.clientX, event.clientY);
          this.waypoint_drag = { cable_id: cable_id, index: grabbed };
          this.orbit.suspend();
          canvas.style.cursor = 'grabbing';
          if (canvas.setPointerCapture) {
            try {
              canvas.setPointerCapture(event.pointerId);
            } catch (error) {
              void error;
            }
          }
          return;
        }
      } else {
        this.cable_layer.set_selected(null);
      }
      const hit = this._pick(event.clientX, event.clientY);
      /* 只有命中机身才进入拖动；电源键/端口留给点击逻辑（左键点按钮即开关机）。 */
      if (hit && hit.kind === 'body') {
        const object = this.device_objects.get(hit.device_id);
        if (object) {
          this.orbit.suspend();
          /* 记录抓取点：指针射线与"设备所在水平面"的交点，
             拖动时保持"抓取点 → 设备原点"的偏移不变，设备就能严格跟着鼠标走。 */
          const grab = this._drag_plane_point(
            event.clientX,
            event.clientY,
            object.group.position.y
          );
          this.drag = {
            device_id: hit.device_id,
            pointer_id: event.pointerId,
            start_x: event.clientX,
            start_y: event.clientY,
            origin: object.group.position.clone(),
            grab: grab ? grab.clone() : object.group.position.clone(),
            moved: false
          };
          this.orbit.pointers.clear();
          this.orbit.mode = null;
          if (canvas.setPointerCapture) {
            canvas.setPointerCapture(event.pointerId);
          }
        }
      }
    });

    canvas.addEventListener('dblclick', (event) => {
      /* 双击线缆 → 在该处新增走线路径点；双击路径点 → 删除该点。 */
      const waypoint_hit = this._pick_waypoint(event.clientX, event.clientY);
      if (waypoint_hit) {
        this.cable_layer.remove_waypoint(waypoint_hit.cable_id, waypoint_hit.waypoint_index);
        return;
      }
      const cable_id = this._pick_cable(event.clientX, event.clientY);
      if (cable_id) {
        const point = this._ground_point(event.clientX, event.clientY);
        if (point) {
          point.y = 0.35;
          this.cable_layer.add_waypoint(cable_id, point);
          this.cable_layer.set_selected(cable_id);
        }
        return;
      }
      /* 双击设备机身 → 聚焦该设备（便于观察装配与开 CLI 调试）。 */
      const hit = this._pick(event.clientX, event.clientY);
      if (hit && hit.kind === 'body') {
        this.focus_device(hit.device_id);
      }
    });

    canvas.addEventListener('pointermove', (event) => {
      /* 拖动走线把手：把屏幕坐标投影到把手所在水平面，实时重排线缆路径。 */
      if (this.waypoint_drag) {
        const state = use_store.getState();
        const cable = this.cable_layer.get_cable(this.waypoint_drag.cable_id);
        const handle = cable ? cable.waypoints[this.waypoint_drag.index] : null;
        /* 面向相机的拖拽平面：控制点严格跟随鼠标（1:1），再夹到地面以上。 */
        const point = this._drag_facing_plane_point(
          event.clientX,
          event.clientY,
          handle ? handle.clone() : new THREE.Vector3(0, 0, 0)
        );
        if (point && cable) {
          /* 拖动时贴合地面以上：不允许拉到地面以下。 */
          point.y = Math.max(FLOOR_MIN_Y, point.y);
          this.cable_layer.move_waypoint(
            this.waypoint_drag.cable_id,
            this.waypoint_drag.index,
            point
          );
          /* 边拖边记录，保证页面刷新/同步后走线不弹回。 */
          state.set_cable_waypoints(
            this.waypoint_drag.cable_id,
            this.cable_layer.export_waypoints(this.waypoint_drag.cable_id)
          );
        }
        return;
      }
      /* 改插：端点跟随指针，并高亮指针下的端口。 */
      if (this.endpoint_drag) {
        const point = this._ground_point(event.clientX, event.clientY);
        if (point) {
          this.cable_layer.set_endpoint_preview(
            this.endpoint_drag.cable_id,
            this.endpoint_drag.side,
            point
          );
        }
        const hit = this._pick(event.clientX, event.clientY);
        this._set_replug_candidate(this._valid_replug_candidate(hit));
        return;
      }
      /* 连线预览：把光标位置投到地面并更新"半截线缆"。 */
      if (this.link_source_anchor && this.preview_active) {
        const point = this._ground_point(event.clientX, event.clientY);
        if (point) {
          this.cable_layer.update_preview(point);
        }
      }
      if (this.drag && event.pointerId === this.drag.pointer_id) {
        const delta_x = event.clientX - this.drag.start_x;
        const delta_y = event.clientY - this.drag.start_y;
        if (Math.abs(delta_x) + Math.abs(delta_y) > 3) {
          this.drag.moved = true;
        }
        const object = this.device_objects.get(this.drag.device_id);
        if (object) {
          /* 指针射线与设备所在水平面求交 → 设备 = 交点 + 抓取偏移（严格跟手）。 */
          const point = this._drag_plane_point(
            event.clientX,
            event.clientY,
            object.group.position.y
          );
          if (point) {
            const offset_x = this.drag.origin.x - this.drag.grab.x;
            const offset_z = this.drag.origin.z - this.drag.grab.z;
            object.group.position.x = utils.clamp(point.x + offset_x, -24, 24);
            object.group.position.z = utils.clamp(point.z + offset_z, -24, 24);
            this.wireless_layer.move_access_point(this.drag.device_id, object.group.position);
          }
          canvas.style.cursor = 'grabbing';
        }
        return;
      }
      if (this.orbit.mode) {
        return;
      }
      const hit = this._pick(event.clientX, event.clientY);
      const key = hit ? hit.device_id + ':' + (hit.port || hit.kind) : '';
      if (key !== this.hover_key) {
        this.hover_key = key;
        canvas.style.cursor =
          hit?.kind === 'screen' ? 'zoom-in' : hit?.port ? 'crosshair' : hit ? 'grab' : 'default';
        this.callbacks.on_hover(
          hit && hit.port
            ? { device_id: hit.device_id, port: hit.port, label: hit.device_id + ' / ' + hit.port }
            : null
        );
      }
    });

    canvas.addEventListener('pointerup', (event) => {
      if (this.endpoint_drag) {
        const drag = this.endpoint_drag;
        this.endpoint_drag = null;
        this.orbit.resume();
        canvas.style.cursor = 'default';
        const hit = this._pick(event.clientX, event.clientY);
        /* 注意：endpoint_drag 已清空，必须把 drag 显式传进去做合法性校验。 */
        const candidate = this._valid_replug_candidate(hit, drag);
        this.cable_layer.clear_endpoint_preview(drag.cable_id, drag.side);
        this._set_replug_candidate(null);
        if (candidate && this.callbacks.on_cable_replug) {
          this.callbacks.on_cable_replug(
            drag.cable_id,
            drag.side,
            candidate.device_id,
            candidate.port
          );
        }
        return;
      }
      if (this.waypoint_drag) {
        this.waypoint_drag = null;
        this.orbit.resume();
        canvas.style.cursor = 'default';
        return;
      }
      if (this.drag && event.pointerId === this.drag.pointer_id) {
        const drag = this.drag;
        this.drag = null;
        this.orbit.resume();
        canvas.style.cursor = 'default';
        const object = this.device_objects.get(drag.device_id);
        if (drag.moved && object) {
          this.callbacks.on_device_move(drag.device_id, {
            x: object.group.position.x,
            y: object.group.position.y,
            z: object.group.position.z
          });
        }
        return;
      }
      if (!this.pointer_down) {
        return;
      }
      const moved = Math.hypot(
        event.clientX - this.pointer_down.x,
        event.clientY - this.pointer_down.y
      );
      const elapsed = performance.now() - this.pointer_down.time;
      this.pointer_down = null;
      if (moved > 6 || elapsed > 700) {
        return;
      }
      const hit = this._pick(event.clientX, event.clientY);
      if (!hit) {
        this.callbacks.on_background_click();
        return;
      }
      if (hit.kind === 'power') {
        this.callbacks.on_power_click(hit.device_id);
        return;
      }
      if (hit.kind === 'screen') {
        this.callbacks.on_device_select?.(hit.device_id);
        this.callbacks.on_screen_click?.(hit.device_id);
        return;
      }
      if (hit.port) {
        const object = this.device_objects.get(hit.device_id);
        const port_state = object
          ? object.runtime_device?.ports.find((port: PortState) => port.short_name === hit.port)
          : null;
        if (port_state) {
          this.callbacks.on_port_click(hit.device_id, port_state);
        }
        return;
      }
      /* 命中机身：选中设备（右键菜单、检视面板随之切换）。 */
      if (this.callbacks.on_device_select) {
        this.callbacks.on_device_select(hit.device_id);
      }
    });
  }

  /**
   * 右键菜单：命中端口 → 端口菜单；命中设备 → 设备菜单；命中线缆 → 线缆菜单；否则空白菜单。
   *
   * @param {MouseEvent} event 鼠标事件。
   * @returns {void}
   * @private
   */
  private _on_context_menu = (event: MouseEvent): void => {
    event.preventDefault();
    if (!this.callbacks.on_context_menu) {
      return;
    }
    const hit = this._pick(event.clientX, event.clientY);
    if (hit && hit.kind === 'port' && hit.port) {
      this.callbacks.on_context_menu({
        kind: 'port',
        device_id: hit.device_id,
        port: hit.port,
        client_x: event.clientX,
        client_y: event.clientY
      });
      return;
    }
    if (hit && (hit.kind === 'body' || hit.kind === 'power' || hit.kind === 'screen')) {
      this.callbacks.on_context_menu({
        kind: 'device',
        device_id: hit.device_id,
        client_x: event.clientX,
        client_y: event.clientY
      });
      return;
    }
    const cable_id = this._pick_cable(event.clientX, event.clientY);
    if (cable_id) {
      this.callbacks.on_context_menu({
        kind: 'cable',
        cable_id: cable_id,
        client_x: event.clientX,
        client_y: event.clientY
      });
      return;
    }
    this.callbacks.on_context_menu({
      kind: 'background',
      client_x: event.clientX,
      client_y: event.clientY
    });
  };

  /**
   * 处理从面板拖入场景的放置事件。
   *
   * @param {DragEvent} event 拖放事件。
   * @returns {void}
   * @private
   */
  private _on_drop = (event: DragEvent): void => {
    event.preventDefault();
    if (!this.callbacks.on_drop || !event.dataTransfer) {
      return;
    }
    const type = event.dataTransfer.getData('application/x-simlab-kind');
    const value = event.dataTransfer.getData('application/x-simlab-value');
    if (!type || !value) {
      return;
    }
    const point = this._ground_point(event.clientX, event.clientY);
    if (!point) {
      return;
    }
    const hit = this._pick(event.clientX, event.clientY);
    this.callbacks.on_drop({
      type: type,
      value: value,
      x: Number(point.x.toFixed(3)),
      z: Number(point.z.toFixed(3)),
      client_x: event.clientX,
      client_y: event.clientY,
      hit_port:
        hit && hit.kind === 'port' && hit.port ? { device_id: hit.device_id, port: hit.port } : null
    });
  };

  /**
   * 拾取走线把手。
   *
   * @param {number} client_x 屏幕 X。
   * @param {number} client_y 屏幕 Y。
   * @returns {{cable_id: string; waypoint_index: number} | null} 命中信息。
   * @private
   */
  private _pick_waypoint(
    client_x: number,
    client_y: number
  ): { cable_id: string; waypoint_index: number } | null {
    const bounds = this.renderer.domElement.getBoundingClientRect();
    const pointer = new THREE.Vector2(
      ((client_x - bounds.left) / bounds.width) * 2 - 1,
      -((client_y - bounds.top) / bounds.height) * 2 + 1
    );
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(pointer, this.camera);
    const hits = raycaster.intersectObjects(this.cable_layer.waypoint_meshes(), false);
    const picked = this.cable_layer.pick_waypoint(hits);
    if (!picked) {
      return null;
    }

    return { cable_id: picked.cable_id, waypoint_index: picked.waypoint_index };
  }

  /**
   * 射线拾取线缆（设备间线缆与光缆）。
   *
   * @param {number} client_x 屏幕 X。
   * @param {number} client_y 屏幕 Y。
   * @returns {string | null} 线缆 ID。
   * @private
   */
  /**
   * 找出离指针最近的走线控制点（用于"点住线缆本体即可拉动"）。
   *
   * @param {CableObject} cable 线缆对象。
   * @param {number} client_x 屏幕 X。
   * @param {number} client_y 屏幕 Y。
   * @returns {number} 控制点索引。
   * @private
   */
  private _nearest_waypoint_index(cable: CableObject, client_x: number, client_y: number): number {
    let best_index = 0;
    let best_distance = Number.POSITIVE_INFINITY;
    for (let index = 0; index < cable.waypoints.length; index += 1) {
      const screen = this.project(cable.waypoints[index]);
      const distance = Math.hypot(screen.x - client_x, screen.y - client_y);
      if (distance < best_distance) {
        best_distance = distance;
        best_index = index;
      }
    }

    return best_index;
  }

  /**
   * 拾取线缆标签（Sprite 射线检测）。
   *
   * @param {number} client_x 屏幕 X。
   * @param {number} client_y 屏幕 Y。
   * @returns {{cable_id: string, side: 'from' | 'to'} | null} 命中的标签。
   * @private
   */
  private _pick_label(
    client_x: number,
    client_y: number
  ): { cable_id: string; side: 'from' | 'to' } | null {
    const bounds = this.renderer.domElement.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) {
      return null;
    }
    const pointer = new THREE.Vector2(
      ((client_x - bounds.left) / bounds.width) * 2 - 1,
      -((client_y - bounds.top) / bounds.height) * 2 + 1
    );
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(pointer, this.camera);

    return this.cable_layer.pick_label(raycaster);
  }

  /**
   * 拾取线缆端点（连接器附近）；命中则返回端点信息，用于拖动改插。
   *
   * @param {number} client_x 屏幕 X。
   * @param {number} client_y 屏幕 Y。
   * @returns {{cable_id: string, side: 'from' | 'to'} | null} 端点信息。
   * @private
   */
  private _pick_cable_endpoint(
    client_x: number,
    client_y: number
  ): { cable_id: string; side: 'from' | 'to' } | null {
    let best: { cable_id: string; side: 'from' | 'to' } | null = null;
    let best_distance = ENDPOINT_PICK_RADIUS_PX;
    for (const cable of this.cable_layer.iterate()) {
      for (const side of ['from', 'to'] as ('from' | 'to')[]) {
        const connector = cable.connector_object(side);
        const world = new THREE.Vector3();
        connector.getWorldPosition(world);
        const screen = this.project(world);
        const distance = Math.hypot(screen.x - client_x, screen.y - client_y);
        if (distance < best_distance) {
          best_distance = distance;
          best = { cable_id: cable.cable_id, side: side };
        }
      }
    }

    return best;
  }

  /**
   * 过滤非法改插落点：不能插到"另一端所在设备"上（会形成自环）。
   *
   * @param {{device_id: string, port: string | null, kind: string} | null} hit 拾取结果。
   * @returns {{device_id: string, port: string} | null} 合法候选端口。
   * @private
   */
  private _valid_replug_candidate(
    hit: { device_id: string; port: string | null; kind: string } | null,
    drag: { cable_id: string; side: 'from' | 'to' } | null = this.endpoint_drag
  ): { device_id: string; port: string } | null {
    if (!drag || !hit || !hit.port) {
      return null;
    }
    const record = this.state
      ? this.state.cables.find((item) => item.cable_id === drag.cable_id)
      : null;
    if (record) {
      /* 落在本端当前所在端口 → 无意义；落在"另一端所在设备"是允许的，
         由 store 自动换位处理（真机可直接换口）。 */
      const own = drag.side === 'from' ? record.source : record.target;
      if (own && own.device_id === hit.device_id && own.port === hit.port) {
        return null;
      }
    }

    return { device_id: hit.device_id, port: hit.port };
  }

  /**
   * 设置改插候选端口高亮。
   *
   * @param {{device_id: string, port: string} | null} candidate 候选端口。
   * @returns {void}
   * @private
   */
  private _set_replug_candidate(candidate: { device_id: string; port: string } | null): void {
    const previous = this.replug_candidate;
    if (
      previous &&
      (!candidate || previous.device_id !== candidate.device_id || previous.port !== candidate.port)
    ) {
      const object = this.device_objects.get(previous.device_id);
      if (object) {
        object.set_selected_port(null);
      }
    }
    this.replug_candidate = candidate;
    if (candidate) {
      const object = this.device_objects.get(candidate.device_id);
      if (object) {
        object.set_selected_port(candidate.port);
      }
    }
  }

  private _pick_cable(client_x: number, client_y: number): string | null {
    const bounds = this.renderer.domElement.getBoundingClientRect();
    const pointer = new THREE.Vector2(
      ((client_x - bounds.left) / bounds.width) * 2 - 1,
      -((client_y - bounds.top) / bounds.height) * 2 + 1
    );
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(pointer, this.camera);
    /* 线缆由 CableLayer 渲染：拾取也必须走它，且必须递归命中子网格
       （分组自身没有几何体，非递归检测永远打不中）。 */
    const hits = raycaster.intersectObjects(this.cable_layer.pickable_meshes(), true);
    if (hits.length === 0) {
      return null;
    }

    return this.cable_layer.pick_cable(hits);
  }

  /**
   * 对外暴露的屏幕点拾取（拖放落点判定：端口优先）。
   *
   * @param {number} client_x 屏幕 X。
   * @param {number} client_y 屏幕 Y。
   * @returns {{device_id: string; port: string | null; kind: string} | null} 命中信息。
   */
  pick_target(
    client_x: number,
    client_y: number
  ): { device_id: string; port: string | null; kind: string } | null {
    return this._pick(client_x, client_y);
  }

  /**
   * 屏幕坐标 → 指定高度的水平面交点（走线拖拽用）。
   *
   * @param {number} client_x 屏幕 X。
   * @param {number} client_y 屏幕 Y。
   * @param {number} height 平面高度（场景单位）。
   * @returns {THREE.Vector3 | null} 交点。
   * @private
   */
  /**
   * 屏幕坐标 → 过指定点且面向相机的平面上的世界坐标（拖拽 1:1 跟随鼠标）。
   *
   * @param {number} client_x 屏幕 X。
   * @param {number} client_y 屏幕 Y。
   * @param {THREE.Vector3} through 平面经过的点。
   * @returns {THREE.Vector3 | null} 世界坐标。
   * @private
   */
  private _drag_facing_plane_point(
    client_x: number,
    client_y: number,
    through: THREE.Vector3
  ): THREE.Vector3 | null {
    return pointer_facing_plane_point(
      client_x,
      client_y,
      this.renderer.domElement.getBoundingClientRect(),
      this.camera,
      through
    );
  }

  private _drag_plane_point(
    client_x: number,
    client_y: number,
    height: number
  ): THREE.Vector3 | null {
    return pointer_plane_point(
      client_x,
      client_y,
      this.renderer.domElement.getBoundingClientRect(),
      this.camera,
      height
    );
  }

  /**
   * 开始连线预览（从真实接口长出的半截线缆）。
   *
   * @param {string} device_id 起点设备 ID。
   * @param {string} port 起点端口短名。
   * @param {string} cable_kind 线缆栏线缆类型（可空，按端口自动选型）。
   * @returns {void}
   */
  start_cable_preview(device_id: string, port: string, cable_kind?: string | null): void {
    const object = this.device_objects.get(device_id);
    const anchor = object && object.anchor_for(port);
    if (!object || !anchor) {
      this.preview_active = false;
      return;
    }
    const kind = cable_kind || default_kind_for_connector(anchor.connector);
    const created = kind && this.cable_layer.create_preview(kind, anchor, object.group);
    if (!created) {
      this.preview_active = false;
      return;
    }
    this.link_source_anchor = { device_id: device_id, port: port };
    this.preview_active = true;
  }

  /**
   * 结束连线预览。
   *
   * @returns {void}
   */
  stop_cable_preview(): void {
    this.cable_layer.cancel_preview();
    this.link_source_anchor = null;
    this.preview_active = false;
  }

  /**
   * 屏幕坐标 → 地面世界坐标（拖放定位用）。
   *
   * @param {number} client_x 屏幕 X。
   * @param {number} client_y 屏幕 Y。
   * @returns {THREE.Vector3 | null} 地面交点。
   * @private
   */
  private _ground_point(client_x: number, client_y: number): THREE.Vector3 | null {
    const bounds = this.renderer.domElement.getBoundingClientRect();
    const pointer = new THREE.Vector2(
      ((client_x - bounds.left) / bounds.width) * 2 - 1,
      -((client_y - bounds.top) / bounds.height) * 2 + 1
    );
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(pointer, this.camera);
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const point = new THREE.Vector3();
    if (!raycaster.ray.intersectPlane(plane, point)) {
      return null;
    }

    return point;
  }

  /**
   * 射线拾取。
   *
   * @param {number} client_x 屏幕 X。
   * @param {number} client_y 屏幕 Y。
   * @returns {{device_id: string; port: string | null; kind: string} | null} 命中信息。
   * @private
   */
  private _pick(
    client_x: number,
    client_y: number
  ): { device_id: string; port: string | null; kind: string } | null {
    const bounds = this.renderer.domElement.getBoundingClientRect();
    const pointer = new THREE.Vector2(
      ((client_x - bounds.left) / bounds.width) * 2 - 1,
      -((client_y - bounds.top) / bounds.height) * 2 + 1
    );
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(pointer, this.camera);
    const targets: THREE.Object3D[] = [];
    for (const object of this.device_objects.values()) {
      for (const visual of object.port_visuals) {
        targets.push(...visual.pickable_meshes());
      }
      if (object.power_button) {
        targets.push(object.power_button);
      }
      const screen_surface = object.group.getObjectByName('vnc_screen_surface');
      if (screen_surface) {
        targets.push(screen_surface);
      }
      targets.push(object.shell);
    }
    const hits = raycaster.intersectObjects(targets, false);
    for (const hit of hits) {
      const info = this.pick_index.get(hit.object);
      if (info) {
        if (info.kind === 'body') {
          return this._pick_pc_port_near_pointer(client_x, client_y) || info;
        }
        return info;
      }
    }
    return this._pick_pc_port_near_pointer(client_x, client_y);
  }

  /** PC 背部网口藏在机箱边缘时，用小范围屏幕命中区补偿遮挡。 */
  private _pick_pc_port_near_pointer(
    client_x: number,
    client_y: number
  ): { device_id: string; port: string; kind: 'port' } | null {
    const bounds = this.renderer.domElement.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) {
      return null;
    }
    const pointer = new THREE.Vector2(
      ((client_x - bounds.left) / bounds.width) * 2 - 1,
      -((client_y - bounds.top) / bounds.height) * 2 + 1
    );
    const nearest_distance = 18;
    let nearest: { device_id: string; port: string; kind: 'port'; distance: number } | null = null;
    for (const [device_id, object] of this.device_objects) {
      if (object.runtime_device?.model_id !== 'generic-atx-pc') {
        continue;
      }
      object.group.updateMatrixWorld(true);
      for (const visual of object.port_visuals) {
        const port_position = port_world_position(object, visual.definition.short_name);
        if (!port_position) {
          continue;
        }
        const projected = port_position.project(this.camera);
        const screen_x = bounds.left + ((projected.x + 1) * bounds.width) / 2;
        const screen_y = bounds.top + ((1 - projected.y) * bounds.height) / 2;
        const distance = Math.hypot(client_x - screen_x, client_y - screen_y);
        if (distance <= nearest_distance && (!nearest || distance < nearest.distance)) {
          nearest = {
            device_id: device_id,
            port: visual.definition.short_name,
            kind: 'port',
            distance: distance
          };
        }
      }
    }
    return nearest
      ? { device_id: nearest.device_id, port: nearest.port, kind: nearest.kind }
      : null;
  }

  /**
   * 同步场景状态（React → 三维）。
   *
   * @param {SceneSyncOptions} options 状态。
   * @returns {void}
   */
  sync(options: SceneSyncOptions): void {
    this.state = options;

    /* 1. 设备对象增删。 */
    const active_ids = new Set<string>();
    for (const device of options.devices) {
      active_ids.add(device.device_id);
      let object = this.device_objects.get(device.device_id);
      if (!object) {
        const registry = get_registry();
        object = new DeviceObject({
          manifest: device.manifest,
          vendor_profile: registry.vendor(device.vendor_id),
          runtime_device: device
        });
        object.group.position.set(device.position.x, device.position.y, device.position.z);
        this.scene.add(object.group);
        this.device_objects.set(device.device_id, object);
        this._register_pick_targets(device.device_id, object);
      }
      object.runtime_device = device;
      /* 模板被工坊改过（版本变化）→ 原地重建几何并刷新拾取索引。 */
      const cache_key = template_cache_key(device.model_id);
      if (object.template_cache_key !== cache_key) {
        const active_vnc_canvas = this.vnc_screens.get(device.device_id)?.canvas;
        if (active_vnc_canvas) {
          this.clear_device_screen_canvas(device.device_id);
        }
        object.template_cache_key = cache_key;
        if (object.rebuild_template && object.rebuild_template()) {
          for (const [mesh, info] of [...this.pick_index.entries()]) {
            if (info.device_id === device.device_id) {
              this.pick_index.delete(mesh);
            }
          }
          this._register_pick_targets(device.device_id, object);
          if (active_vnc_canvas) {
            this.set_device_screen_canvas(device.device_id, active_vnc_canvas);
          }
        }
      }
      if (this.drag && this.drag.device_id === device.device_id) {
        continue;
      }
      object.group.position.set(device.position.x, device.position.y, device.position.z);
    }
    for (const [device_id, object] of [...this.device_objects.entries()]) {
      if (active_ids.has(device_id)) {
        continue;
      }
      this.clear_device_screen_canvas(device_id);
      this.scene.remove(object.group);
      object.dispose();
      this.device_objects.delete(device_id);
      for (const [key, value] of [...this.pick_index.entries()]) {
        if (value.device_id === device_id) {
          this.pick_index.delete(key);
        }
      }
    }

    /* 2. 显示模式、选中态与链路。 */
    for (const [device_id, object] of this.device_objects.entries()) {
      object.set_mode(options.display_mode);
      object.set_power(
        options.devices.find((device) => device.device_id === device_id)?.power_state !==
          DEVICE_STATE.OFF
      );
      if (options.flow_enabled && options.display_mode !== 'shell') {
        object.set_flow_visible(true);
      } else {
        object.set_flow_visible(false);
      }
      const is_selected = options.selected_device_id === device_id;
      object.set_selected_port(is_selected ? options.selected_port : null);
    }
    /* 真高仿线缆：从设备模板的真实接口锚点长出，支持拖拽整理走线。 */
    const anchors = new Map<string, Map<string, unknown>>();
    const scene_objects = new Map<string, THREE.Object3D>();
    for (const [device_id, object] of this.device_objects.entries()) {
      scene_objects.set(device_id, object.group);
      anchors.set(device_id, object.port_anchors || new Map());
    }
    /* 线缆图层用"米 → 场景单位"比例绘制线径与连接器：
       模板设备比例约 20（1U 宽 0.442 m → 8.84 场景单位），取中位数避免个别型号偏大偏小。 */
    const scales = [...this.device_objects.values()]
      .map((object) => object.template_scale || object.layout.scale * 10)
      .filter((value) => value > 0)
      .sort((left, right) => left - right);
    const cable_scene_scale = scales.length > 0 ? scales[Math.floor(scales.length / 2)] : 20;
    this.cable_layer.sync(
      layer_records_from_cables(options.cables),
      scene_objects,
      anchors as Parameters<typeof this.cable_layer.sync>[2],
      cable_scene_scale
    );
    /* 用户自定义标签（点标签改文字）优先于默认编号 A-nn / B-nn。 */
    this.cable_layer.set_custom_labels(options.cable_labels || {});
    /* 恢复用户拉动过的走线（否则每 3 秒同步会把线缆拉回默认路径）。 */
    for (const [cable_id, points] of Object.entries(options.cable_waypoints || {})) {
      this.cable_layer.import_waypoints(cable_id, points);
    }
    /* 避障：把设备包围盒下发给线缆，碰到设备时从上方绕行（不穿模）。 */
    const obstacles: { device_id: string; box: THREE.Box3 }[] = [];
    for (const [device_id, object] of this.device_objects.entries()) {
      const box = new THREE.Box3().setFromObject(object.group);
      if (box.isEmpty()) {
        continue;
      }
      obstacles.push({ device_id: device_id, box: box });
    }
    this.cable_layer.apply_obstacles(obstacles);
    /* 链路图层改为只负责光纤状态着色与告警光圈（线缆几何由线缆图层承担）。 */
    this.link_layer.sync(
      [],
      this.device_objects,
      options.optical ? options.optical.links : undefined
    );
    this.link_layer.group.visible = true;

    /* 2.1 内部结构随显示模式显隐：外观模式隐藏，透视与爆炸显示。 */
    const show_internal = options.display_mode !== 'shell';
    for (const object of this.device_objects.values()) {
      object.set_internal_visible(show_internal);
    }

    /* 3. 无线与光链路效果。 */
    this.wireless_waiting_sta = options.wireless_waiting_sta || [];
    this._sync_wireless(options.wireless);

    /* 4. 连线预览只由真实接口锚点驱动，避免旧面板坐标生成第二根错位线。 */
    this.link_layer.set_preview(null);
    this._sync_cable_preview(options.link_source, options.pending_cable_kind || null);

    /* 5. 轨道自动旋转。 */
    this.orbit.auto_rotate = options.auto_rotate;
  }

  /**
   * 注册拾取索引。
   *
   * @param {string} device_id 设备 ID。
   * @param {DeviceObject} object 设备对象。
   * @returns {void}
   * @private
   */
  private _register_pick_targets(device_id: string, object: DeviceObject): void {
    for (const visual of object.port_visuals) {
      for (const mesh of visual.pickable_meshes()) {
        this.pick_index.set(mesh, {
          device_id: device_id,
          port: visual.definition.short_name,
          kind: 'port'
        });
      }
    }
    if (object.power_button) {
      this.pick_index.set(object.power_button, { device_id: device_id, port: null, kind: 'power' });
    }
    const screen_surface = object.group.getObjectByName('vnc_screen_surface');
    if (screen_surface) {
      this.pick_index.set(screen_surface, { device_id: device_id, port: null, kind: 'screen' });
    }
    this.pick_index.set(object.shell, { device_id: device_id, port: null, kind: 'body' });
  }

  /**
   * 同步无线效果（AP 覆盖圈与关联线）。
   *
   * @param {WirelessSnapshot | null} wireless 无线状态。
   * @returns {void}
   * @private
   */
  private _sync_wireless(wireless: WirelessSnapshot | null): void {
    if (!wireless) {
      this.wireless_layer.set_visible(false);
      return;
    }
    this.wireless_layer.set_visible(true);
    const active_aps = new Set<string>();
    for (const ap of wireless.aps || []) {
      const device = this.device_objects.get(ap.device_id);
      if (!device) {
        continue;
      }
      active_aps.add(ap.device_id);
      this.wireless_layer.update_access_point(
        ap.device_id,
        ap.coverage_radius_m,
        ap.channel_utilization,
        device.group.position
      );
    }
    /* 无线连接以射频波束表达：一次性同步全部关联与"在搜索"的 STA。 */
    const positions = new Map<string, THREE.Vector3>();
    for (const [device_id, object] of this.device_objects.entries()) {
      positions.set(device_id, object.group.position.clone());
    }
    const waiting = new Set<string>();
    for (const device_id of this.wireless_waiting_sta) {
      if (positions.has(device_id)) {
        waiting.add(device_id);
      }
    }
    const active_keys = new Set<string>();
    const associations: { sta_device_id: string; ap_device_id: string; rssi_dbm: number }[] = [];
    for (const association of wireless.associations || []) {
      if (!positions.has(association.sta_device_id) || !positions.has(association.ap_device_id)) {
        continue;
      }
      active_keys.add(association.sta_device_id + '->' + association.ap_device_id);
      associations.push({
        sta_device_id: association.sta_device_id,
        ap_device_id: association.ap_device_id,
        rssi_dbm: association.rssi_dbm
      });
    }
    this.wireless_layer.sync_associations(associations, positions, waiting);
    this.wireless_layer.prune(active_aps, active_keys);
  }

  /**
   * 按当前连线状态维护"半截线缆"预览。
   *
   * @param {{device_id: string; port: string} | null} source 连线起点。
   * @param {string | null} cable_kind 线缆栏类型。
   * @returns {void}
   * @private
   */
  private _sync_cable_preview(
    source: { device_id: string; port: string } | null,
    cable_kind: string | null
  ): void {
    if (!source) {
      if (this.preview_active) {
        this.stop_cable_preview();
      }
      return;
    }
    const changed =
      !this.link_source_anchor ||
      this.link_source_anchor.device_id !== source.device_id ||
      this.link_source_anchor.port !== source.port;
    if (changed) {
      this.start_cable_preview(source.device_id, source.port, cable_kind);
      return;
    }
    if (!this.preview_active) {
      this.start_cable_preview(source.device_id, source.port, cable_kind);
    }
  }

  /**
   * 视口尺寸变化。
   *
   * @returns {void}
   */
  resize(): void {
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
  }

  /**
   * 世界坐标 → 屏幕坐标（供 HTML 标签使用）。
   *
   * @param {THREE.Vector3} world 世界坐标。
   * @returns {{x: number; y: number; visible: boolean}} 屏幕坐标。
   */
  project(world: THREE.Vector3): { x: number; y: number; visible: boolean } {
    const projected = world.clone().project(this.camera);
    return {
      x: (projected.x * 0.5 + 0.5) * window.innerWidth,
      y: (-projected.y * 0.5 + 0.5) * window.innerHeight,
      visible: projected.z < 1
    };
  }

  /**
   * 设备在屏幕上的位置（标签锚点）。
   *
   * @param {string} device_id 设备 ID。
   * @returns {{x: number; y: number; visible: boolean}} 屏幕坐标。
   */
  device_screen_position(device_id: string): { x: number; y: number; visible: boolean } {
    const object = this.device_objects.get(device_id);
    if (!object) {
      return { x: -1000, y: -1000, visible: false };
    }
    const world = object.group.position.clone();
    world.y += object.layout.height / 2 + 0.5;
    return this.project(world);
  }

  /**
   * 把 noVNC 的原生 Canvas 直接挂到三维 PC 显示面。
   * 相机移动时画面与机身在同一 WebGL 帧内渲染，不会发生 DOM 重排抖动。
   *
   * @param {string} device_id 前端 PC 设备 ID。
   * @param {HTMLCanvasElement} canvas noVNC 持续更新的画布。
   * @returns {boolean} 是否找到并绑定了显示面。
   */
  set_device_screen_canvas(device_id: string, canvas: HTMLCanvasElement): boolean {
    const object = this.device_objects.get(device_id);
    const surface = object?.group.getObjectByName('vnc_screen_surface') as THREE.Mesh | undefined;
    if (!surface?.isMesh) {
      return false;
    }
    const current = this.vnc_screens.get(device_id);
    if (current?.surface === surface && current.canvas === canvas) {
      return true;
    }
    this.clear_device_screen_canvas(device_id);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    texture.needsUpdate = true;
    const material = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      map: texture,
      toneMapped: false
    });
    const original_material = surface.material;
    surface.material = material;
    this.vnc_screens.set(device_id, {
      surface: surface,
      texture: texture,
      material: material,
      original_material: original_material,
      canvas: canvas,
      updated_at: 0
    });
    return true;
  }

  /**
   * 移除 VNC WebGL 纹理并恢复设备模板的原始屏幕材质。
   *
   * @returns {void}
   */
  clear_device_screen_canvas(device_id?: string): void {
    const device_ids = device_id ? [device_id] : [...this.vnc_screens.keys()];
    for (const active_device_id of device_ids) {
      const binding = this.vnc_screens.get(active_device_id);
      if (!binding) {
        continue;
      }
      if (binding.surface.material === binding.material) {
        binding.surface.material = binding.original_material;
      }
      binding.material.dispose();
      binding.texture.dispose();
      this.vnc_screens.delete(active_device_id);
    }
  }

  /**
   * 启动渲染循环。
   *
   * @param {(delta_seconds: number) => void} [on_frame] 每帧回调（用于运行时推进）。
   * @returns {void}
   */
  start(on_frame?: (delta_seconds: number) => void): void {
    const step = (now: number) => {
      this.frame_handle = requestAnimationFrame(step);
      const frame_interval =
        this.render_profile.target_fps >= 60 ? 0 : 1000 / this.render_profile.target_fps;
      if (frame_interval > 0 && now - this.last_render_time < frame_interval) {
        return;
      }
      this.last_render_time = now;
      const delta_seconds = Math.min(0.05, (now - this.last_time) / 1000);
      this.last_time = now;
      this.time_accumulator += delta_seconds;

      this.orbit.update();
      if (on_frame) {
        on_frame(delta_seconds);
      }
      for (const object of this.device_objects.values()) {
        object.update(this.time_accumulator, delta_seconds);
      }
      this.link_layer.update(delta_seconds);
      /* 已拔出（播放退线动画）的线缆继续推进，动画结束自动销毁。 */
      this.cable_layer.update_detached(delta_seconds);
      this.wireless_layer.update(delta_seconds, (device_id) => {
        const object = this.device_objects.get(device_id);
        return object ? object.group.position.clone() : null;
      });
      for (const binding of this.vnc_screens.values()) {
        if (this.time_accumulator - binding.updated_at < 1 / this.render_profile.vnc_fps) {
          continue;
        }
        /* 每台 CanvasTexture 都在帧边界内上传，避免 DOM 重排和画面撕裂。 */
        binding.texture.needsUpdate = true;
        binding.updated_at = this.time_accumulator;
      }
      this.renderer.render(this.scene, this.camera);
    };
    this.frame_handle = requestAnimationFrame(step);
  }

  /**
   * 播放转发动画（由事件触发）。
   *
   * @param {string[]} path 设备路径。
   * @param {number} hop_index 跳序号。
   * @param {string | null} in_port 入端口。
   * @param {string | null} out_port 出端口。
   * @returns {void}
   */
  play_forward(
    path: string[],
    hop_index: number,
    in_port: string | null,
    out_port: string | null
  ): void {
    this.link_layer.play_forward(path, hop_index, this.device_objects, in_port, out_port);
  }

  /**
   * 播放空中帧动画。
   *
   * @param {string} sta_id STA。
   * @param {string} ap_id AP。
   * @param {string} direction 方向。
   * @returns {void}
   */
  play_wireless_frame(sta_id: string, ap_id: string, direction: string): void {
    this.wireless_layer.play_frame(sta_id, ap_id, direction);
  }

  /**
   * 调试/测试用：对整个场景做射线检测，返回命中对象信息（排查大面积遮挡物）。
   *
   * @param {number} client_x 屏幕 X。
   * @param {number} client_y 屏幕 Y。
   * @returns {object[]} 命中信息列表（由近到远）。
   */
  debug_pick_all(client_x: number, client_y: number): object[] {
    const bounds = this.renderer.domElement.getBoundingClientRect();
    const pointer = new THREE.Vector2(
      ((client_x - bounds.left) / bounds.width) * 2 - 1,
      -((client_y - bounds.top) / bounds.height) * 2 + 1
    );
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(pointer, this.camera);
    const hits = raycaster.intersectObjects(this.scene.children, true);

    return hits.slice(0, 8).map((hit) => {
      const mesh = hit.object as THREE.Mesh;
      const material = mesh.material as THREE.MeshBasicMaterial | undefined;
      return {
        name: hit.object.name || hit.object.type,
        parent: hit.object.parent ? hit.object.parent.name || hit.object.parent.type : null,
        geometry: mesh.geometry ? mesh.geometry.type : null,
        material: material ? material.type : null,
        color: material && material.color ? '#' + material.color.getHexString() : null,
        opacity: material ? material.opacity : null,
        distance: Number(hit.distance.toFixed(2))
      };
    });
  }

  /**
   * 调试/测试用：逐个目标做射线检测，定位材质缺失的对象。
   *
   * @param {number} client_x 屏幕 X。
   * @param {number} client_y 屏幕 Y。
   * @returns {string[]} 问题列表。
   */
  debug_probe_targets(client_x: number, client_y: number): string[] {
    const bounds = this.renderer.domElement.getBoundingClientRect();
    const pointer = new THREE.Vector2(
      ((client_x - bounds.left) / bounds.width) * 2 - 1,
      -((client_y - bounds.top) / bounds.height) * 2 + 1
    );
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(pointer, this.camera);
    const problems: string[] = [];
    for (const [device_id, object] of this.device_objects.entries()) {
      const targets: THREE.Object3D[] = [];
      for (const visual of object.port_visuals) {
        for (const mesh of visual.pickable_meshes()) {
          targets.push(mesh);
        }
      }
      if (object.power_button) {
        targets.push(object.power_button);
      }
      targets.push(object.shell);
      for (const target of targets) {
        try {
          raycaster.intersectObject(target, false);
        } catch (error) {
          const mesh = target as THREE.Mesh;
          const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
          problems.push(
            device_id +
              ' 目标 ' +
              (target.name || target.type) +
              ' 材质=' +
              (material === undefined
                ? 'undefined'
                : Array.isArray(material)
                  ? 'array(' + material.length + ')'
                  : (material as THREE.Material).type) +
              ' 几何组=' +
              (mesh.geometry ? mesh.geometry.groups.length : -1) +
              ' → ' +
              String((error as Error).message)
          );
        }
      }
    }

    return problems.slice(0, 8);
  }

  /**
   * 调试/测试用：扫描场景树，找出 undefined 子节点（渲染期异常的根因）。
   *
   * @returns {string[]} 问题描述列表。
   */
  debug_scan_scene(): string[] {
    const problems: string[] = [];
    const visit = (object: THREE.Object3D, path: string): void => {
      const renderable = object as THREE.Mesh;
      const draws =
        (renderable as unknown as { isMesh?: boolean }).isMesh ||
        (renderable as unknown as { isLine?: boolean }).isLine ||
        (renderable as unknown as { isPoints?: boolean }).isPoints ||
        (renderable as unknown as { isSprite?: boolean }).isSprite;
      if (draws && !renderable.material) {
        problems.push(path + '（' + object.type + '）缺少材质');
      }
      const children = object.children as (THREE.Object3D | undefined)[];
      for (let index = 0; index < children.length; index += 1) {
        const child = children[index];
        if (!child) {
          problems.push(path + '[' + index + '] 为 undefined');
          continue;
        }
        visit(child, path + '/' + (child.name || child.type) + '[' + index + ']');
      }
    };
    visit(this.scene, 'scene');

    return problems.slice(0, 12);
  }

  /**
   * 调试/测试用：按设备 ID 取三维设备对象。
   *
   * @param {string} device_id 设备 ID。
   * @returns {DeviceObject | null} 设备对象。
   */
  debug_device_object(device_id: string): DeviceObject | null {
    return this.device_objects.get(device_id) || null;
  }

  /**
   * 设置视角预设。
   *
   * @param {ViewPreset} preset 预设。
   * @returns {void}
   */
  set_view(preset: ViewPreset): void {
    this.orbit.set_view(preset);
  }

  /**
   * 聚焦到指定设备（用于近距离观察装配与调试）。
   *
   * @param {string} device_id 设备 ID。
   * @returns {void}
   */
  focus_device(device_id: string): void {
    const object = this.device_objects.get(device_id);
    if (!object) {
      return;
    }
    /* 直接按装配后的真实包围盒取景，手机/AP 可贴近，笔记本屏幕也不会被裁掉。 */
    const bounds = new THREE.Box3().setFromObject(object.group);
    const center = bounds.getCenter(new THREE.Vector3());
    const size = bounds.getSize(new THREE.Vector3());
    const span = Math.max(size.x, size.y * 1.35, size.z * 1.25, 0.65);
    this.orbit.target.copy(center);
    this.orbit.wanted.radius = utils.clamp(
      (span / 2) / Math.tan((this.camera.fov * Math.PI) / 360) * 1.48,
      this.orbit.min_radius,
      this.orbit.max_radius
    );
    this.orbit.spherical.radius = this.orbit.wanted.radius;
    this.orbit.spherical.theta = 0.28;
    this.orbit.spherical.phi = 1.22;
    this.orbit.wanted.theta = 0.28;
    this.orbit.wanted.phi = 1.22;
  }

  /**
   * 自动取景：把全部设备纳入视野并居中（多设备实验台）。
   *
   * @returns {void}
   */
  frame_all(): void {
    if (this.device_objects.size === 0) {
      return;
    }
    const box = new THREE.Box3();
    for (const object of this.device_objects.values()) {
      box.expandByObject(object.group);
    }
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const max_dimension = Math.max(size.x, size.z, size.y * 2.4, 9);
    const fov = (this.camera.fov * Math.PI) / 180;
    const distance = (max_dimension / 2 / Math.tan(fov / 2)) * 1.45;
    this.orbit.target.set(center.x, Math.max(0, center.y * 0.5), center.z);
    this.orbit.wanted.radius = utils.clamp(distance, this.orbit.min_radius, this.orbit.max_radius);
    this.orbit.spherical.radius = this.orbit.wanted.radius;
    this.orbit.wanted.theta = 0.66;
    this.orbit.wanted.phi = 1.02;
  }

  /**
   * 设备对象。
   *
   * @param {string} device_id 设备 ID。
   * @returns {DeviceObject | null} 设备对象。
   */
  object_of(device_id: string): DeviceObject | null {
    return this.device_objects.get(device_id) || null;
  }

  /**
   * 释放资源。
   *
   * @returns {void}
   */
  dispose(): void {
    cancelAnimationFrame(this.frame_handle);
    this.clear_device_screen_canvas();
    for (const object of this.device_objects.values()) {
      object.dispose();
    }
    this.device_objects.clear();
    this.link_layer.dispose();
    this.wireless_layer.dispose();
    this.environment_texture?.dispose();
    this.environment_texture = null;
    this.renderer.dispose();
  }
}
