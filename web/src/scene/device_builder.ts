/**
 * @File : scene/device_builder.ts
 * @Time : 2026-10-04 13:20
 * @Author : Cetrp
 * @Description : 通用设备三维构建器（任务书 §11）：由 Manifest + 厂商档案生成机箱、端口、LED、
 *               内部电路板、风扇、插头与线缆，实现“换厂商只换数据、不换渲染代码”。
 */
import * as THREE from 'three';

import { utils, DEVICE_STATE, PORT_STATE } from '../core/constants';
import { DeviceLayout } from './layout';
import { SceneTextures } from './textures';
import { FlowLayer } from './flow';
import { get_template, template_cache_key } from '../devices/registry';
import { build_template_device, template_scene_scale } from '../devices/template_device';
import { ensure_templates_loaded } from '../devices/registry';
import type { DeviceRuntime } from '../core/device_runtime';
import type { PortDefinition } from '../data/types';

/** 端口矩阵材质缓存，避免重复生成昂贵的 Canvas 贴图。 */
const TEXTURE_CACHE = new Map();

/** 合并几何体，把大量小零件压缩为单个 Mesh。 */
function merge_geometries(items) {
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  let offset = 0;
  for (const item of items) {
    const geometry = item.geo.clone();
    geometry.applyMatrix4(item.matrix);
    const position = geometry.attributes.position;
    const normal = geometry.attributes.normal;
    const uv = geometry.attributes.uv;
    const index = geometry.index;
    for (let i = 0; i < position.count; i += 1) {
      positions.push(position.getX(i), position.getY(i), position.getZ(i));
      normals.push(normal.getX(i), normal.getY(i), normal.getZ(i));
      uvs.push(uv ? uv.getX(i) : 0, uv ? uv.getY(i) : 0);
    }
    if (index) {
      for (let i = 0; i < index.count; i += 1) {
        indices.push(index.getX(i) + offset);
      }
    } else {
      for (let i = 0; i < position.count; i += 1) {
        indices.push(i + offset);
      }
    }
    offset += position.count;
    geometry.dispose();
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * 构造变换矩阵。
 *
 * @param {number} x X 坐标。
 * @param {number} y Y 坐标。
 * @param {number} z Z 坐标。
 * @param {number} [rx] X 轴旋转。
 * @param {number} [ry] Y 轴旋转。
 * @param {number} [rz] Z 轴旋转。
 * @returns {object} Matrix4。
 */
function trs(x, y, z, rx = 0, ry = 0, rz = 0) {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rx || 0, ry || 0, rz || 0)),
    new THREE.Vector3(1, 1, 1)
  );
}

/**
 * 圆角盒几何体。
 *
 * @param {number} width 宽。
 * @param {number} height 高。
 * @param {number} depth 深。
 * @param {number} radius 圆角半径。
 * @returns {object} BufferGeometry。
 */
function rounded_box(width, height, depth, radius = 0.02) {
  const corner = Math.min(radius || 0.02, width / 2 - 0.001, height / 2 - 0.001, depth / 2 - 0.001);
  const shape = new THREE.Shape();
  const left = -width / 2;
  const bottom = -height / 2;
  shape.moveTo(left + corner, bottom);
  shape.lineTo(left + width - corner, bottom);
  shape.quadraticCurveTo(left + width, bottom, left + width, bottom + corner);
  shape.lineTo(left + width, bottom + height - corner);
  shape.quadraticCurveTo(left + width, bottom + height, left + width - corner, bottom + height);
  shape.lineTo(left + corner, bottom + height);
  shape.quadraticCurveTo(left, bottom + height, left, bottom + height - corner);
  shape.lineTo(left, bottom + corner);
  shape.quadraticCurveTo(left, bottom, left + corner, bottom);
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: Math.max(0.01, depth - 2 * corner),
    bevelEnabled: true,
    bevelSize: corner,
    bevelThickness: corner,
    bevelSegments: 2,
    curveSegments: 4
  });
  geometry.center();
  return geometry;
}

/**
 * 构建并缓存某型号的贴图集合。
 *
 * @param {object} manifest 设备 Manifest。
 * @param {object} vendor_profile 厂商档案。
 * @param {object} layout 面板布局。
 * @param {object} runtime_device 设备运行时（用于序列号与 MAC 丝印）。
 * @returns {object} 贴图集合。
 */
function build_textures(manifest, vendor_profile, layout, runtime_device) {
  const cache_key =
    manifest.model_id + '|' + (runtime_device ? runtime_device.serial_number : 'static');
  if (TEXTURE_CACHE.has(cache_key)) {
    return TEXTURE_CACHE.get(cache_key);
  }
  const brand = vendor_profile.brand || {};
  const silkscreen = (manifest.visual && manifest.visual.silkscreen) || {};
  const is_poe = (manifest.visual.port_layout || []).some((group) => group.poe);
  const textures = {
    brushed: SceneTextures.make_brushed(brand.chassis_color || '#8f9aa6', true),
    rough: SceneTextures.make_brushed_rough(),
    pcb: SceneTextures.make_pcb(brand.pcb_color || '#0c4b2f'),
    top: SceneTextures.make_top({
      brand: brand,
      model_line: silkscreen.brand_line || manifest.product_name || manifest.model_id,
      sub_line: silkscreen.sub_line || manifest.device_class || '',
      serial: runtime_device ? runtime_device.serial_number : 'DEMO-0000',
      mac: runtime_device ? runtime_device.mac_address : '00:1B:44:00:00:00',
      label_text: 'SIMLAB'
    }),
    side: SceneTextures.make_side(brand.chassis_color || '#8f9aa6'),
    back: SceneTextures.make_back(brand.chassis_color || '#8f9aa6', layout.is_rack),
    front: SceneTextures.make_front({
      layout: layout,
      brand: brand,
      manifest: manifest,
      poe: is_poe
    })
  };
  TEXTURE_CACHE.set(cache_key, textures);
  return textures;
}

/**
 * 单个端口的可视对象（含插头、线缆与弹片动画）。
 */
/**
 * 依据端口类型与场景比例给出拾取盒尺寸（场景单位）。
 *
 * @param {string} kind 端口类型（rj45/sfp/sfp_plus/console…）。
 * @param {number} scale 场景比例（场景单位/米）。
 * @returns {{width: number; height: number; depth: number}} 拾取盒尺寸。
 */
function connector_pick_size(kind, scale) {
  const sizes = {
    rj45: [0.0165, 0.015, 0.02],
    sfp: [0.017, 0.013, 0.03],
    sfp_plus: [0.018, 0.014, 0.032],
    console: [0.014, 0.013, 0.018],
    usb: [0.015, 0.009, 0.018]
  };
  const chosen = sizes[kind] || [0.02, 0.02, 0.02];
  const ratio = scale > 0 ? scale : 1;

  return {
    width: chosen[0] * ratio,
    height: chosen[1] * ratio,
    depth: chosen[2] * ratio
  };
}

class PortVisual {
  /** 允许渲染层动态挂载内部状态（类型安全由外部接口成员保证）。 */
  [key: string]: any;

  /** 端口定义。 */
  definition: PortDefinition;

  /** 端口三维分组。 */
  group: THREE.Group;

  /** LED 网格列表。 */
  leds: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>[];

  /** 是否已插入线缆。 */
  plugged: boolean;

  /** 是否光口。 */
  is_optical: boolean;

  /** 插头当前 Z 位置。 */
  plug_z: number;

  /** 线缆网格。 */
  cable: THREE.Mesh | null;

