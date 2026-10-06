/**
 * @File : web/src/devices/assembler.ts
 * @Time : 2026-10-06 13:30
 * @Author : Cetrp
 * @Description : 模板装配器：把 DeviceTemplate 的部件清单装配成 THREE.Group，并汇总端口锚点
 *               （锚点 = 线缆从真实接口长出的起点，供线缆图层使用）。
 */

import * as THREE from 'three';

import { get_part_definition } from './parts';
import { led_dot } from './part_kit';

import type { ConnectorType, DeviceTemplate, PartSpec, PortSlotSpec } from './template_types';

/** 装配后的端口锚点（设备局部坐标，单位米）。 */
export interface PortAnchor {
  /** 端口短名。 */
  short_name: string;
  /** 端口全名。 */
  name: string;
  /** 连接器类型。 */
  connector: ConnectorType;
  /** 锚点位置（设备局部坐标，米）。 */
  position: THREE.Vector3;
  /** 插入方向（单位向量，指向设备外部）。 */
  direction: THREE.Vector3;
  /** 速率（bps）。 */
  speed_bps: number;
  /** 是否支持 PoE。 */
  poe: boolean;
  /** 分组标识。 */
  group_id: string;
  /** 丝印标签。 */
  label: string;
}

/** 装配结果。 */
export interface AssembledDevice {
  /** 设备根组（局部坐标，单位米，原点在设备中心底部）。 */
  group: THREE.Group;
  /** 内部结构分组（主板/芯片/散热），默认隐藏，透视与爆炸视图显示。 */
  internal_group: THREE.Group;
  /** 端口锚点。 */
  port_anchors: PortAnchor[];
  /** 可拆卸部件（爆炸视图用）。 */
  removable_parts: { part_id: string; object: THREE.Object3D; spec: PartSpec }[];
  /** 指示灯对象（part_id → 组）。 */
  leds: { name: string; object: THREE.Object3D; color: string }[];
  /** 电源键对象（模板面板提供；缺失时由程序化外壳兜底）。 */
  power_buttons: THREE.Object3D[];
  /** 装配过程中缺失的部件 kind（用于工坊提示）。 */
  missing_kinds: string[];
}

/**
 * 装配单个部件。
 *
 * @param {PartSpec} spec 部件描述。
 * @param {DeviceTemplate} template 所属模板。
 * @returns {THREE.Object3D | null} 部件对象；未注册的 kind 返回 null。
 */
function assemble_part(spec: PartSpec, template: DeviceTemplate): THREE.Object3D | null {
  const definition = get_part_definition(spec.kind);
  if (!definition) {
    return null;
  }
  const merged_params = { ...definition.defaults, ...spec.params };
  const object = definition.build({
    spec: { ...spec, params: merged_params },
    template: template,
    namespace: template.model_id
  });
  /* 模板变换与部件自身定位（如 port_row 的 origin）叠加而不是覆盖。 */
  const transform = spec.transform || {};
  if (transform.position) {
    object.position.add(
      new THREE.Vector3(
        transform.position[0] || 0,
        transform.position[1] || 0,
        transform.position[2] || 0
      )
    );
  }
  if (transform.rotation) {
    object.rotation.set(
      object.rotation.x + (transform.rotation[0] || 0),
      object.rotation.y + (transform.rotation[1] || 0),
      object.rotation.z + (transform.rotation[2] || 0)
    );
  }
  if (transform.scale) {
    object.scale.multiply(
      new THREE.Vector3(
        transform.scale[0] === undefined ? 1 : transform.scale[0],
        transform.scale[1] === undefined ? 1 : transform.scale[1],
        transform.scale[2] === undefined ? 1 : transform.scale[2]
      )
    );
  }
  /* 机架电源统一贴合后面板；模板历史数据中的 180° 旋转不再重复叠加。 */
  if (template.rack_mountable && spec.kind === 'psu_module') {
    const part_depth = Number(merged_params.depth) || 0.02;
    /* 面板凸台仍保留在机箱 6 mm 结构容差内，避免整块电源穿出背板。 */
    object.position.z = -template.dimensions.depth / 2 + part_depth / 2 + 0.0022;
    object.rotation.y = Math.PI;
  }
  /* 未声明侧吹方向的风扇盘安装在背板；显式旋转的模板继续使用侧面风道。 */
  if (template.rack_mountable && spec.kind === 'fan_tray' && !transform.rotation) {
    const part_depth = Number(merged_params.depth) || 0.02;
    object.position.z = -template.dimensions.depth / 2 + part_depth / 2 - 0.0006;
    object.rotation.y = Math.PI;
  }
  object.name = spec.part_id || spec.kind;
  object.userData.part_spec = spec;
  /* 小型部件也参与阴影和环境遮蔽，近景下接口、螺钉与折边才有真实深度。 */
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) {
      return;
    }
    const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
    const materials = Array.isArray(material) ? material : material ? [material] : [];
    const visible_material = materials.some(
      (item) => !item.transparent || (item.opacity > 0.15 && item.depthWrite)
    );
    mesh.castShadow = visible_material;
    mesh.receiveShadow = true;
  });

  return object;
}

/**
 * 把端口槽位从部件局部坐标转换到设备局部坐标。
 *
 * @param {PortSlotSpec[]} slots 部件内的端口槽位。
 * @param {THREE.Object3D} part_object 部件对象（已应用模板变换）。
 * @returns {PortAnchor[]} 设备局部坐标下的锚点。
 */
