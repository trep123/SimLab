/**
 * @File : web/src/devices/parts/chassis.ts
 * @Time : 2026-10-06 09:40
 * @Author : Cetrp
 * @Description : 参数化机箱部件：机架式（1U/2U）、桌面式（盒子/立式）、手持式（手机）与面板式外壳。
 */

import * as THREE from 'three';

import {
  COLOR,
  chassis_material,
  emissive_material,
  keyboard_deck,
  label_texture,
  merge_geometries,
  mobile_screen_texture,
  plastic_material,
  rack_ear,
  rounded_box,
  screen_panel,
  shell_material,
  screw,
  trs,
  vent_grille
} from '../part_kit';
import type { PartDefinition } from '../template_types';

/** 读取数值参数（缺省回退）。 */
function number_param(params: Record<string, unknown>, key: string, fallback: number): number {
  const value = params[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** 读取颜色参数。 */
function color_param(params: Record<string, unknown>, key: string, fallback: string): string {
  const value = params[key];
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

/** 读取布尔参数。 */
function boolean_param(params: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = params[key];
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * 机架式机箱：U 高机箱 + 安装耳 + 顶部通风 + 面板螺丝。
 *
 * @param {object} context 构建上下文。
 * @returns {THREE.Group} 机箱组。
 */
function build_rack_chassis(context: {
  spec: { params: Record<string, unknown> };
  template: { model_id: string };
}): THREE.Group {
  const { spec, template } = context;
  const width = number_param(spec.params, 'width', 0.442);
  const height = number_param(spec.params, 'height', 0.044);
  const depth = number_param(spec.params, 'depth', 0.24);
  const color = color_param(spec.params, 'color', COLOR.chassis_light);
  const ears = boolean_param(spec.params, 'ears', true);
  const vents = boolean_param(spec.params, 'vents', true);

  const group = new THREE.Group();
  const body = new THREE.Mesh(
    rounded_box(width, height, depth, 0.0018),
    shell_material(color, { metalness: 0.72, roughness: 0.36 })
  );
  group.add(body);

  /* 可拆顶盖：轻微抬高，并用四周折边/接缝表达真实钣金层次。 */
  const lid = new THREE.Mesh(
    rounded_box(width * 0.955, 0.0014, depth * 0.91, 0.0007),
    shell_material(color, { metalness: 0.76, roughness: 0.32 })
  );
  lid.position.set(0, height / 2 + 0.00045, -depth * 0.015);
  lid.name = 'removable_top_cover';
  group.add(lid);
  const seam_material = plastic_material('#252b32', 0.82);
  const seam_thickness = Math.max(0.00035, height * 0.009);
  const seam_depth = 0.0005;
  for (const x of [-width * 0.465, width * 0.465]) {
    const side_seam = new THREE.Mesh(
      new THREE.BoxGeometry(seam_thickness, seam_depth, depth * 0.84),
      seam_material
    );
    side_seam.position.set(x, height / 2 + 0.0012, -depth * 0.015);
    group.add(side_seam);
  }
  for (const z of [-depth * 0.43, depth * 0.4]) {
    const end_seam = new THREE.Mesh(
      new THREE.BoxGeometry(width * 0.93, seam_depth, seam_thickness),
      seam_material
    );
    end_seam.position.set(0, height / 2 + 0.0012, z);
    group.add(end_seam);
  }

  /* 顶盖铭牌与四颗维护螺钉。 */
  const product_code = template.model_id.split('-').slice(1).join(' ').toUpperCase();
  const service_label = new THREE.Mesh(
    new THREE.PlaneGeometry(width * 0.2, depth * 0.085),
    new THREE.MeshBasicMaterial({
      map: label_texture(product_code, '#28323c', 256),
      transparent: true,
      depthWrite: false
    })
  );
  service_label.rotation.x = -Math.PI / 2;
  service_label.position.set(width * 0.31, height / 2 + 0.00135, -depth * 0.28);
  group.add(service_label);
  for (const x of [-width * 0.41, width * 0.41]) {
    for (const z of [-depth * 0.36, depth * 0.34]) {
      const fastener = new THREE.Mesh(
        new THREE.CylinderGeometry(0.00165, 0.00165, 0.0007, 16),
        chassis_material('#626b75', { metalness: 0.82, roughness: 0.26 })
      );
      fastener.position.set(x, height / 2 + 0.00125, z);
      group.add(fastener);
    }
  }

  /* 前后折边让外壳不再像单一立方体，面板也有真实的嵌入深度。 */
  for (const z of [-depth / 2 - 0.0003, depth / 2 + 0.0003]) {
    const lip = new THREE.Mesh(
      rounded_box(width * 0.986, height * 0.91, 0.0018, 0.0008),
      chassis_material(COLOR.chassis_dark, { metalness: 0.74, roughness: 0.38 })
    );
    lip.position.z = z;
    group.add(lip);
  }

  /* 侧面进气格栅。 */
  if (vents) {
    for (const side of [-1, 1]) {
      for (const bank_z of [-depth * 0.2, depth * 0.18]) {
        const grille = new THREE.Mesh(
          vent_grille(depth * 0.28, height * 0.48, 9, 0.0012),
          plastic_material('#11161c', 0.94)
        );
        grille.rotation.y = side > 0 ? Math.PI / 2 : -Math.PI / 2;
        grille.position.set(side * (width / 2 + 0.00065), 0, bank_z);
        group.add(grille);
      }
    }
  }

  /* 安装耳与面板螺丝。 */
  if (ears) {
    const ear_left = rack_ear(height, depth);
    ear_left.position.set(-width / 2 - 0.0015, 0, depth * 0.42);
    group.add(ear_left);
    const ear_right = rack_ear(height, depth);
    ear_right.position.set(width / 2 + 0.0015, 0, depth * 0.42);
    group.add(ear_right);
    for (const side of [-1, 1]) {
      for (const offset of [-0.28, 0.28]) {
        const bolt = screw(0.003);
        bolt.position.set(
          side * (width / 2 + 0.0018),
          height * offset,
          depth * 0.5 + 0.001
        );
        group.add(bolt);
      }
    }
  }

  /* 四个橡胶脚垫在侧视与爆炸视图下可见。 */
  for (const x of [-width * 0.4, width * 0.4]) {
    for (const z of [-depth * 0.36, depth * 0.36]) {
      const foot = new THREE.Mesh(
        new THREE.CylinderGeometry(0.0042, 0.0048, 0.0022, 18),
        plastic_material('#101318', 0.96)
      );
      foot.position.set(x, -height / 2 - 0.0011, z);
      group.add(foot);
    }
  }
  group.userData.chassis_size = { width: width, height: height, depth: depth };

  return group;
}

/**
 * 桌面式机箱：小型盒子 + 底部脚垫 + 顶面散热槽。
 *
 * @param {object} context 构建上下文。
 * @returns {THREE.Group} 机箱组。
 */
function build_desktop_chassis(context: {
  spec: { params: Record<string, unknown> };
}): THREE.Group {
  const { spec } = context;
  const width = number_param(spec.params, 'width', 0.086);
  const height = number_param(spec.params, 'height', 0.028);
  const depth = number_param(spec.params, 'depth', 0.086);
  const color = color_param(spec.params, 'color', COLOR.plastic_gray);
  const group = new THREE.Group();
  const body = new THREE.Mesh(
    rounded_box(width, height, depth, 0.004),
    plastic_material(color, 0.62)
  );
  group.add(body);
  const top = new THREE.Mesh(
    vent_grille(width * 0.6, depth * 0.5, 6, 0.002),
    plastic_material(COLOR.plastic_dark, 0.9)
  );
  top.rotation.x = -Math.PI / 2;
  top.position.y = height / 2 + 0.0008;
  group.add(top);
  for (const [x, z] of [
    [-0.35, -0.35],
    [0.35, -0.35],
    [-0.35, 0.35],
    [0.35, 0.35]
  ]) {
    const foot = new THREE.Mesh(
      new THREE.CylinderGeometry(0.004, 0.004, 0.002, 12),
      plastic_material('#0d1015', 0.95)
    );
    foot.position.set(width * x, -height / 2 - 0.001, depth * z);
    group.add(foot);
  }
  group.userData.chassis_size = { width: width, height: height, depth: depth };

  return group;
}

/**
 * 手持式机箱（手机/平板）：薄板 + 圆角 + 摄像头凸起。
 *
 * @param {object} context 构建上下文。
 * @returns {THREE.Group} 机箱组。
 */
function build_handheld_chassis(context: {
  spec: { params: Record<string, unknown> };
}): THREE.Group {
  const { spec } = context;
  const width = number_param(spec.params, 'width', 0.0715);
  const height = number_param(spec.params, 'height', 0.1467);
  const depth = number_param(spec.params, 'depth', 0.0085);
  const color = color_param(spec.params, 'color', '#20242b');
  const group = new THREE.Group();
  const body = new THREE.Mesh(
    rounded_box(width, height, depth, 0.006),
    shell_material(color, {
      metalness: 0.62,
      roughness: 0.34
    })
  );
  group.add(body);
  const camera = new THREE.Mesh(
    rounded_box(width * 0.34, width * 0.3, depth * 1.6, 0.004),
    plastic_material('#0d1015', 0.4)
  );
  camera.position.set(-width * 0.22, height * 0.4, depth * 0.5);
  group.add(camera);
  group.userData.chassis_size = { width: width, height: height, depth: depth };

  return group;
}


/**
 * 智能手机机身（平放形态）：合金中框 + 正面玻璃 + 后盖 + 镜头模组 + 侧键 + 底部开孔。
 *
 * 坐标约定：X = 机身宽度，Y = 厚度（正面玻璃朝 +Y），Z = 机身长度。
 * 平放是为了与"笔记本/AP/ONU 等桌面设备"保持同一视觉语言，也符合真机摆在台面上的样子。
 *
 * @param {object} context 构建上下文。
 * @returns {THREE.Group} 机身组。
 */
function build_phone_body(context: { spec: { params: Record<string, unknown> } }): THREE.Group {
  const { spec } = context;
  const width = number_param(spec.params, 'width', 0.0715);
  const length = number_param(spec.params, 'length', 0.152);
  const thickness = number_param(spec.params, 'thickness', 0.0085);
  const color = color_param(spec.params, 'color', '#2a2f36');
  const group = new THREE.Group();

  /* ① 合金中框（圆角矩形，四角圆润）。 */
  const frame = new THREE.Mesh(
    rounded_box(width, thickness, length, thickness * 0.42),
    shell_material(color, { metalness: 0.72, roughness: 0.3 })
  );
  group.add(frame);

  /* ② 正面玻璃：略小于中框、略高于中框上表面（玻璃盖板）。 */
  const glass = new THREE.Mesh(
    rounded_box(width * 0.965, thickness * 0.16, length * 0.975, thickness * 0.4),
    new THREE.MeshStandardMaterial({
      color: new THREE.Color('#0a0d12'),
      metalness: 0.4,
      roughness: 0.04,
      emissive: new THREE.Color('#0d1b2e'),
      emissiveIntensity: 0.3
    })
  );
  glass.position.y = thickness * 0.46;
  group.add(glass);

  /* ③ 屏幕显示区（几乎铺满正面，四周留窄边框）。 */
  const display = new THREE.Mesh(
    new THREE.PlaneGeometry(width * 0.94, length * 0.965),
    new THREE.MeshPhysicalMaterial({
      color: '#ffffff',
      map: mobile_screen_texture(),
      emissive: '#ffffff',
      emissiveMap: mobile_screen_texture(),
      emissiveIntensity: 0.38,
      roughness: 0.06,
      metalness: 0.03,
      clearcoat: 1,
      clearcoatRoughness: 0.04
    })
  );
  display.rotation.x = -Math.PI / 2;
  display.position.y = thickness * 0.56;
  group.add(display);
  /* ③' 屏幕边框亮边（抛光中框边缘，真机观感）。 */
  const bezel_material = chassis_material('#cfd8e3', { metalness: 0.85, roughness: 0.18 });
  for (const z of [-length * 0.487, length * 0.487]) {
    const rail = new THREE.Mesh(
      rounded_box(width * 0.985, thickness * 0.06, thickness * 0.48, thickness * 0.16),
      bezel_material
    );
    rail.position.set(0, thickness * 0.53, z);
    group.add(rail);
  }
  for (const x of [-width * 0.487, width * 0.487]) {
    const rail = new THREE.Mesh(
      rounded_box(thickness * 0.48, thickness * 0.06, length * 0.95, thickness * 0.16),
      bezel_material
    );
    rail.position.set(x, thickness * 0.53, 0);
    group.add(rail);
  }

  /* ④ 前摄挖孔（左上角小圆孔）。 */
  const punch_hole = new THREE.Mesh(
    new THREE.CylinderGeometry(width * 0.035, width * 0.035, thickness * 0.3, 14),
    plastic_material('#05070a', 0.9)
  );
  punch_hole.position.set(-width * 0.32, thickness * 0.52, -length * 0.4);
  group.add(punch_hole);

  /* ⑤ 后盖（玻璃/陶瓷质感，略低于中框下表面）。 */
  const back = new THREE.Mesh(
    rounded_box(width * 0.95, thickness * 0.18, length * 0.96, thickness * 0.4),
    new THREE.MeshStandardMaterial({
      color: new THREE.Color('#3a4048'),
      metalness: 0.35,
      roughness: 0.22
    })
  );
  back.position.y = -thickness * 0.44;
  group.add(back);

  /* ⑥ 后置镜头模组：凸起的方形台阶 + 两枚镜头 + 闪光灯。 */
  const camera_plate = new THREE.Mesh(
    rounded_box(width * 0.46, thickness * 0.5, width * 0.42, thickness * 0.2),
    shell_material('#22262c', { metalness: 0.8, roughness: 0.25 })
  );
  camera_plate.position.set(-width * 0.2, -thickness * 0.62, -length * 0.36);
  group.add(camera_plate);
  const lens_positions: [number, number][] = [
    [-0.09, -0.32],
    [-0.09, -0.42]
  ];
  for (const [x_ratio, z_ratio] of lens_positions) {
    const lens = new THREE.Mesh(
      new THREE.CylinderGeometry(width * 0.1, width * 0.1, thickness * 0.24, 18),
      chassis_material('#10141a', { metalness: 0.85, roughness: 0.2 })
    );
    lens.position.set(width * x_ratio, -thickness * 0.84, length * z_ratio);
    group.add(lens);
    const glass_lens = new THREE.Mesh(
      new THREE.CylinderGeometry(width * 0.055, width * 0.055, thickness * 0.3, 18),
      new THREE.MeshStandardMaterial({
        color: new THREE.Color('#0a2a4a'),
        roughness: 0.05,
        metalness: 0.2
      })
    );
    glass_lens.position.copy(lens.position);
    group.add(glass_lens);
  }
  const flash = new THREE.Mesh(
    new THREE.CylinderGeometry(width * 0.045, width * 0.045, thickness * 0.2, 14),
    emissive_material('#ffe9b0', 0.5)
  );
  flash.position.set(-width * 0.34, -thickness * 0.8, -length * 0.3);
  group.add(flash);

  /* ⑦ 侧键：右侧电源键 + 左侧音量键（金属小凸台）。 */
  const power_key = new THREE.Mesh(
    rounded_box(thickness * 0.22, thickness * 0.34, length * 0.1, thickness * 0.12),
    chassis_material('#b9c2cc', { metalness: 0.8, roughness: 0.28 })
  );
  power_key.position.set(width * 0.5, 0, -length * 0.12);
  group.add(power_key);
  const volume_key = new THREE.Mesh(
    rounded_box(thickness * 0.22, thickness * 0.34, length * 0.16, thickness * 0.12),
    chassis_material('#b9c2cc', { metalness: 0.8, roughness: 0.28 })
  );
  volume_key.position.set(-width * 0.5, 0, -length * 0.18);
  group.add(volume_key);

  /* ⑧ 底部扬声器开孔 + 麦克风孔（真机下沿一排小孔）。 */
  const speaker_items: { geometry: THREE.BufferGeometry; matrix: THREE.Matrix4 }[] = [];
  for (let index = 0; index < 6; index += 1) {
    const offset = (index - 2.5) * (width * 0.075);
    speaker_items.push({
      geometry: new THREE.CylinderGeometry(width * 0.012, width * 0.012, thickness * 0.5, 10),
      matrix: trs(offset, 0, length * 0.5)
    });
  }
  speaker_items.push({
    geometry: new THREE.CylinderGeometry(width * 0.012, width * 0.012, thickness * 0.5, 10),
    matrix: trs(-width * 0.36, 0, length * 0.5)
  });
  group.add(
    new THREE.Mesh(merge_geometries(speaker_items), plastic_material('#0b0e12', 0.85))
  );

  /* ⑨ 听筒窄缝（顶部）。 */
  const earpiece = new THREE.Mesh(
    rounded_box(width * 0.2, thickness * 0.16, thickness * 0.1, thickness * 0.06),
    plastic_material('#0b0e12', 0.85)
  );
  earpiece.position.set(0, thickness * 0.5, length * 0.44);
  group.add(earpiece);

  group.userData.chassis_size = { width: width, height: thickness, depth: length };

  return group;
}

/**
 * 笔记本底座（带掌托与转轴的楔形壳体）。
 *
 * @param {object} context 构建上下文。
 * @returns {THREE.Group} 机箱组。
 */
function build_laptop_base(context: { spec: { params: Record<string, unknown> } }): THREE.Group {
  const { spec } = context;
  const width = number_param(spec.params, 'width', 0.34);
  const depth = number_param(spec.params, 'depth', 0.24);
  const thickness = number_param(spec.params, 'thickness', 0.016);
  const color = color_param(spec.params, 'color', COLOR.chassis_mid);
  const group = new THREE.Group();
  const body = new THREE.Mesh(
    rounded_box(width, thickness, depth, 0.004),
    shell_material(color, { metalness: 0.64, roughness: 0.36 })
  );
  group.add(body);
  const deck = new THREE.Mesh(
    new THREE.BoxGeometry(width * 0.92, 0.002, depth * 0.82),
    plastic_material(COLOR.plastic_gray, 0.6)
  );
  deck.position.y = thickness / 2 + 0.0008;
  group.add(deck);
  for (const [x, z] of [
    [-0.4, -0.38],
    [0.4, -0.38],
    [-0.4, 0.38],
    [0.4, 0.38]
  ]) {
    const pad = new THREE.Mesh(
      new THREE.CylinderGeometry(0.006, 0.006, 0.002, 12),
      plastic_material('#0d1015', 0.95)
    );
    pad.position.set(width * x, -thickness / 2 - 0.001, depth * z);
    group.add(pad);
  }
  group.userData.chassis_size = { width: width, height: thickness, depth: depth };

  return group;
}

/**
 * 台式 PC 工作站：立式主机、显示器、支架、键盘与鼠标组成一个可绑定 VNC 的设备外观。
 *
 * @param {object} context 构建上下文。
 * @returns {THREE.Group} 工作站组；`vnc_screen` 子组声明实时画面投影区域。
 */
/** 生成带贯通网口孔的立式机箱外壳，RJ45 插头可穿过背板进入插座。 */
function pc_tower_geometry(): THREE.ExtrudeGeometry {
  const width = 0.18;
  const height = 0.42;
  const depth = 0.36;
  const radius = 0.008;
  const shape = new THREE.Shape();
  shape.moveTo(-width / 2 + radius, -height / 2);
  shape.lineTo(width / 2 - radius, -height / 2);
  shape.quadraticCurveTo(width / 2, -height / 2, width / 2, -height / 2 + radius);
  shape.lineTo(width / 2, height / 2 - radius);
  shape.quadraticCurveTo(width / 2, height / 2, width / 2 - radius, height / 2);
  shape.lineTo(-width / 2 + radius, height / 2);
  shape.quadraticCurveTo(-width / 2, height / 2, -width / 2, height / 2 - radius);
  shape.lineTo(-width / 2, -height / 2 + radius);
  shape.quadraticCurveTo(-width / 2, -height / 2, -width / 2 + radius, -height / 2);

  /* 机箱中心 x=0.22、y=-0.01；接口中心 y=0，因此孔中心局部 y=0.01。 */
  const opening = new THREE.Path();
  opening.moveTo(-0.0081, 0.01 - 0.0071);
  opening.lineTo(-0.0081, 0.01 + 0.0071);
  opening.lineTo(0.0081, 0.01 + 0.0071);
  opening.lineTo(0.0081, 0.01 - 0.0071);
  opening.closePath();
  shape.holes.push(opening);

  const geometry = new THREE.ExtrudeGeometry(shape, { depth: depth, bevelEnabled: false });
  geometry.center();
  return geometry;
}

function build_pc_workstation(context: {
  spec: { params: Record<string, unknown> };
}): THREE.Group {
  const { spec } = context;
  const case_color = color_param(spec.params, 'case_color', '#242a32');
  const accent_color = color_param(spec.params, 'accent_color', '#37e0c9');
  const group = new THREE.Group();

  /* ① 立式主机：尺寸按常见教学机箱，底面与整机包围盒对齐。 */
  const tower = new THREE.Mesh(
    pc_tower_geometry(),
    shell_material(case_color, { metalness: 0.52, roughness: 0.42 })
  );
  tower.position.set(0.22, -0.01, 0);
  tower.name = 'pc_tower_shell';
  group.add(tower);

  const front_inset = new THREE.Mesh(
    rounded_box(0.154, 0.37, 0.008, 0.005),
    plastic_material('#10151c', 0.64)
  );
  front_inset.position.set(0.22, -0.005, 0.183);
  group.add(front_inset);

  const power_ring = new THREE.Mesh(
    new THREE.TorusGeometry(0.011, 0.0018, 8, 28),
    chassis_material('#9da7b1', { metalness: 0.86, roughness: 0.24 })
  );
  power_ring.position.set(0.22, 0.125, 0.188);
  group.add(power_ring);
  const power_button = new THREE.Mesh(
    new THREE.CylinderGeometry(0.008, 0.008, 0.004, 24),
    emissive_material(accent_color, 0.12)
  );
  power_button.rotation.x = Math.PI / 2;
  power_button.position.set(0.22, 0.125, 0.188);
  power_button.name = 'pc_power_button';
  power_button.userData.power_button = true;
  group.add(power_button);

  /* 光驱位、前置 USB 和散热孔提供可读的真实主机正面结构。 */
  const drive_bay = new THREE.Mesh(
    rounded_box(0.125, 0.025, 0.006, 0.0015),
    plastic_material('#080b10', 0.82)
  );
  drive_bay.position.set(0.22, 0.07, 0.188);
  group.add(drive_bay);
  for (const x of [0.202, 0.238]) {
    const usb = new THREE.Mesh(
      rounded_box(0.013, 0.005, 0.006, 0.0008),
      chassis_material('#9aa5af', { metalness: 0.78, roughness: 0.28 })
    );
    usb.position.set(x, 0.025, 0.188);
    group.add(usb);
  }
  const intake = new THREE.Mesh(
    vent_grille(0.115, 0.105, 12, 0.003),
    plastic_material('#070a0e', 0.96)
  );
  intake.position.set(0.22, -0.095, 0.188);
  group.add(intake);

  /* ② 显示器：独立显示面直接承载 noVNC CanvasTexture。 */
  const monitor_width = 0.38;
  const monitor_height = 0.26;
  const monitor = screen_panel(monitor_width, monitor_height, '#07111d');
  monitor.position.set(-0.12, 0.08, 0.1);
  monitor.name = 'vnc_screen';
  const screen_surface = monitor.getObjectByName('screen_surface');
  if (screen_surface) {
    screen_surface.name = 'vnc_screen_surface';
  }
  monitor.userData.vnc_screen_size = {
    width: monitor_width * 0.94,
    height: monitor_height * 0.9
  };
  group.add(monitor);

  const stand = new THREE.Mesh(
    rounded_box(0.032, 0.16, 0.025, 0.004),
    chassis_material('#555d67', { metalness: 0.62, roughness: 0.38 })
  );
  stand.position.set(-0.12, -0.115, 0.085);
  group.add(stand);
  const stand_base = new THREE.Mesh(
    rounded_box(0.2, 0.012, 0.12, 0.006),
    chassis_material('#4b535d', { metalness: 0.58, roughness: 0.42 })
  );
  stand_base.position.set(-0.12, -0.214, 0.105);
  group.add(stand_base);

  /* ③ 键鼠作为工作站固定附件，近景时能辨认完整 PC 操作形态。 */
  const keyboard = keyboard_deck(0.35, 0.115, 5, 14);
  keyboard.position.set(-0.12, -0.215, 0.19);
  keyboard.name = 'pc_keyboard';
  group.add(keyboard);
  const mouse = new THREE.Mesh(
    rounded_box(0.052, 0.025, 0.085, 0.014),
    plastic_material('#262d36', 0.48)
  );
  mouse.position.set(0.095, -0.205, 0.19);
  group.add(mouse);

  group.userData.chassis_size = { width: 0.64, height: 0.46, depth: 0.48 };

  return group;
}

/** 机箱部件注册表。 */
export const CHASSIS_PARTS: PartDefinition[] = [
  {
    kind: 'rack_chassis',
    category: 'chassis',
    label: '机架式机箱（1U/2U）',
    defaults: {
      width: 0.442,
      height: 0.044,
      depth: 0.24,
      color: COLOR.chassis_light,
      ears: true,
      vents: true
    },
    schema: {
      width: { label: '宽（米）', min: 0.2, max: 0.6, step: 0.001 },
      height: { label: '高（米）', min: 0.02, max: 0.12, step: 0.001 },
      depth: { label: '深（米）', min: 0.1, max: 0.8, step: 0.005 },
      color: { label: '颜色', kind: 'color' },
      ears: { label: '安装耳', kind: 'boolean' },
      vents: { label: '侧通风', kind: 'boolean' }
    },
    build: build_rack_chassis
  },
  {
    kind: 'desktop_chassis',
    category: 'chassis',
    label: '桌面式机箱',
    defaults: { width: 0.086, height: 0.028, depth: 0.086, color: COLOR.plastic_gray },
    schema: {
      width: { label: '宽（米）', min: 0.03, max: 0.4, step: 0.001 },
      height: { label: '高（米）', min: 0.01, max: 0.2, step: 0.001 },
      depth: { label: '深（米）', min: 0.03, max: 0.4, step: 0.001 },
      color: { label: '颜色', kind: 'color' }
    },
    build: build_desktop_chassis
  },
  {
    kind: 'handheld_chassis',
    category: 'chassis',
    label: '手持式机箱（手机）',
    defaults: { width: 0.0715, height: 0.1467, depth: 0.0085, color: '#20242b' },
    schema: {
      width: { label: '宽（米）', min: 0.04, max: 0.2, step: 0.0005 },
      height: { label: '高（米）', min: 0.06, max: 0.3, step: 0.0005 },
      depth: { label: '厚（米）', min: 0.004, max: 0.03, step: 0.0005 },
      color: { label: '颜色', kind: 'color' }
    },
    build: build_handheld_chassis
  },
  {
    kind: 'phone_body',
    category: 'chassis',
    label: '手机机身（平放）',
    defaults: { width: 0.0715, length: 0.152, thickness: 0.0085, color: '#2a2f36' },
    schema: {
      width: { label: '宽（米）', min: 0.05, max: 0.12, step: 0.0005 },
      length: { label: '长（米）', min: 0.1, max: 0.2, step: 0.0005 },
      thickness: { label: '厚（米）', min: 0.005, max: 0.02, step: 0.0005 },
      color: { label: '中框颜色', kind: 'color' }
    },
    build: build_phone_body
  },
  {
    kind: 'laptop_base',
    category: 'chassis',
    label: '笔记本底座',
    defaults: { width: 0.34, depth: 0.24, thickness: 0.016, color: COLOR.chassis_mid },
    schema: {
      width: { label: '宽（米）', min: 0.2, max: 0.45, step: 0.005 },
      depth: { label: '深（米）', min: 0.15, max: 0.35, step: 0.005 },
      thickness: { label: '厚（米）', min: 0.008, max: 0.04, step: 0.001 },
      color: { label: '颜色', kind: 'color' }
    },
    build: build_laptop_base
  },
  {
    kind: 'pc_workstation',
    category: 'chassis',
    label: '台式 PC 工作站（VNC 显示器）',
    defaults: { case_color: '#242a32', accent_color: '#37e0c9' },
    schema: {
      case_color: { label: '主机颜色', kind: 'color' },
      accent_color: { label: '电源灯颜色', kind: 'color' }
    },
    build: build_pc_workstation
  }
];