  /**
   * @param {object} options 参数。
   * @param {object} options.definition 端口定义。
   * @param {number} options.x X 坐标。
   * @param {number} options.y Y 坐标。
   * @param {number} options.z Z 坐标（前面板）。
   * @param {object} options.materials 材质集合。
   * @param {boolean} options.dual_led 是否双 LED。
   * @param {number} options.pitch 端口间距（场景单位），用于推导真实比例。
   */
  constructor(options) {
    const definition = options.definition;
    const is_optical = definition.kind === 'sfp' || definition.kind === 'sfp_plus';
    this.definition = definition;
    this.is_optical = is_optical;
    this.hide_socket = options.hide_socket === true;
    this.pick_box = null;
    this.group = new THREE.Group();
    this.group.position.set(options.x, options.y, options.z);
    this.materials = options.materials;
    this.leds = [];
    this.plug_z = is_optical ? 1.25 : 0.82;
    this.plug_from = 0;
    this.plug_to = 0;
    this.plug_t = 1;
    this.animating = false;
    this.plugged = false;
    this.cable = null;
    this.cable_second = null;
    this.cable_offset = utils.rnd(-0.85, 0.85);
    this.blink_phase = utils.rnd(0, 6);

    const port_width = is_optical ? 0.6 : 0.46;
    const port_height = is_optical ? 0.3 : 0.32;
    const port_depth = is_optical ? 0.55 : 0.19;
    this.port_width = port_width;
    this.port_height = port_height;
    this.port_depth = port_depth;

    const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
    const shield_items = [];
    shield_items.push({
      geo: box(port_width, 0.045, port_depth),
      matrix: trs(0, port_height / 2 - 0.022, port_depth / 2 - 0.02)
    });
    shield_items.push({
      geo: box(port_width, 0.045, port_depth),
      matrix: trs(0, -port_height / 2 + 0.022, port_depth / 2 - 0.02)
    });
    shield_items.push({
      geo: box(0.045, port_height, port_depth),
      matrix: trs(-port_width / 2 + 0.022, 0, port_depth / 2 - 0.02)
    });
    shield_items.push({
      geo: box(0.045, port_height, port_depth),
      matrix: trs(port_width / 2 - 0.022, 0, port_depth / 2 - 0.02)
    });
    const frame = 0.03;
    shield_items.push({
      geo: box(port_width + 0.07, frame, 0.03),
      matrix: trs(0, port_height / 2 + frame / 2 - 0.012, 0.015)
    });
    shield_items.push({
      geo: box(port_width + 0.07, frame, 0.03),
      matrix: trs(0, -port_height / 2 - frame / 2 + 0.012, 0.015)
    });

    const dark_items = [];
    const gold_items = [];
    if (!is_optical) {
      dark_items.push({
        geo: box(port_width - 0.08, port_height - 0.07, 0.13),
        matrix: trs(0, 0, 0.055)
      });
      dark_items.push({ geo: box(0.33, 0.055, 0.17), matrix: trs(0, -0.075, 0.07) });
      for (let i = 0; i < 8; i += 1) {
        const pin_x = -0.115 + i * 0.033;
        gold_items.push({
          geo: box(0.016, 0.115, 0.075),
          matrix: trs(pin_x, -0.03, 0.075, -0.16, 0, 0)
        });
        gold_items.push({ geo: box(0.016, 0.03, 0.02), matrix: trs(pin_x, -0.093, 0.052) });
      }
    } else {
      const metal_items = [];
      for (const sx of [-1, 1]) {
        metal_items.push({
          geo: box(0.035, 0.035, port_depth - 0.06),
          matrix: trs(sx * (port_width / 2 - 0.06), -0.06, port_depth / 2)
        });
      }
      metal_items.push({
        geo: box(port_width - 0.06, port_height - 0.06, 0.03),
        matrix: trs(0, 0, port_depth - 0.03)
      });
      this.group.add(new THREE.Mesh(merge_geometries(metal_items), options.materials.metal));
      dark_items.push({
        geo: box(port_width - 0.1, port_height - 0.1, 0.3),
        matrix: trs(0, 0, port_depth - 0.22)
      });
      for (let i = 0; i < 10; i += 1) {
        gold_items.push({
          geo: box(0.014, 0.05, 0.06),
          matrix: trs(-0.18 + i * 0.04, -0.09, port_depth - 0.18)
        });
      }
    }
    this.group.add(new THREE.Mesh(merge_geometries(shield_items), options.materials.shield));
    if (dark_items.length > 0) {
      this.group.add(new THREE.Mesh(merge_geometries(dark_items), options.materials.dark));
    }
    if (gold_items.length > 0) {
      this.group.add(new THREE.Mesh(merge_geometries(gold_items), options.materials.gold));
    }

    /* LED 导光柱：模板设备按真实接口尺寸嵌入边框，避免状态灯悬浮在端口外。 */
    const template_size = this.hide_socket ? options.pick_size : null;
    const led_offset_y = template_size
      ? (options.y > 0 ? -1 : 1) * template_size.height * 0.34
      : options.y > 0
        ? -0.205
        : 0.205;
    const led_offset_x = template_size ? template_size.width * 0.29 : 0.1;
    const led_width = template_size ? Math.max(0.034, template_size.width * 0.13) : 0.085;
    const led_height = template_size ? Math.max(0.022, template_size.height * 0.1) : 0.06;
    const led_depth = template_size ? 0.018 : 0.05;
    const led_positions = options.dual_led
      ? [
          [-led_offset_x, led_offset_y],
          [led_offset_x, led_offset_y]
        ]
      : [[0, led_offset_y + 0.02]];
    const ring_items = [];
    for (const position of led_positions) {
      const led = new THREE.Mesh(
        rounded_box(led_width, led_height, led_depth, led_height * 0.22),
        options.materials.led()
      );
      led.position.set(position[0], position[1], template_size ? 0.012 : 0.045);
      this.group.add(led);
      this.leds.push(led);
      ring_items.push({
        geo: box(led_width * 1.28, led_height * 1.32, template_size ? 0.008 : 0.022),
        matrix: trs(position[0], position[1], template_size ? 0.003 : 0.018)
      });
    }
    this.group.add(new THREE.Mesh(merge_geometries(ring_items), options.materials.dark));

    /* 选中高亮框：包住整个端口，用于面板点击与三维拾取的视觉反馈。 */
    const highlight_geometry = new THREE.EdgesGeometry(
      new THREE.BoxGeometry(port_width + 0.14, port_height + 0.14, port_depth + 0.1)
    );
    this.highlight = new THREE.LineSegments(
      highlight_geometry,
      new THREE.LineBasicMaterial({
        color: options.materials.accent_color || 0x37e0c9,
        transparent: true,
        opacity: 0.95
      })
    );
    this.highlight.position.set(0, 0, port_depth / 2);
    this.highlight.visible = false;
    this.group.add(this.highlight);

    /* 模板设备使用真实插座几何：隐藏程序化插座，仅保留 LED、插头与"紧凑拾取盒"。
       注意：three 的 Raycaster 不跳过不可见对象，因此必须把大尺寸插座盒换成与真实
       接口同尺寸的拾取盒，否则点击机身会被判定为点到端口，导致设备无法选中与拖动。 */
    if (this.hide_socket === true) {
      for (const child of [...this.group.children]) {
        const mesh = child as THREE.Mesh;
        const is_led = (this.leds as THREE.Object3D[]).indexOf(mesh) >= 0;
        if (mesh.isMesh && mesh !== (this.highlight as unknown as THREE.Mesh) && !is_led) {
          mesh.visible = false;
          this.group.remove(mesh);
          mesh.geometry.dispose();
        }
      }
      const size = options.pick_size || { width: 0.06, height: 0.05, depth: 0.06 };
      const pick_box = new THREE.Mesh(
        new THREE.BoxGeometry(size.width, size.height, size.depth),
        new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false })
      );
      pick_box.position.set(0, 0, size.depth / 2);
      pick_box.name = 'port_pick_box';
      this.pick_box = pick_box;
      this.group.add(pick_box);
    }

    this._build_connector();
  }

  /**
   * 把端口可视对象对齐到模板锚点（真实接口位置与朝向）。
   *
   * @param {THREE.Vector3} position 场景坐标下的锚点位置（设备局部坐标）。
   * @param {THREE.Vector3} direction 锚点朝向（设备局部坐标）。
   * @returns {void}
   */
  align_to(position: THREE.Vector3, direction: THREE.Vector3): void {
    this.group.position.copy(position);
    const normalized_direction = direction.clone().normalize();
    /* PortVisual 是设备组的子对象，position/direction 都是设备局部坐标。
       lookAt(target) 把 target 当世界坐标，PC 背面网口及非原点设备会因此错转；
       直接设置局部旋转，保证插头和线缆始终沿实际接口法线插入。 */
    this.group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normalized_direction);
    this.group.userData.anchor_direction = normalized_direction;
  }

  /**
   * 构建插头（网线水晶头）或光模块。
   *
   * @returns {void}
   * @private
   */
  _build_connector() {
    const materials = this.materials;
    if (!this.is_optical) {
      const plug = new THREE.Group();
      const body = new THREE.Mesh(
        rounded_box(this.port_width * 0.92, this.port_height * 0.86, 0.52, 0.028),
        materials.plug
      );
      body.position.z = 0.26;
      plug.add(body);
      const contact_items = [];
      const contact_pitch = this.port_width * 0.088;
      for (let i = 0; i < 8; i += 1) {
        contact_items.push({
          geo: new THREE.BoxGeometry(0.016, this.port_height * 0.28, 0.03),
          matrix: trs(-contact_pitch * 3.5 + i * contact_pitch, this.port_height * 0.16, 0.055)
        });
      }
      plug.add(new THREE.Mesh(merge_geometries(contact_items), materials.gold));
      const latch_pivot = new THREE.Group();
      latch_pivot.position.set(0, 0.115, 0.36);
      plug.add(latch_pivot);
      const latch_geometry = merge_geometries([
        { geo: rounded_box(0.17, 0.038, 0.34, 0.014), matrix: trs(0, 0, -0.17) },
        { geo: new THREE.BoxGeometry(0.17, 0.028, 0.05), matrix: trs(0, -0.03, -0.32) }
      ]);
      latch_pivot.add(new THREE.Mesh(latch_geometry, materials.plug_dark));
      this.latch = latch_pivot;
      const boot = new THREE.Mesh(
        new THREE.CylinderGeometry(0.075, 0.115, 0.3, 14),
        materials.plug_dark
      );
      boot.rotation.x = Math.PI / 2;
      boot.position.z = 0.66;
      plug.add(boot);
      const tag = new THREE.Mesh(new THREE.TorusGeometry(0.095, 0.022, 8, 16), materials.label);
      tag.position.z = 0.86;
      plug.add(tag);
      plug.visible = false;
      this.group.add(plug);
      this.connector = plug;
    } else {
      const module = new THREE.Group();
      const body = new THREE.Mesh(rounded_box(0.5, 0.24, 0.92, 0.03), materials.metal);
      body.position.z = 0.46;
      module.add(body);
      const edge = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.02, 0.16), materials.edge_gold);
      edge.position.set(0, -0.11, 0.06);
      module.add(edge);
      const bail = new THREE.Group();
      bail.position.set(0, 0, 1.0);
      module.add(bail);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.075, 0.017, 8, 20), materials.gold);
      ring.position.z = 0.06;
      bail.add(ring);
      for (const offset of [-0.07, 0.07]) {
        const arm = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.02, 0.13), materials.gold);
        arm.position.set(offset, 0, 0);
        bail.add(arm);
      }
      const label = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.13, 0.01), materials.module_label);
      label.position.set(0, 0.02, 0.98);
      module.add(label);
      module.visible = false;
      this.group.add(module);
      this.connector = module;
    }
  }

  /**
   * 设置选中高亮。
   *
   * @param {boolean} selected 是否选中。
   * @returns {void}
   */
  set_selected(selected) {
    if (this.highlight) {
      this.highlight.visible = Boolean(selected);
    }
  }

  /**
   * 端口全部可拾取网格。
   *
   * @returns {object[]} Mesh 数组。
   */
  pickable_meshes() {
    /* 模板设备：拾取只用紧凑拾取盒 + LED，保证机身点击不被端口抢占。 */
    if (this.hide_socket === true && this.pick_box) {
      return [this.pick_box, ...this.leds];
    }
    const meshes = [];
    this.group.traverse((object) => {
      if ((object as THREE.Mesh).isMesh && object !== this.connector) {
        meshes.push(object);
      }
    });
    return meshes;
  }

  /**
   * 播放插拔动画。
   *
   * @param {boolean} plugged 目标状态。
   * @param {number} [duration] 动画时长（秒）。
   * @returns {void}
   */
  set_plugged(plugged, duration = 0.6) {
    this.plugged = plugged;
    this.plug_from = this.plug_z;
    this.plug_to = plugged ? (this.is_optical ? 0.1 : -0.16) : this.is_optical ? 1.25 : 0.82;
    this.plug_t = 0;
    this.plug_duration = duration || (plugged ? 0.62 : 0.42);
    this.animating = true;
    if (plugged) {
      this.connector.visible = true;
    } else {
      this.connector.visible = true;
    }
  }

  /**
   * 推进插拔动画与线缆曲线。
   *
   * @param {number} delta_seconds 时间增量。
   * @param {number} ground_y 地面 Y 坐标（局部坐标）。
   * @param {number} trough_z 线槽 Z 坐标（局部坐标）。
   * @returns {void}
   */
  update(delta_seconds, ground_y, trough_z) {
    if (this.animating) {
      this.plug_t = Math.min(1, this.plug_t + delta_seconds / this.plug_duration);
      const eased = 1 - Math.pow(1 - this.plug_t, 3);
      this.plug_z = utils.lerp(
        this.plug_from,
        this.plug_to,
        this.plugged ? eased : this.plug_t * 0.6
      );
      if (this.latch) {
        const press = utils.clamp(1 - Math.abs(this.plug_z + 0.09) * 16, 0, 1);
        this.latch.rotation.x = utils.lerp(this.latch.rotation.x, 0.34 - press * 0.32, 0.28);
      }
      this.connector.position.z = this.plug_z;
      if (this.cable) {
        this._rebuild_cable(ground_y, trough_z);
      }
      if (this.plug_t >= 1) {
        this.animating = false;
        if (!this.plugged) {
          this.connector.visible = false;
          this.dispose_cable();
        }
      }
    }
  }

  /**
   * 建立线缆。
   *
   * @param {number} ground_y 地面 Y（局部坐标）。
   * @param {number} trough_z 线槽 Z（局部坐标）。
   * @returns {void}
   */
  build_cable(ground_y, trough_z) {
    const is_optical = this.is_optical;
    const tail_z = is_optical ? this.plug_z + 1.1 : this.plug_z + 0.9;
    const make_geometry = (offset_x) => {
      const tail = this.cable_tail(is_optical, tail_z);
      const points = tail.map((point) => new THREE.Vector3(point.x + offset_x, point.y, point.z));
      const curve = new THREE.CatmullRomCurve3(points);
      return new THREE.TubeGeometry(curve, 34, is_optical ? 0.031 : 0.048, 7, false);
    };
    const material = is_optical ? this.materials.fiber : this.materials.cable;
    if (this.cable) {
      this.cable.geometry.dispose();
      this.cable.geometry = make_geometry(0);
    } else {
      this.cable = new THREE.Mesh(make_geometry(0), material);
      this.cable.castShadow = !is_optical;
      this.group.add(this.cable);
    }
    if (is_optical) {
      if (this.cable_second) {
        this.cable_second.geometry.dispose();
        this.cable_second.geometry = make_geometry(0.075);
      } else {
        this.cable_second = new THREE.Mesh(make_geometry(0.075), material);
        this.cable_second.castShadow = true;
        this.group.add(this.cable_second);
      }
    }
    this._ground_y = ground_y;
    this._trough_z = trough_z;
  }

  /**
   * 计算线缆尾部控制点。
   *
   * @param {boolean} is_optical 是否光口。
   * @param {number} tail_z 插头尾部 Z。
   * @returns {object[]} 控制点数组。
   * @private
   */
  cable_tail(is_optical, tail_z) {
    const base_y = this.group.position.y;
    const ground_y = this._ground_y !== undefined ? this._ground_y : -1.5 - base_y;
    const trough_z = this._trough_z !== undefined ? this._trough_z : 3.35;
    const drift = this.cable_offset;
    const end_x = this.group.position.x * 0.3 + drift * 0.9 - this.group.position.x;
    return [
      new THREE.Vector3(drift * 0.05, -0.01, tail_z),
      new THREE.Vector3(drift * 0.18, -0.05, Math.max(tail_z + 0.35, tail_z * 0.6 + 1.0)),
      new THREE.Vector3(drift * 0.55, -0.55, tail_z + 0.75),
      new THREE.Vector3(drift * 0.9, ground_y + 0.35, (tail_z + trough_z) / 2),
      new THREE.Vector3(end_x, ground_y + 0.06, trough_z - 0.55),
      new THREE.Vector3(end_x, ground_y, trough_z)
    ];
  }

  /**
   * 重建线缆几何（插拔过程中）。
   *
   * @param {number} ground_y 地面 Y。
   * @param {number} trough_z 线槽 Z。
   * @returns {void}
   * @private
   */
  _rebuild_cable(ground_y, trough_z) {
    this._ground_y = ground_y;
    this._trough_z = trough_z;
    if (!this.cable) {
      return;
    }
    const is_optical = this.is_optical;
    const tail_z = is_optical ? this.plug_z + 1.1 : this.plug_z + 0.9;
    const tail = this.cable_tail(is_optical, tail_z);
    const geometry = new THREE.TubeGeometry(
      new THREE.CatmullRomCurve3(tail),
      34,
      is_optical ? 0.031 : 0.048,
      7,
      false
    );
    this.cable.geometry.dispose();
    this.cable.geometry = geometry;
    if (this.cable_second) {
      const shifted = tail.map((point) => new THREE.Vector3(point.x + 0.075, point.y, point.z));
      this.cable_second.geometry.dispose();
      this.cable_second.geometry = new THREE.TubeGeometry(
        new THREE.CatmullRomCurve3(shifted),
        34,
        0.031,
        7,
        false
      );
    }
  }

  /**
   * 拆除线缆。
   *
   * @returns {void}
   */
  dispose_cable() {
    for (const mesh of [this.cable, this.cable_second]) {
      if (mesh) {
        this.group.remove(mesh);
        mesh.geometry.dispose();
      }
    }
    this.cable = null;
    this.cable_second = null;
  }
}