function collect_anchors(slots: PortSlotSpec[], part_object: THREE.Object3D): PortAnchor[] {
  part_object.updateMatrixWorld(true);
  const anchors: PortAnchor[] = [];
  for (const slot of slots) {
    const position = new THREE.Vector3(
      slot.position[0],
      slot.position[1],
      slot.position[2]
    ).applyMatrix4(part_object.matrixWorld);
    const direction = new THREE.Vector3(slot.direction[0], slot.direction[1], slot.direction[2])
      .normalize()
      .transformDirection(part_object.matrixWorld)
      .normalize();
    anchors.push({
      short_name: slot.short_name,
      name: slot.name,
      connector: slot.connector,
      position: position,
      direction: direction,
      speed_bps: slot.speed_bps,
      poe: Boolean(slot.poe),
      group_id: slot.group_id || 'ports',
      label: slot.label || slot.short_name
    });
  }

  return anchors;
}

/**
 * 按模板装配设备。
 *
 * @param {DeviceTemplate} template 设备模板。
 * @param {object} [options] 选项。
 * @param {boolean} [options.include_internal] 是否包含内部结构（透视视图需要；工坊预览建议开启）。
 * @returns {AssembledDevice} 装配结果。
 */
export function assemble_device(
  template: DeviceTemplate,
  options: { include_internal?: boolean } = {}
): AssembledDevice {
  const group = new THREE.Group();
  group.name = template.model_id;
  const internal_group = new THREE.Group();
  internal_group.name = 'internal';
  internal_group.visible = false;
  group.add(internal_group);
  const port_anchors: PortAnchor[] = [];
  const removable_parts: { part_id: string; object: THREE.Object3D; spec: PartSpec }[] = [];
  const leds: { name: string; object: THREE.Object3D; color: string }[] = [];
  const missing_kinds: string[] = [];
  const power_buttons: THREE.Object3D[] = [];
  const include_internal = options.include_internal !== false;

  for (const spec of template.parts) {
    if (!include_internal && spec.category === 'internal') {
      continue;
    }
    const object = assemble_part(spec, template);
    if (!object) {
      if (!missing_kinds.includes(spec.kind)) {
        missing_kinds.push(spec.kind);
      }
      continue;
    }
    /* 内部结构（主板/芯片/散热）加入内部组，默认隐藏。 */
    if (spec.category === 'internal') {
      internal_group.add(object);
    } else {
      group.add(object);
    }
    const slots = object.userData.port_slots as PortSlotSpec[] | undefined;
    if (slots && slots.length > 0) {
      port_anchors.push(...collect_anchors(slots, object));
    }
    object.traverse((child) => {
      if (child.userData && child.userData.power_button) {
        power_buttons.push(child);
      }
    });
    if (spec.removable !== false) {
      removable_parts.push({ part_id: spec.part_id, object: object, spec: spec });
    }
  }

  /* 模板显式声明的端口（不在部件 userData 中的补充端口）。 */
  for (const slot of template.ports) {
    if (port_anchors.some((anchor) => anchor.short_name === slot.short_name)) {
      continue;
    }
    port_anchors.push({
      short_name: slot.short_name,
      name: slot.name,
      connector: slot.connector,
      position: new THREE.Vector3(slot.position[0], slot.position[1], slot.position[2]),
      direction: new THREE.Vector3(
        slot.direction[0],
        slot.direction[1],
        slot.direction[2]
      ).normalize(),
      speed_bps: slot.speed_bps,
      poe: Boolean(slot.poe),
      group_id: slot.group_id || 'ports',
      label: slot.label || slot.short_name
    });
  }

  /* 指示灯。 */
  for (const led of template.leds) {
    const object = led_dot(led.color, led.radius || 0.00145);
    object.position.set(led.position[0], led.position[1], led.position[2]);
    object.name = 'led_' + led.name;
    group.add(object);
    leds.push({ name: led.name, object: object, color: led.color });
  }

  /* 模板主题色应用到机箱部件（未显式指定颜色的部件）。 */
  if (template.theme && template.theme.chassis_color) {
    for (const child of group.children) {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) {
        continue;
      }
      const material = mesh.material as THREE.MeshStandardMaterial | undefined;
      if (material && material.isMeshStandardMaterial && material.metalness > 0.4) {
        material.color = new THREE.Color(template.theme.chassis_color);
      }
    }
  }

  return {
    group: group,
    internal_group: internal_group,
    port_anchors: port_anchors,
    removable_parts: removable_parts,
    leds: leds,
    power_buttons: power_buttons,
    missing_kinds: missing_kinds
  };
}

/**
 * 计算模板的实际外形包围盒（米）。
 *
 * @param {DeviceTemplate} template 设备模板。
 * @returns {{width: number; height: number; depth: number}} 尺寸。
 */
export function template_bounds(template: DeviceTemplate): {
  width: number;
  height: number;
  depth: number;
} {
  const assembled = assemble_device(template, { include_internal: false });
  const box = new THREE.Box3().setFromObject(assembled.group);

  return {
    width: Math.max(0.01, box.max.x - box.min.x),
    height: Math.max(0.01, box.max.y - box.min.y),
    depth: Math.max(0.01, box.max.z - box.min.z)
  };
}
