/**
 * @File : web/src/devices/template_device.ts
 * @Time : 2026-10-06 16:20
 * @Author : Cetrp
 * @Description : 把设备模板装配结果接入三维场景：按场景比例缩放、定位到设备原点，
 *               并把端口锚点换算成场景坐标（供线缆对象从真实接口长出）。
 */

import * as THREE from 'three';

import { assemble_device } from './assembler';

import type { AssembledDevice, PortAnchor } from './assembler';
import type { DeviceTemplate } from './template_types';

/** 标准 19 英寸机架的 1U 面板宽度（米）。 */
export const RACK_PANEL_WIDTH_M = 0.442;

/** 机架式设备在场景中的显示宽度（场景单位，与 DeviceLayout 保持一致）。 */
export const RACK_DISPLAY_WIDTH = 8.84;

/**
 * 全局场景比例（场景单位 / 米）。
 *
 * 所有设备共用同一比例，**保持设备之间的真实相对尺寸**：
 * 1U 交换机 8.84 单位宽、笔记本 6.8、AP 1.7、手机 1.4。
 * 若按"每台设备归一化到固定显示宽度"，8.6 cm 的 AP 会和 34 cm 的笔记本一样大，
 * 视觉上完全不真实——这是早期版本的错误做法。
 */
export const SCENE_UNITS_PER_METER = RACK_DISPLAY_WIDTH / RACK_PANEL_WIDTH_M;

/**
 * 计算模板的场景比例（场景单位 / 米）。
 *
 * 设备模板使用**米**，而 Manifest 中网络设备的尺寸沿用旧数据口径（分米），
 * 因此不能复用 `DeviceLayout.scale`；这里统一返回全局比例。
 *
 * @param {DeviceTemplate} template 设备模板（保留参数以便将来支持特殊型号）。
 * @returns {number} 场景比例。
 */
export function template_scene_scale(template: DeviceTemplate): number {
  const width = Math.max(0.001, template.dimensions.width);

  /* 极端尺寸保护：避免异常模板把场景撑爆或缩到看不见。 */
  if (width > 3) {
    return RACK_DISPLAY_WIDTH / width;
  }

  return SCENE_UNITS_PER_METER;
}

/** 场景中使用的端口锚点（场景单位，设备局部坐标）。 */
export interface ScenePortAnchor {
  /** 端口短名。 */
  short_name: string;
  /** 连接器类型。 */
  connector: PortAnchor['connector'];
  /** 场景坐标下的锚点位置。 */
  position: THREE.Vector3;
  /** 场景坐标下的插入方向（单位向量）。 */
  direction: THREE.Vector3;
  /** 速率（bps）。 */
  speed_bps: number;
  /** 是否支持 PoE。 */
  poe: boolean;
  /** 分组标识。 */
  group_id: string;
}

/** 模板设备构建结果。 */
export interface TemplateDeviceBuild {
  /** 设备根组（场景单位；原点在机箱中心水平面，底面贴 y=0）。 */
  group: THREE.Group;
  /** 主壳体网格（拾取与透视模式使用）。 */
  shell: THREE.Mesh;
  /** 场景坐标端口锚点。 */
  anchors: ScenePortAnchor[];
  /** 端口短名 → 锚点。 */
  anchor_by_port: Map<string, ScenePortAnchor>;
  /** 场景单位 → 米的比例。 */
  scale: number;
  /** 内部结构分组（主板/芯片/散热），外观模式隐藏、透视与爆炸模式显示。 */
  internal_group: THREE.Group;
  /** 面板提供的电源键（左键点击即开关机）。 */
  power_button: THREE.Object3D | null;
  /** 模板上的系统/电源指示灯，供运行态驱动发光强度。 */
  leds: AssembledDevice['leds'];
  /** 可拆卸部件。 */
  removable_parts: AssembledDevice['removable_parts'];
  /** 缺失部件 kind。 */
  missing_kinds: string[];
}

/**
 * 从模板构建场景用设备对象。
 *
 * @param {DeviceTemplate} template 设备模板。
 * @param {object} options 选项。
 * @param {number} options.scale 场景比例（场景单位 / 米），来自 DeviceLayout.compute_layout。
 * @param {number} [options.base_offset_y] 机箱底面在设备根组中的 y 偏移（场景单位，缺省 0）。
 * @returns {TemplateDeviceBuild} 构建结果。
 */