/**
 * 设备三维对象。
 */
class DeviceObject {
  /** 允许渲染层动态挂载内部状态（类型安全由外部接口成员保证）。 */
  [key: string]: any;

  /** 设备三维分组。 */
  group: THREE.Group;

  /** 面板布局。 */
  layout: ReturnType<typeof DeviceLayout.compute_layout>;

  /** 端口可视对象。 */
  port_visuals: PortVisual[];

  /** 运行时设备（供 LED 与插头同步）。 */
  runtime_device: DeviceRuntime | null;

  /** 外壳网格。 */
  shell: THREE.Mesh;

  /**
   * @param {object} options 参数。
   * @param {object} options.manifest 设备 Manifest。
   * @param {object} options.vendor_profile 厂商档案。
   * @param {object} [options.runtime_device] 设备运行时（用于丝印与状态同步）。
   */
  constructor(options) {
    this.manifest = options.manifest;
    this.vendor_profile = options.vendor_profile;
    this.runtime_device = options.runtime_device || null;
    this.layout = DeviceLayout.compute_layout(options.manifest);
    this.group = new THREE.Group();
    this.port_visuals = [];
    this.explode_parts = [];
    this.mode = 'shell';
    this.power_on = false;
    this.self_test = 0;
    this.trough_offset = 3.35;
    /** 地面线槽的世界 Z 坐标（见 scene_root 中线槽位置）。 */
    this.trough_world_z = 5.6;

    this._build_materials();
    /* 有设备模板时按模板装配（真实机箱/面板/接口），否则回落到程序化外壳。 */
    this.template_build = null;
    this.template_scale = 0;
    this.port_anchors = new Map();
    const has_template = this._build_from_template();
    if (!has_template) {
      this._build_shell();
    }
    /* 线缆端头按各自设备真实模型比例缩放，避免 PC 与机架交换机混接时端头过大/过小。 */
    this.group.userData.connector_scene_scale = this.template_scale || this.layout.scale * 10;
    this._build_ports();
    /* 模板面板自带按键与指示灯：只保留电源键与系统 LED 状态，不再叠加程序化控制区。 */
    this._build_controls(has_template);
    this._build_interior();

    /* 设备内部转发路径图层（透视 / 爆炸视图下显示，由 set_flow_visible 控制）。 */
    this.flow_layer = new FlowLayer({
      device_object: this as unknown as { layout: unknown },
      runtime_device: this.runtime_device
    });
    this.flow_layer.set_visible(false);
    this.group.add(this.flow_layer.group);
  }

  /**
   * 显示 / 隐藏设备内部转发路径。
   *
   * @param {boolean} visible 是否可见。
   * @returns {void}
   */
  set_flow_visible(visible: boolean): void {
    if (this.flow_layer) {
      this.flow_layer.set_visible(Boolean(visible));
    }
  }

  /**
   * 按设备模板装配机箱与端口（返回 false 表示无模板，需回落程序化外壳）。
   *
   * @returns {boolean} 是否已用模板装配。
   * @private
   */
  _build_from_template() {
    const template = get_template(this.manifest.model_id);
    if (!template) {
      return false;
    }
    /* 模板尺寸是米制，必须用模板自身比例（不能复用 DeviceLayout 的口径）。 */
    const template_scale = template_scene_scale(template);
    const build = build_template_device(template, { scale: template_scale });
    this.template_build = build;
    this.template_scale = template_scale;
    this.group.userData.connector_scene_scale = template_scale;
    this.internal_group = build.internal_group;
    this.group.add(build.group);
    this.shell = build.shell;
    /* 透视/爆炸模式需要切换机箱材质：模板设备不经过 _build_shell，
       这里登记"原始材质"（可能是单材质，也可能是按面分组的数组），
       并在 set_mode 里按几何分组数展开，避免 material[groupIndex] 越界。 */
    this.shell_material_original = build.shell.material;
    this.template_cache_key = template_cache_key(template.model_id);
    /* 模板面板自带电源键：直接作为可点击对象（左键点击开关机）。 */
    if (build.power_button) {
      this.power_button = build.power_button;
      this.power_button.userData.power_button = true;
      this.power_button_material_off = new THREE.MeshStandardMaterial({
        color: '#2c333c',
        metalness: 0.4,
        roughness: 0.5
      });
      this.power_button_material_on = new THREE.MeshStandardMaterial({
        color: '#2bff9a',
        emissive: new THREE.Color('#2bff9a'),
        emissiveIntensity: 1.1,
        metalness: 0.3,
        roughness: 0.4
      });
    }
    /* 模板 LED 直接接入运行态：关机熄灭、启动呈琥珀色、运行后绿色呼吸。 */
    const led_mesh = (object: THREE.Object3D): THREE.Mesh | null => {
      let result: THREE.Mesh | null = null;
      object.traverse((child) => {
        const mesh = child as THREE.Mesh;
        const material = mesh.material as THREE.MeshStandardMaterial | undefined;
        if (!result && mesh.isMesh && material?.isMeshStandardMaterial && material.emissive) {
          result = mesh;
        }
      });

      return result;
    };
    for (const led of build.leds) {
      const mesh = led_mesh(led.object);
      if (!mesh) {
        continue;
      }
      const name = led.name.toUpperCase();
      if (!this.system_led && (name.includes('SYS') || name.includes('STATUS'))) {
        this.system_led = mesh;
      }
      if (!this.power_led && (name.includes('PWR') || name.includes('POWER'))) {
        this.power_led = mesh;
      }
    }
    /* 模板机箱以底面贴 y=0，程序化设备以中心为原点：把模板组上移半个机箱高对齐。 */
    build.group.position.y = (template.dimensions.height * template_scale) / 2;
    for (const anchor of build.anchors) {
      /* 锚点必须与几何一起平移：否则线缆插头会整体偏低半个机箱高，
         看起来"没插进接口"（ONU 低 0.32、1U 交换机低 0.44 场景单位）。 */
      anchor.position.add(build.group.position);
      this.port_anchors.set(anchor.short_name, anchor);
    }

    return true;
  }