export function build_template_device(
  template: DeviceTemplate,
  options: { scale: number; base_offset_y?: number }
): TemplateDeviceBuild {
  const assembled = assemble_device(template);
  const scale = options.scale > 0 ? options.scale : 1;
  const group = new THREE.Group();
  group.name = 'template:' + template.model_id;

  /* 模板在"米"坐标系下以机箱中心为原点、底面在 -height/2；这里换算到场景坐标系。 */
  const half_height = template.dimensions.height / 2;
  const inner = new THREE.Group();
  inner.scale.setScalar(scale);
  inner.position.y = -half_height * scale + (options.base_offset_y || 0);
  inner.add(assembled.group);
  group.add(inner);

  /* 主壳体：先定位"机箱"部件组（part_spec 打在部件组上），再取其首个网格。 */
  let shell: THREE.Mesh | null = null;
  assembled.group.traverse((object) => {
    const spec = object.userData.part_spec;
    if (shell || !spec || spec.category !== 'chassis') {
      return;
    }
    object.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!shell && mesh.isMesh && mesh.geometry) {
        shell = mesh;
        mesh.visible = true;
      }
    });
  });
  if (!shell) {
    const fallback = new THREE.Mesh(
      new THREE.BoxGeometry(
        template.dimensions.width * scale,
        template.dimensions.height * scale,
        template.dimensions.depth * scale
      ),
      new THREE.MeshStandardMaterial({ color: '#8f9aa6', metalness: 0.5, roughness: 0.45 })
    );
    fallback.visible = false;
    group.add(fallback);
    shell = fallback;
  }
  shell.castShadow = true;
  shell.receiveShadow = true;

  const anchors: ScenePortAnchor[] = [];
  const anchor_by_port = new Map<string, ScenePortAnchor>();
  for (const anchor of assembled.port_anchors) {
    const scene_anchor: ScenePortAnchor = {
      short_name: anchor.short_name,
      connector: anchor.connector,
      position: new THREE.Vector3(
        anchor.position.x * scale,
        (anchor.position.y - half_height) * scale + (options.base_offset_y || 0),
        anchor.position.z * scale
      ),
      direction: anchor.direction.clone().normalize(),
      speed_bps: anchor.speed_bps,
      poe: anchor.poe,
      group_id: anchor.group_id
    };
    anchors.push(scene_anchor);
    anchor_by_port.set(scene_anchor.short_name, scene_anchor);
  }
  group.userData.template_device = {
    model_id: template.model_id,
    scale: scale,
    anchor_count: anchors.length
  };

  return {
    group: group,
    shell: shell,
    internal_group: assembled.internal_group,
    power_button:
      assembled.power_buttons.find((object) => (object as THREE.Mesh).isMesh) ||
      assembled.power_buttons[0] ||
      null,
    leds: assembled.leds,
    anchors: anchors,
    anchor_by_port: anchor_by_port,
    scale: scale,
    removable_parts: assembled.removable_parts,
    missing_kinds: assembled.missing_kinds
  };
}

/**
 * 取端口锚点的世界坐标。
 *
 * @param {THREE.Object3D} device_group 设备根组。
 * @param {string} short_name 端口短名。
 * @param {TemplateDeviceBuild} build 构建结果。
 * @returns {THREE.Vector3 | null} 世界坐标；端口不存在时为 null。
 */
export function anchor_world_position(
  device_group: THREE.Object3D,
  short_name: string,
  build: TemplateDeviceBuild
): THREE.Vector3 | null {
  const anchor = build.anchor_by_port.get(short_name);
  if (!anchor) {
    return null;
  }
  device_group.updateMatrixWorld(true);

  return anchor.position.clone().applyMatrix4(device_group.matrixWorld);
}

/**
 * 取端口锚点的世界方向。
 *
 * @param {THREE.Object3D} device_group 设备根组。
 * @param {string} short_name 端口短名。
 * @param {TemplateDeviceBuild} build 构建结果。
 * @returns {THREE.Vector3 | null} 世界方向；端口不存在时为 null。
 */
export function anchor_world_direction(
  device_group: THREE.Object3D,
  short_name: string,
  build: TemplateDeviceBuild
): THREE.Vector3 | null {
  const anchor = build.anchor_by_port.get(short_name);
  if (!anchor) {
    return null;
  }
  device_group.updateMatrixWorld(true);

  return anchor.direction.clone().transformDirection(device_group.matrixWorld).normalize();
}