  /**
   * 原地重建模板几何（工坊保存后主场景刷新）。
   *
   * 保留设备位置、电源状态与选中态，只替换机箱/面板/端口几何。
   *
   * @returns {boolean} 是否重建成功（无模板时为 false）。
   */
  rebuild_template() {
    const template = get_template(this.manifest.model_id);
    if (!template) {
      return false;
    }
    /* ① 释放旧模板几何与旧端口可视对象。 */
    if (this.template_build && this.template_build.group) {
      this.group.remove(this.template_build.group);
      this.template_build.group.traverse((object) => {
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
    }
    for (const visual of this.port_visuals) {
      this.group.remove(visual.group);
      visual.dispose_cable();
    }
    this.port_visuals = [];
    this.port_anchors = new Map();
    this.template_build = null;
    /* ② 重新装配。 */
    if (!this._build_from_template()) {
      return false;
    }
    this.group.userData.connector_scene_scale = this.template_scale || this.layout.scale * 10;
    this._build_ports();
    this.set_mode(this.mode || 'shell');
    this.set_power(this.power_on);

    return true;
  }

  /**
   * 取端口在设备局部坐标下的锚点（模板设备返回真实接口位置）。
   *
   * @param {string} short_name 端口短名。
   * @returns {object | null} 锚点；无模板或端口不存在时为 null。
   */
  anchor_for(short_name) {
    return this.port_anchors.get(short_name) || null;
  }

  /**
   * 构建材质集合。
   *
   * @returns {void}
   * @private
   */
  _build_materials() {
    const brand = this.vendor_profile.brand || {};
    const textures = build_textures(
      this.manifest,
      this.vendor_profile,
      this.layout,
      this.runtime_device
    );
    this.textures = textures;
    const chassis_color = brand.chassis_color || '#8f9aa6';
    this.materials = {
      shell: new THREE.MeshStandardMaterial({
        color: chassis_color,
        map: textures.brushed,
        roughnessMap: textures.rough,
        metalness: 0.92,
        roughness: 0.42
      }),
      side: new THREE.MeshStandardMaterial({
        map: textures.side,
        color: 0xffffff,
        metalness: 0.9,
        roughness: 0.45
      }),
      top: new THREE.MeshStandardMaterial({
        map: textures.top,
        color: 0xffffff,
        metalness: 0.86,
        roughness: 0.4
      }),
      front: new THREE.MeshStandardMaterial({
        map: textures.front,
        color: 0xffffff,
        metalness: 0.72,
        roughness: 0.46
      }),
      back: new THREE.MeshStandardMaterial({
        map: textures.back,
        color: 0xffffff,
        metalness: 0.82,
        roughness: 0.44
      }),
      bottom: new THREE.MeshStandardMaterial({ color: 0x2a3038, metalness: 0.7, roughness: 0.6 }),
      edge: new THREE.MeshStandardMaterial({ color: 0xdfe7ef, metalness: 1, roughness: 0.16 }),
      dark: new THREE.MeshStandardMaterial({ color: 0x090b0e, metalness: 0.35, roughness: 0.78 }),
      metal: new THREE.MeshStandardMaterial({
        color: 0xc2ccd6,
        metalness: 0.96,
        roughness: 0.24
      }),
      gold: new THREE.MeshStandardMaterial({ color: 0xe0ad4a, metalness: 1, roughness: 0.26 }),
      edge_gold: new THREE.MeshStandardMaterial({
        color: 0xc8a24a,
        metalness: 1,
        roughness: 0.3
      }),
      shield: new THREE.MeshStandardMaterial({ color: 0xd7dfe8, metalness: 1, roughness: 0.2 }),
      pcb: new THREE.MeshStandardMaterial({
        map: textures.pcb,
        color: 0xffffff,
        metalness: 0.32,
        roughness: 0.62
      }),
      chip: new THREE.MeshStandardMaterial({ color: 0x111318, metalness: 0.62, roughness: 0.46 }),
      sink: new THREE.MeshStandardMaterial({ color: 0xb7c1cc, metalness: 0.92, roughness: 0.3 }),
      psu: new THREE.MeshStandardMaterial({ color: 0x9aa5b1, metalness: 0.88, roughness: 0.34 }),
      cap: new THREE.MeshStandardMaterial({ color: 0x232a34, metalness: 0.55, roughness: 0.45 }),
      fan_frame: new THREE.MeshStandardMaterial({
        color: 0x161a1f,
        metalness: 0.6,
        roughness: 0.6
      }),
      fan_blade: new THREE.MeshStandardMaterial({
        color: 0x3a4049,
        metalness: 0.4,
        roughness: 0.6
      }),
      plug: new THREE.MeshStandardMaterial({
        color: 0x9fd0ff,
        metalness: 0.12,
        roughness: 0.22,
        transparent: true,
        opacity: 0.55
      }),
      plug_dark: new THREE.MeshStandardMaterial({
        color: 0x2f3944,
        metalness: 0.35,
        roughness: 0.55
      }),
      label: new THREE.MeshStandardMaterial({ color: 0xe8e2d0, roughness: 0.7, metalness: 0.05 }),
      fiber: new THREE.MeshStandardMaterial({
        color: 0xf7c73f,
        roughness: 0.35,
        metalness: 0.05
      }),
      cable: new THREE.MeshStandardMaterial({
        color: brand.cable_color !== undefined ? brand.cable_color : 0x3f8ee0,
        roughness: 0.5,
        metalness: 0.06
      }),
      module_label: new THREE.MeshStandardMaterial({
        color: 0x2b7fd0,
        roughness: 0.6,
        metalness: 0.1
      }),
      led: () =>
        new THREE.MeshStandardMaterial({
          color: 0x1a2028,
          emissive: 0x000000,
          emissiveIntensity: 0,
          roughness: 0.28,
          metalness: 0.05,
          transparent: true,
          opacity: 0.92
        })
    };
  }

  /**
   * 构建机箱、耳朵、脚垫与背面立体件。
   *
   * @returns {void}
   * @private
   */
  _build_shell() {
    const layout = this.layout;
    const materials = this.materials;
    const face_materials = [
      materials.side,
      materials.side,
      materials.top,
      materials.bottom,
      materials.front,
      materials.back
    ];
    this.shell = new THREE.Mesh(
      new THREE.BoxGeometry(layout.width, layout.height, layout.depth),
      face_materials
    );
    this.shell.castShadow = true;
    this.shell.receiveShadow = true;
    this.group.add(this.shell);
    this.shell_materials = face_materials;
    this.shell_material_original = face_materials;

    /* 边缘倒角高光。 */
    const radius = 0.035;
    const edge_items = [];
    const rod_h = new THREE.CylinderGeometry(radius, radius, layout.width, 8);
    const rod_v = new THREE.CylinderGeometry(radius, radius, layout.height, 8);
    const rod_d = new THREE.CylinderGeometry(radius, radius, layout.depth, 8);
    for (const z of [layout.front_z, -layout.front_z]) {
      for (const y of [layout.height / 2, -layout.height / 2]) {
        edge_items.push({ geo: rod_h, matrix: trs(0, y, z, 0, 0, Math.PI / 2) });
      }
      for (const x of [layout.width / 2, -layout.width / 2]) {
        edge_items.push({ geo: rod_v, matrix: trs(x, 0, z) });
      }
    }
    for (const x of [layout.width / 2, -layout.width / 2]) {
      for (const y of [layout.height / 2, -layout.height / 2]) {
        edge_items.push({ geo: rod_d, matrix: trs(x, y, 0, Math.PI / 2, 0, 0) });
      }
    }
    this.group.add(new THREE.Mesh(merge_geometries(edge_items), materials.edge));

    if (layout.is_rack) {
      /* 机架耳朵与螺钉。 */
      for (const sign of [-1, 1]) {
        const ear = new THREE.Mesh(
          rounded_box(0.5, layout.height * 1.32, 0.13, 0.03),
          materials.shell
        );
        ear.position.set(sign * (layout.width / 2 + 0.22), 0, layout.front_z - 0.35);
        ear.castShadow = true;
        this.group.add(ear);
        for (const offset_y of [layout.height * 0.42, -layout.height * 0.42]) {
          const hole = new THREE.Mesh(
            new THREE.CylinderGeometry(0.1, 0.1, 0.03, 14),
            materials.dark
          );
          hole.rotation.x = Math.PI / 2;
          hole.position.set(sign * (layout.width / 2 + 0.22), offset_y, layout.front_z - 0.29);
          this.group.add(hole);
          const screw = new THREE.Mesh(
            new THREE.CylinderGeometry(0.08, 0.08, 0.09, 14),
            materials.metal
          );
          screw.rotation.x = Math.PI / 2;
          screw.position.set(sign * (layout.width / 2 + 0.22), offset_y, layout.front_z - 0.27);
          this.group.add(screw);
        }
      }
    }

    /* 脚垫。 */
    for (const sign_x of [-1, 1]) {
      for (const sign_z of [1, -1]) {
        const foot = new THREE.Mesh(
          new THREE.CylinderGeometry(0.13, 0.15, 0.07, 16),
          materials.dark
        );
        foot.position.set(
          sign_x * (layout.width / 2 - 0.4),
          -layout.height / 2 - 0.03,
          sign_z * (layout.depth / 2 - 0.4)
        );
        this.group.add(foot);
      }
    }

    /* 背面电源插座。 */
    const socket = new THREE.Mesh(rounded_box(0.95, 0.78, 0.16, 0.02), materials.dark);
    socket.position.set(layout.width * 0.3, 0.02, -layout.front_z - 0.05);
    this.group.add(socket);
    const pin_items = [];
    for (const offset of [-0.22, 0.22]) {
      pin_items.push({
        geo: new THREE.BoxGeometry(0.15, 0.12, 0.11),
        matrix: trs(layout.width * 0.3 + offset, 0.22, -layout.front_z - 0.13)
      });
    }
    this.group.add(new THREE.Mesh(merge_geometries(pin_items), materials.metal));
  }

  /**
   * 构建全部端口。
   *
   * @returns {void}
   * @private
   */
  _build_ports() {
    const dual_led = ((this.manifest.visual.leds || {}).per_port || 2) >= 2;
    const has_template = Boolean(this.template_build);
    const layout_by_name = new Map(this.layout.ports.map((entry) => [entry.port.short_name, entry]));
    const definitions: PortDefinition[] = has_template && this.runtime_device?.ports?.length
      ? this.runtime_device.ports
      : this.layout.ports.map((entry) => entry.port);
    for (const definition of definitions) {
      const anchor = has_template ? this.port_anchors.get(definition.short_name) : null;
      /* 模板端口只能从实际插座锚点拾取，避免旧 Manifest 位置落到 PC 键盘等附件上。 */
      if (has_template && !anchor) {
        continue;
      }
      const entry = layout_by_name.get(definition.short_name);
      const visual = new PortVisual({
        definition: definition,
        x: entry?.x || 0,
        y: entry?.y || 0,
        z: this.layout.front_z,
        materials: this.materials,
        dual_led: dual_led,
        pitch: this.layout.pitch,
        /* 模板设备：插座几何由模板提供，PortVisual 只保留 LED、插头与紧凑拾取盒。 */
        hide_socket: has_template,
        pick_size: has_template
          ? connector_pick_size(definition.kind, this.template_scale || this.layout.scale)
          : null
      });
      visual.group.userData.port_definition = definition;
      if (anchor) {
        visual.align_to(anchor.position, anchor.direction);
      }
      this.group.add(visual.group);
      this.port_visuals.push(visual);
    }
  }

  /**
   * 构建电源键、系统 LED 与 Console / USB 接口。
   *
   * @returns {void}
   * @private
   */
  _build_controls(skip_geometry = false) {
    if (skip_geometry) {
      /* 模板设备：控制区几何由模板提供，这里只登记系统 LED（供运行状态闪烁）。 */
      const leds = new THREE.Group();
      this.group.add(leds);
      this.controls_group = leds;
      if (!this.power_button) {
        this.power_button = null;
      }
      return;
    }
    const layout = this.layout;
    const materials = this.materials;
    const front_panel = this.manifest.visual.front_panel || {};
    const controls = new THREE.Group();
    this.group.add(controls);
    this.controls = controls;

    const left_edge = -layout.width / 2;
    if (front_panel.power_button !== false) {
      this.power_button_material_on = new THREE.MeshStandardMaterial({
        color: 0xc0392b,
        metalness: 0.5,
        roughness: 0.4,
        emissive: 0xff2a1a,
        emissiveIntensity: 0.7
      });
      this.power_button_material_off = new THREE.MeshStandardMaterial({
        color: 0x4a1a13,
        metalness: 0.5,
        roughness: 0.5,
        emissive: 0x000000,
        emissiveIntensity: 0
      });
      const button = new THREE.Mesh(
        new THREE.CylinderGeometry(0.115, 0.115, 0.1, 24),
        this.power_button_material_on
      );
      button.rotation.x = Math.PI / 2;
      button.position.set(left_edge + 0.3, 0, layout.front_z + 0.05);
      button.userData.power_button = true;
      controls.add(button);
      this.power_button = button;
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.14, 0.016, 8, 24), materials.metal);
      ring.position.set(left_edge + 0.3, 0, layout.front_z + 0.03);
      controls.add(ring);
    }

    const led_y = layout.height * 0.26;
    this.system_led = new THREE.Mesh(rounded_box(0.08, 0.055, 0.05, 0.012), materials.led());
    this.system_led.position.set(left_edge + 0.72, led_y, layout.front_z + 0.045);
    controls.add(this.system_led);
    this.power_led = new THREE.Mesh(rounded_box(0.08, 0.055, 0.05, 0.012), materials.led());
    this.power_led.position.set(left_edge + 0.72, -layout.height * 0.05, layout.front_z + 0.045);
    controls.add(this.power_led);

    if (front_panel.usb) {
      const usb_shell = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.11, 0.12), materials.dark);
      usb_shell.position.set(left_edge + 0.95, -layout.height * 0.3, layout.front_z + 0.05);
      controls.add(usb_shell);
    }
    if (front_panel.console) {
      const console_shell = new THREE.Mesh(
        new THREE.BoxGeometry(0.34, 0.26, 0.14),
        materials.shield
      );
      console_shell.position.set(left_edge + 0.46, -layout.height * 0.3, layout.front_z + 0.06);
      controls.add(console_shell);
      const console_inner = new THREE.Mesh(new THREE.BoxGeometry(0.23, 0.15, 0.1), materials.dark);
      console_inner.position.set(left_edge + 0.46, -layout.height * 0.3, layout.front_z + 0.08);
      controls.add(console_inner);
    }
  }

  /**
   * 构建内部构造（透视 / 爆炸图可见）。
   *
   * @returns {void}
   * @private
   */
  _build_interior() {
    const layout = this.layout;
    const materials = this.materials;
    const interior = new THREE.Group();
    interior.visible = false;
    this.group.add(interior);
    this.interior = interior;

    const register_part = (object, explode_target) => {
      object.userData.base_position = object.position.clone();
      object.userData.explode_target = explode_target.clone();
      object.userData.explode_want = 0;
      this.explode_parts.push(object);
      interior.add(object);
      return object;
    };

    const max_columns = layout.column_count;
    const pcb_width = layout.width - 0.5;
    const pcb_depth = layout.depth - 0.5;
    const pcb = new THREE.Mesh(new THREE.BoxGeometry(pcb_width, 0.07, pcb_depth), materials.pcb);
    pcb.position.set(0, -layout.height * 0.32, -0.05);
    pcb.castShadow = true;
    pcb.receiveShadow = true;
    register_part(pcb, new THREE.Vector3(0, layout.height * 0.5, -0.05));

    /* PHY 芯片阵列。 */
    const phy_count = Math.max(2, Math.round(max_columns / 6));
    const phy_items = [];
    for (let i = 0; i < phy_count; i += 1) {
      const x = -pcb_width / 2 + 0.6 + (i * (pcb_width - 1.2)) / Math.max(1, phy_count - 1);
      phy_items.push({
        geo: rounded_box(0.55, 0.08, 0.55, 0.015),
        matrix: trs(x, -layout.height * 0.27, layout.depth * 0.22)
      });
    }
    const phy_mesh = new THREE.Mesh(merge_geometries(phy_items), materials.chip);
    register_part(phy_mesh, new THREE.Vector3(0, layout.height * 0.75, layout.depth * 0.22));

    /* 交换芯片与散热片。 */
    const asic = new THREE.Mesh(rounded_box(1.35, 0.12, 1.35, 0.02), materials.chip);
    asic.position.set(layout.width * 0.1, -layout.height * 0.24, -0.2);
    register_part(asic, new THREE.Vector3(layout.width * 0.1, layout.height * 1.1, -0.2));
    const fin_items = [];
    for (let i = 0; i < 12; i += 1) {
      fin_items.push({
        geo: new THREE.BoxGeometry(1.15, 0.3, 0.04),
        matrix: trs(layout.width * 0.1, -layout.height * 0.1, -0.2 - 0.6 + i * 0.108)
      });
    }
    const fins = new THREE.Mesh(merge_geometries(fin_items), materials.sink);
    fins.castShadow = true;
    register_part(fins, new THREE.Vector3(layout.width * 0.1, layout.height * 1.25, -0.2));

    /* 内存颗粒与电源模块。 */
    const memory_items = [];
    for (const offset_z of [-layout.depth * 0.34, layout.depth * 0.3]) {
      for (const offset_x of [-layout.width * 0.22, -layout.width * 0.05]) {
        memory_items.push({
          geo: rounded_box(0.9, 0.05, 0.18, 0.008),
          matrix: trs(offset_x, -layout.height * 0.29, offset_z)
        });
      }
    }
    register_part(
      new THREE.Mesh(merge_geometries(memory_items), materials.chip),
      new THREE.Vector3(0, layout.height * 0.85, -layout.depth * 0.34)
    );

    const psu = new THREE.Mesh(
      rounded_box(layout.width * 0.26, layout.height * 0.62, layout.depth * 0.7, 0.04),
      materials.psu
    );
    psu.position.set(-layout.width * 0.34, -layout.height * 0.02, -layout.depth * 0.12);
    psu.castShadow = true;
    register_part(
      psu,
      new THREE.Vector3(-layout.width * 0.34, layout.height * 0.9, -layout.depth * 0.9)
    );

    /* 电容与贴片元件。 */
    const capacitor_items = [];
    const capacitor_count = Math.max(6, Math.round(max_columns * 0.5));
    for (let i = 0; i < capacitor_count; i += 1) {
      capacitor_items.push({
        geo: new THREE.CylinderGeometry(0.065, 0.065, 0.2, 12),
        matrix: trs(-layout.width * 0.4 + i * 0.3, -layout.height * 0.2, utils.rnd(-0.6, 0.6))
      });
    }
    register_part(
      new THREE.Mesh(merge_geometries(capacitor_items), materials.cap),
      new THREE.Vector3(0, layout.height * 0.7, -layout.depth * 0.1)
    );

    const smd_items = [];
    for (let i = 0; i < 34; i += 1) {
      smd_items.push({
        geo: new THREE.BoxGeometry(0.05, 0.026, 0.026),
        matrix: trs(
          utils.rnd(-layout.width * 0.45, layout.width * 0.45),
          -layout.height * 0.3,
          utils.rnd(-layout.depth * 0.4, layout.depth * 0.4)
        )
      });
    }
    register_part(
      new THREE.Mesh(merge_geometries(smd_items), materials.chip),
      new THREE.Vector3(0, layout.height * 0.6, 0)
    );

    /* 风扇。 */
    this.fans = [];
    const fan_count = layout.is_rack ? 3 : 1;
    for (let i = 0; i < fan_count; i += 1) {
      const fan_group = new THREE.Group();
      const fan_x =
        fan_count === 1 ? layout.width * 0.18 : -layout.width * 0.26 + i * (layout.width * 0.26);
      fan_group.position.set(fan_x, -layout.height * 0.02, -layout.depth * 0.42);
      const frame = new THREE.Mesh(rounded_box(0.9, 0.9, 0.3, 0.05), materials.fan_frame);
      fan_group.add(frame);
      const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.13, 16), materials.dark);
      hub.rotation.x = Math.PI / 2;
      fan_group.add(hub);
      const blades = new THREE.Group();
      const blade_items = [];
      for (let b = 0; b < 7; b += 1) {
        blade_items.push({
          geo: new THREE.BoxGeometry(0.34, 0.08, 0.03),
          matrix: trs(
            Math.cos((b / 7) * 6.283) * 0.22,
            Math.sin((b / 7) * 6.283) * 0.22,
            0,
            0.55,
            0,
            (b / 7) * 6.283
          )
        });
      }
      blades.add(new THREE.Mesh(merge_geometries(blade_items), materials.fan_blade));
      blades.position.z = 0.02;
      fan_group.add(blades);
      this.fans.push(blades);
      const grille = new THREE.Mesh(new THREE.TorusGeometry(0.38, 0.028, 8, 24), materials.metal);
      grille.position.z = 0.15;
      fan_group.add(grille);
      register_part(fan_group, new THREE.Vector3(fan_x, layout.height * 0.5, -layout.depth * 1.2));
    }

    /* 芯片转发脉动光。 */
    const accent_hex = String((this.vendor_profile.brand || {}).accent_color || '#37e0c9').replace(
      '#',
      ''
    );
    const accent_value = Number.parseInt(accent_hex, 16);
    this.chip_pulse = new THREE.Mesh(
      new THREE.CircleGeometry(0.38, 24),
      new THREE.MeshBasicMaterial({
        color: Number.isFinite(accent_value) ? accent_value : 0x37e0c9,
        transparent: true,
        opacity: 0.22,
        blending: THREE.AdditiveBlending,
        depthWrite: false
      })
    );
    this.chip_pulse.rotation.x = -Math.PI / 2;
    this.chip_pulse.position.set(layout.width * 0.1, -layout.height * 0.16, -0.2);
    register_part(
      this.chip_pulse,
      new THREE.Vector3(layout.width * 0.1, layout.height * 1.3, -0.2)
    );
  }

  /**
   * 设置选中端口（三维高亮）。
   *
   * @param {string|null} short_name 端口短名。
   * @returns {void}
   */
  set_selected_port(short_name) {
    for (const visual of this.port_visuals) {
      visual.set_selected(Boolean(short_name) && visual.definition.short_name === short_name);
    }
  }

  /**
   * 设置显示模式：外观 / 透视 / 爆炸。
   *
   * @param {string} mode shell|xray|explode。
   * @returns {void}
   */
  /**
   * 显示 / 隐藏内部结构（主板、芯片、散热片）。
   *
   * @param {boolean} visible 是否可见。
   * @returns {void}
   */
  set_internal_visible(visible) {
    if (this.internal_group) {
      this.internal_group.visible = Boolean(visible);
    }
  }

  set_mode(mode) {
    this.mode = mode;
    const transparent = mode !== 'shell';
    const original = this.shell_material_original || this.shell.material;
    if (!transparent) {
      this.shell.material = original;
    } else {
      const source_list = Array.isArray(original) ? original : [original];
      const group_count = Math.max(
        1,
        (this.shell.geometry && this.shell.geometry.groups
          ? this.shell.geometry.groups.length
          : 1) || 1
      );
      const cloned = [];
      for (let index = 0; index < group_count; index += 1) {
        const base = source_list[index % source_list.length] || source_list[0];
        const clone = base.clone();
        clone.transparent = true;
        clone.opacity = mode === 'xray' ? 0.15 : 0.09;
        clone.depthWrite = false;
        clone.side = THREE.DoubleSide;
        cloned.push(clone);
      }
      this.shell.material = cloned.length === 1 ? cloned[0] : cloned;
    }
    /* 内部结构：模板设备由 internal_group 承担，程序化设备用 interior。 */
    if (this.interior) {
      this.interior.visible = transparent;
    }
    const target = mode === 'explode' ? 1 : 0;
    for (const part of this.explode_parts) {
      part.userData.explode_want = target;
    }
  }

  /**
   * 同步端口外观与设备运行时状态（LED、插头、线缆）。
   *
   * @param {number} time_seconds 当前时间。
   * @param {number} delta_seconds 时间增量。
   * @returns {void}
   */
  update(time_seconds, delta_seconds) {
    const device = this.runtime_device;
    const ground_y = -1.5 - this.group.position.y;
    /* 设备可在场景中被拖动：线缆尾端要跟随设备，锚点换算到设备局部坐标。 */
    const trough_z = this.trough_world_z - this.group.position.z;
    const trough_x = -this.group.position.x;
    this._trough_local = { x: trough_x, z: trough_z };
    const self_test_on = this.self_test > 0;
    if (self_test_on) {
      this.self_test -= delta_seconds;
    }
    if (device && (!this._port_state_map || this._port_state_map_device !== device)) {
      this._port_state_map = new Map();
      for (const item of device.ports) {
        this._port_state_map.set(item.short_name, item);
      }
      this._port_state_map_device = device;
    }
    const state_map = this._port_state_map || new Map();

    for (const visual of this.port_visuals) {
      visual._trough_x = trough_x;
      visual.update(delta_seconds, ground_y, trough_z);
      const definition = visual.definition;
      const port_state = state_map.get(definition.short_name) || null;
      const leds = visual.leds;
      if (!this.power_on) {
        for (const led of leds) {
          led.material.emissiveIntensity = 0;
        }
        continue;
      }
      if (self_test_on) {
        const phase = (time_seconds * 3 - definition.index * 0.06) % 3;
        const on = phase < 0.35;
        leds.forEach((led, index) => {
          led.material.emissive.setHex(index === 0 ? 0xffb648 : 0x37e0c9);
          led.material.emissiveIntensity = on ? 2.4 : 0.05;
        });
        continue;
      }
      const is_up = Boolean(port_state && port_state.link_up && port_state.admin_up);
      const is_admin_down = Boolean(port_state && !port_state.admin_up);
      if (is_admin_down) {
        leds.forEach((led) => {
          led.material.emissiveIntensity = 0.02;
        });
        continue;
      }
      if (!is_up) {
        leds[0].material.emissive.setHex(0x2a3a44);
        leds[0].material.emissiveIntensity =
          0.12 + 0.1 * Math.sin(time_seconds * 1.6 + definition.index);
        for (let i = 1; i < leds.length; i += 1) {
          leds[i].material.emissiveIntensity = 0.02;
        }
        continue;
      }
      const speed_text = port_state.speed || '1000M';
      const activity =
        Math.max(0, Math.sin(port_state.blink_phase)) *
        Math.max(0, Math.sin(port_state.blink_phase * 0.37 + 1.2));
      leds[0].material.emissive.setHex(0x2bff9a);
      leds[0].material.emissiveIntensity = 0.45 + activity * 2.6;
      if (leds.length > 1) {
        if (port_state.poe_enabled) {
          leds[1].material.emissive.setHex(0xffb648);
          leds[1].material.emissiveIntensity =
            0.7 + 0.5 * Math.sin(time_seconds * 2.2 + definition.index);
        } else if (speed_text === '100M') {
          leds[1].material.emissive.setHex(0xffb648);
          leds[1].material.emissiveIntensity = 0.4;
        } else {
          leds[1].material.emissive.setHex(speed_text === '10G' ? 0x37e0c9 : 0x2bff9a);
          leds[1].material.emissiveIntensity = 0.35;
        }
      }
    }

    /* 系统灯。 */
    if (this.system_led) {
      if (this.power_on) {
        const ready = !device || device.power_state === DEVICE_STATE.RUNNING;
        this.system_led.material.emissive.setHex(ready ? 0x2bff9a : 0xffb648);
        this.system_led.material.emissiveIntensity = ready
          ? 0.8 + 0.6 * Math.sin(time_seconds * 2.4)
          : 1.6;
      } else {
        this.system_led.material.emissiveIntensity = 0;
      }
    }
    if (this.power_led) {
      this.power_led.material.emissive.setHex(0x2bff9a);
      this.power_led.material.emissiveIntensity = this.power_on ? 1.1 : 0;
    }

    /* 风扇与芯片脉动。 */
    const temperature = device ? device.environment.temperature : 30;
    const fan_speed = this.power_on ? 0.25 + utils.clamp((temperature - 30) / 40, 0, 1) * 0.9 : 0;
    for (const fan of this.fans) {
      fan.rotation.z -= delta_seconds * fan_speed * 22;
    }
    if (this.chip_pulse) {
      this.chip_pulse.material.opacity = 0.1 + 0.2 * Math.abs(Math.sin(time_seconds * 2.1));
    }

    /* 内部转发路径粒子。 */
    if (this.flow_layer) {
      this.flow_layer.update(delta_seconds);
    }

    /* 爆炸动画插值。 */
    for (const part of this.explode_parts) {
      const want = part.userData.explode_want || 0;
      part.position.lerp(want ? part.userData.explode_target : part.userData.base_position, 0.09);
    }
  }

  /**
   * 设置电源状态（控制电源键与 LED 基色）。
   *
   * @param {boolean} is_on 是否开机。
   * @returns {void}
   */
  set_power(is_on) {
    this.power_on = is_on;
    const button = this.power_button as THREE.Mesh | null;
    if (button && button.isMesh && this.power_button_material_on) {
      /* 拾取盘（透明）不参与开关机配色。 */
      if (button.name !== 'power_button_pick') {
        button.material = is_on
          ? this.power_button_material_on
          : this.power_button_material_off;
      }
    }
  }

  /**
   * 播放 LED 自检跑马灯。
   *
   * @param {number} duration_seconds 持续时间。
   * @returns {void}
   */
  play_self_test(duration_seconds) {
    this.self_test = duration_seconds;
  }

  /**
   * 根据运行时状态同步插头与线缆（拔插后调用）。
   *
   * @returns {void}
   */
  sync_connectors() {
    const device = this.runtime_device;
    if (!device) {
      return;
    }
    const ground_y = -1.5 - this.group.position.y;
    for (const visual of this.port_visuals) {
      const port_state = device.ports.find(
        (item) => item.short_name === visual.definition.short_name
      );
      if (!port_state) {
        continue;
      }
      const should_plug = Boolean(port_state.plugged);
      if (should_plug && !visual.plugged) {
        visual.set_plugged(true);
        visual.build_cable(ground_y, this.trough_offset);
      } else if (!should_plug && visual.plugged) {
        visual.set_plugged(false);
      }
    }
  }

  /**
   * 释放资源。
   *
   * @returns {void}
   */
  dispose() {
    for (const visual of this.port_visuals) {
      visual.dispose_cable();
    }
    if (this.flow_layer) {
      this.flow_layer.dispose();
    }
    this.group.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (mesh.isMesh && mesh.geometry) {
        mesh.geometry.dispose();
      }
    });
  }
}

export { DeviceObject };
export const device_builder = {
  merge_geometries: merge_geometries,
  trs: trs,
  rounded_box: rounded_box
};
