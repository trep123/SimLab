/**
 * @File : web/src/cables/connectors.ts
 * @Time : 2026-10-04 13:20
 * @Author : Cetrp
 * @Description : 线缆端头参数化几何：水晶头/光纤接头/高速铜缆模块/电源插头/天线接头，
 *               全部用 part_kit 的几何原语拼装，统一朝向后交给线缆对象吸附到端口锚点。
 *
 *               坐标约定：局部 +Z 为插入方向（插入时插头前进的方向，即朝向端口内部），
 *               原点在插入端面（贴合端口开口的那一面），出线端在 -Z（IEC 直角插头为 -Y）。
 *               因此连接器本体从原点向 -Z 生长，插到面板上时整体露在机箱外侧。
 */

import * as THREE from 'three';

import {
  COLOR,
  chassis_material,
  merge_geometries,
  plastic_material,
  rounded_box,
  trs
} from '../devices/part_kit';

import type { CableKind } from './catalog';
import type { ConnectorType } from '../devices/template_types';

/** 出线点描述（连接器局部坐标）。 */
export interface ConnectorExit {
  /** 出线点相对插入端面的偏移（米，连接器局部坐标）。 */
  offset: THREE.Vector3;
  /** 出线方向（单位向量，连接器局部坐标，指向远离端口的一侧）。 */
  direction: THREE.Vector3;
}

/** 护套尾管末端到应力释放护套起点的固定长度（米）。 */
const JACKET_STUB_LENGTH = 0.008;

/** 各连接器的出线点（默认沿 -Z 直出，IEC 直角插头向下出线）。 */
const EXIT_TABLE: Record<string, ConnectorExit> = {
  rj45: { offset: new THREE.Vector3(0, 0, -0.046), direction: new THREE.Vector3(0, 0, -1) },
  sfp: { offset: new THREE.Vector3(0, 0, -0.045), direction: new THREE.Vector3(0, 0, -1) },
  sfp_plus: { offset: new THREE.Vector3(0, 0, -0.045), direction: new THREE.Vector3(0, 0, -1) },
  gpon: { offset: new THREE.Vector3(0, 0, -0.050), direction: new THREE.Vector3(0, 0, -1) },
  console_rj45: { offset: new THREE.Vector3(0, 0, -0.046), direction: new THREE.Vector3(0, 0, -1) },
  usb: { offset: new THREE.Vector3(0, 0, -0.053), direction: new THREE.Vector3(0, 0, -1) },
  power_iec_c14: {
    offset: new THREE.Vector3(0, -0.047, -0.012),
    direction: new THREE.Vector3(0, -1, 0)
  },
  power_dc_barrel: {
    offset: new THREE.Vector3(0, 0, -0.047),
    direction: new THREE.Vector3(0, 0, -1)
  },
  power_dc_terminal: {
    offset: new THREE.Vector3(0, 0, -0.041),
    direction: new THREE.Vector3(0, 0, -1)
  },
  antenna_sma: { offset: new THREE.Vector3(0, 0, -0.040), direction: new THREE.Vector3(0, 0, -1) }
};

/** SFP+ 高速铜缆模块的出线点（模块本体比 LC 接头长）。 */
const SFP_MODULE_EXIT: ConnectorExit = {
  offset: new THREE.Vector3(0, 0, -0.068),
  direction: new THREE.Vector3(0, 0, -1)
};

/** 缺省出线点（未登记连接器）。 */
const DEFAULT_EXIT: ConnectorExit = {
  offset: new THREE.Vector3(0, 0, -0.030),
  direction: new THREE.Vector3(0, 0, -1)
};

/** 缺省护套色（kind 缺失时）。 */
const FALLBACK_COLOR = '#2f6fd0';

/**
 * 取连接器的出线点（连接器局部坐标）。
 *
 * @param {ConnectorType} connector 连接器类型。
 * @param {CableKind | null} [kind] 线缆描述；SFP 口据此区分 LC 接头与 DAC 模块。
 * @returns {ConnectorExit} 出线点与出线方向（返回值可安全修改）。
 */
export function connector_exit(
  connector: ConnectorType,
  kind: CableKind | null = null
): ConnectorExit {
  if ((connector === 'sfp' || connector === 'sfp_plus') && !is_fiber_kind(kind)) {
    return { offset: SFP_MODULE_EXIT.offset.clone(), direction: SFP_MODULE_EXIT.direction.clone() };
  }
  const exit = EXIT_TABLE[connector] || DEFAULT_EXIT;
  return { offset: exit.offset.clone(), direction: exit.direction.clone() };
}

/**
 * 取连接器本体长度（米，用于预览线段的起始留白）。
 *
 * @param {ConnectorType} connector 连接器类型。
 * @param {CableKind | null} [kind] 线缆描述。
 * @returns {number} 长度（米）。
 */
export function connector_length(connector: ConnectorType, kind: CableKind | null = null): number {
  return Math.max(0.01, connector_exit(connector, kind).offset.length());
}

/**
 * 判断线缆是否为光纤（决定 SFP 口用 LC 接头还是 DAC 模块）。
 *
 * @param {CableKind | null} kind 线缆描述。
 * @returns {boolean} 是否光纤。
 */
function is_fiber_kind(kind: CableKind | null): boolean {
  return Boolean(kind && kind.category === 'fiber');
}

/**
 * 透明水晶头材质（RJ45）。
 *
 * @returns {THREE.MeshStandardMaterial} 材质。
 */
function crystal_material(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: new THREE.Color('#dce8f2'),
    transparent: true,
    opacity: 0.42,
    roughness: 0.12,
    metalness: 0.04
  });
}

/**
 * 镀金触点材质。
 *
 * @returns {THREE.MeshStandardMaterial} 材质。
 */
function gold_material(): THREE.MeshStandardMaterial {
  return chassis_material(COLOR.gold, { roughness: 0.28, metalness: 0.85 });
}

/**
 * 陶瓷插芯材质。
 *
 * @returns {THREE.MeshStandardMaterial} 材质。
 */
function ceramic_material(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: new THREE.Color('#f2f0e6'),
    roughness: 0.28,
    metalness: 0.02
  });
}

/**
 * 防尘帽材质（半透明灰）。
 *
 * @returns {THREE.MeshStandardMaterial} 材质。
 */
function dust_cap_material(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: new THREE.Color('#8d97a3'),
    transparent: true,
    opacity: 0.72,
    roughness: 0.5,
    metalness: 0.05
  });
}

/**
 * 护套材质（与线缆同色）。
 *
 * @param {CableKind} kind 线缆描述。
 * @param {number} [roughness] 粗糙度。
 * @returns {THREE.MeshStandardMaterial} 材质。
 */
function jacket_material(kind: CableKind, roughness = 0.62): THREE.MeshStandardMaterial {
  const color = kind && kind.color ? kind.color : FALLBACK_COLOR;
  return plastic_material(color, roughness);
}

/**
 * 取线缆护套半径（米）。
 *
 * @param {CableKind} kind 线缆描述。
 * @returns {number} 半径（米）。
 */
function jacket_radius(kind: CableKind): number {
  const diameter = kind && kind.diameter_m ? kind.diameter_m : 0.005;
  return Math.max(0.0015, diameter / 2);
}

/**
 * 造一个带局部变换的网格（几何体与材质由各连接器独占，便于线缆对象整体释放）。
 *
 * @param {THREE.BufferGeometry} geometry 几何体。
 * @param {THREE.Material} material 材质。
 * @param {number[]} [position] 位置 [x, y, z]。
 * @param {number[]} [rotation] 旋转 [rx, ry, rz]。
 * @returns {THREE.Mesh} 网格。
 */
function part_mesh(
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  position: number[] = [0, 0, 0],
  rotation: number[] = [0, 0, 0]
): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(position[0] || 0, position[1] || 0, position[2] || 0);
  mesh.rotation.set(rotation[0] || 0, rotation[1] || 0, rotation[2] || 0);

  return mesh;
}

/**
 * 沿 Z 轴的圆柱（CylinderGeometry 默认轴向为 Y，这里预旋转好）。
 *
 * @param {number} radius_top 靠端口一侧半径。
 * @param {number} radius_bottom 靠线缆一侧半径。
 * @param {number} length 长度（米）。
 * @param {number} [segments] 圆周分段。
 * @returns {THREE.BufferGeometry} 几何体（轴向 +Z）。
 */
function z_cylinder(
  radius_top: number,
  radius_bottom: number,
  length: number,
  segments = 16
): THREE.BufferGeometry {
  const geometry = new THREE.CylinderGeometry(radius_top, radius_bottom, length, segments);
  geometry.rotateX(Math.PI / 2);

  return geometry;
}

/**
 * 造应力释放护套 + 一段线缆外皮（连接器尾部收口）。
 *
 * @param {THREE.Group} group 目标组。
 * @param {CableKind} kind 线缆描述。
 * @param {number} start_z 护套起点（-Z，米）。
 * @param {number} length 护套长度（米）。
 * @returns {number} 尾管末端 Z 坐标（= 出线位置）。
 */
function append_boot(group: THREE.Group, kind: CableKind, start_z: number, length: number): number {
  const radius = jacket_radius(kind);
  group.add(
    part_mesh(z_cylinder(radius * 2.0, radius * 1.15, length, 18), jacket_material(kind), [
      0,
      0,
      start_z - length / 2
    ])
  );
  group.add(
    part_mesh(
      z_cylinder(radius * 1.05, radius * 1.05, JACKET_STUB_LENGTH, 16),
      jacket_material(kind, 0.75),
      [0, 0, start_z - length - JACKET_STUB_LENGTH / 2]
    )
  );

  return start_z - length - JACKET_STUB_LENGTH;
}

/**
 * RJ45 水晶头：透明头壳 + 弹片 + 8 根金手指 + 同色护套。
 *
 * @param {CableKind} kind 线缆描述。
 * @returns {THREE.Group} 连接器组。
 */
function build_rj45_plug(kind: CableKind): THREE.Group {
  const group = new THREE.Group();
  const width = 0.0116;
  const height = 0.0084;
  const depth = 0.0213;
  const crystal = crystal_material();
  group.add(part_mesh(rounded_box(width, height, depth, 0.0009), crystal, [0, 0, -depth / 2]));

  /* 卡扣弹片：插入后勾住插座，拔出时压下。 */
  group.add(
    part_mesh(
      rounded_box(width * 0.52, 0.0014, 0.0128, 0.0005),
      crystal,
      [0, height / 2 + 0.0006, -0.0088],
      [-0.1, 0, 0]
    )
  );

  /* 8 根金手指（PHY 触点）。 */
  const finger_items: { geometry: THREE.BufferGeometry; matrix: THREE.Matrix4 }[] = [];
  for (let index = 0; index < 8; index += 1) {
    const x = -width / 2 + (index + 0.5) * (width / 8);
    finger_items.push({
      geometry: new THREE.BoxGeometry(0.0007, 0.0006, 0.0072),
      matrix: trs(x, height / 2 - 0.0009, -0.0042)
    });
  }
  const contacts = new THREE.Mesh(merge_geometries(finger_items), gold_material());
  contacts.name = 'rj45_contacts';
  group.add(contacts);

  /* 超六类屏蔽网线：水晶头外加金属屏蔽壳。 */
  if (kind && kind.cable_id === 'cat6a') {
    group.add(
      part_mesh(
        rounded_box(width * 1.1, height * 1.14, depth * 0.62, 0.0008),
        chassis_material(COLOR.silver, { roughness: 0.35, metalness: 0.8 }),
        [0, 0, -depth * 0.68]
      )
    );
  }

  append_boot(group, kind, -depth + 0.001, 0.017);

  return group;
}

/**
 * LC 双芯光纤接头：两个陶瓷插芯 + 蓝色卡扣 + 防尘帽 + 同色护套。
 *
 * @param {CableKind} kind 线缆描述。
 * @returns {THREE.Group} 连接器组。
 */
function build_lc_connector(kind: CableKind): THREE.Group {
  const group = new THREE.Group();
  const clip_color = '#2f6fd0';
  for (const offset_x of [-0.0026, 0.0026]) {
    /* 1.25 mm 陶瓷插芯：芯尖落在插入端面。 */
    group.add(
      part_mesh(z_cylinder(0.00063, 0.00063, 0.0045, 14), ceramic_material(), [
        offset_x,
        0,
        -0.0022
      ])
    );
    /* 插芯座（蓝色卡扣本体）。 */
    group.add(
      part_mesh(
        rounded_box(0.0028, 0.0028, 0.0058, 0.0004),
        plastic_material(clip_color, 0.5),
        [offset_x, 0, -0.0056]
      )
    );
    /* 卡扣小舌：插入后勾住适配器。 */
    group.add(
      part_mesh(
        rounded_box(0.0032, 0.0014, 0.0076, 0.0004),
        plastic_material(clip_color, 0.42),
        [offset_x, 0.0026, -0.0088]
      )
    );
    /* 防尘帽：未插时罩住插芯，插好后由线缆对象隐藏。 */
    const cap = part_mesh(
      rounded_box(0.0022, 0.0022, 0.0062, 0.0005),
      dust_cap_material(),
      [offset_x, 0, -0.0026]
    );
    cap.name = 'dust_cap';
    cap.userData.is_dust_cap = true;
    group.add(cap);
    /* 推拉尾套。 */
    group.add(
      part_mesh(
        rounded_box(0.0046, 0.0048, 0.0106, 0.0006),
        plastic_material(clip_color, 0.55),
        [offset_x, 0, -0.0134]
      )
    );
  }
  /* 双芯并夹。 */
  group.add(
    part_mesh(rounded_box(0.0094, 0.0068, 0.0074, 0.0008), plastic_material('#e4e8ee', 0.6), [
      0,
      0,
      -0.0198
    ])
  );
  append_boot(group, kind, -0.0232, 0.014);

  return group;
}

/**
 * SC/APC 光接头：方口外壳 + 陶瓷插芯 + 绿色卡扣 + 防尘帽。
 *
 * @param {CableKind} kind 线缆描述。
 * @returns {THREE.Group} 连接器组。
 */
function build_sc_connector(kind: CableKind): THREE.Group {
  const group = new THREE.Group();
  const shell_color = kind && kind.color ? kind.color : '#2f9e63';
  /* 2.5 mm 陶瓷插芯（APC 斜面用短圆柱近似）。 */
  group.add(
    part_mesh(z_cylinder(0.00125, 0.00125, 0.0068, 16), ceramic_material(), [0, 0, -0.0034])
  );
  /* 方口内壳。 */
  group.add(
    part_mesh(
      rounded_box(0.0062, 0.0062, 0.0080, 0.0006),
      plastic_material(shell_color, 0.5),
      [0, 0, -0.0078]
    )
  );
  /* 外壳与卡扣。 */
  group.add(
    part_mesh(
      rounded_box(0.0092, 0.0082, 0.0146, 0.001),
      plastic_material(shell_color, 0.52),
      [0, 0, -0.019]
    )
  );
  group.add(
    part_mesh(
      rounded_box(0.0060, 0.0016, 0.011, 0.0004),
      plastic_material(shell_color, 0.42),
      [0, 0.0046, -0.0166]
    )
  );
  /* 防尘帽：罩住插芯与方口。 */
  const cap = part_mesh(
    rounded_box(0.0074, 0.0074, 0.0096, 0.0008),
    dust_cap_material(),
    [0, 0, -0.0052]
  );
  cap.name = 'dust_cap';
  cap.userData.is_dust_cap = true;
  group.add(cap);
  append_boot(group, kind, -0.0262, 0.016);

  return group;
}

/**
 * SFP/SFP+ 高速铜缆模块：金属外壳 + 拉环 + 同色线缆。
 *
 * @param {CableKind} kind 线缆描述。
 * @returns {THREE.Group} 连接器组。
 */
function build_sfp_module(kind: CableKind): THREE.Group {
  const group = new THREE.Group();
  const depth = 0.042;
  group.add(
    part_mesh(
      rounded_box(0.0137, 0.0086, depth, 0.0008),
      chassis_material(COLOR.silver, { roughness: 0.38, metalness: 0.72 }),
      [0, 0, -depth / 2]
    )
  );
  /* 端口面（光/电接口开口）。 */
  group.add(
    part_mesh(
      rounded_box(0.0116, 0.0068, 0.0024, 0.0004),
      plastic_material(COLOR.plastic_dark, 0.85),
      [0, 0, -0.0012]
    )
  );
  /* 锁扣。 */
  group.add(
    part_mesh(rounded_box(0.0124, 0.0012, 0.006, 0.0003), gold_material(), [0, 0.0044, -0.0028])
  );
  /* 拉环（解锁拉手）。 */
  const bail = new THREE.Mesh(
    new THREE.TorusGeometry(0.0042, 0.0007, 8, 20),
    chassis_material(COLOR.silver, { roughness: 0.3, metalness: 0.85 })
  );
  bail.position.set(0, 0, -depth - 0.0012);
  bail.rotation.y = Math.PI / 2;
  group.add(bail);
  group.add(
    part_mesh(
      rounded_box(0.0096, 0.0064, 0.0068, 0.0006),
      plastic_material(COLOR.plastic_gray, 0.6),
      [0, 0, -depth - 0.0026]
    )
  );
  append_boot(group, kind, -depth - 0.006, 0.012);

  return group;
}

/**
 * USB-A 插头（Console 线设备侧）。
 *
 * @param {CableKind} kind 线缆描述。
 * @returns {THREE.Group} 连接器组。
 */
function build_usb_plug(kind: CableKind): THREE.Group {
  const group = new THREE.Group();
  /* 金属屏蔽壳。 */
  group.add(
    part_mesh(
      rounded_box(0.0122, 0.0046, 0.012, 0.0005),
      chassis_material(COLOR.silver, { roughness: 0.35, metalness: 0.8 }),
      [0, 0, -0.0062]
    )
  );
  /* 白色舌片与 4 根触点。 */
  group.add(
    part_mesh(
      rounded_box(0.0104, 0.0022, 0.0104, 0.0003),
      plastic_material('#e8ecf2', 0.6),
      [0, -0.0006, -0.0064]
    )
  );
  const contact_items: { geometry: THREE.BufferGeometry; matrix: THREE.Matrix4 }[] = [];
  for (let index = 0; index < 4; index += 1) {
    contact_items.push({
      geometry: new THREE.BoxGeometry(0.0012, 0.0003, 0.008),
      matrix: trs(-0.0036 + index * 0.0024, 0.0006, -0.0064)
    });
  }
  group.add(new THREE.Mesh(merge_geometries(contact_items), gold_material()));
  /* 注塑尾套。 */
  group.add(
    part_mesh(rounded_box(0.0158, 0.0082, 0.022, 0.0016), jacket_material(kind), [
      0,
      0,
      -0.0226
    ])
  );
  append_boot(group, kind, -0.033, 0.012);

  return group;
}

/**
 * IEC C13 直角电源插头（插设备 C14 插座）：本体 + 三个插孔 + 向下出线。
 *
 * @param {CableKind} kind 线缆描述。
 * @returns {THREE.Group} 连接器组。
 */
function build_iec_plug(kind: CableKind): THREE.Group {
  const group = new THREE.Group();
  group.add(
    part_mesh(
      rounded_box(0.0266, 0.0192, 0.023, 0.0018),
      plastic_material(COLOR.plastic_dark, 0.72),
      [0, 0, -0.0115]
    )
  );
  /* 三个插孔（两个在上、一个在下）。 */
  const slots: [number, number][] = [
    [-0.0048, 0.0042],
    [0.0048, 0.0042],
    [0, -0.0048]
  ];
  for (const [slot_x, slot_y] of slots) {
    group.add(
      part_mesh(
        rounded_box(0.0034, 0.004, 0.003, 0.0004),
        plastic_material('#0c0f13', 0.9),
        [slot_x, slot_y, -0.0008]
      )
    );
  }
  /* 直角颈部 + 向下应力释放护套（该连接器沿 -Y 出线）。 */
  group.add(
    part_mesh(rounded_box(0.021, 0.0128, 0.0196, 0.0014), jacket_material(kind), [
      0,
      -0.0152,
      -0.0124
    ])
  );
  const radius = jacket_radius(kind);
  group.add(
    part_mesh(
      z_cylinder(radius * 1.9, radius * 1.2, 0.014, 16),
      jacket_material(kind),
      [0, -0.027, -0.0124],
      [-Math.PI / 2, 0, 0]
    )
  );
  group.add(
    part_mesh(
      z_cylinder(radius * 1.05, radius * 1.05, 0.013, 16),
      jacket_material(kind, 0.75),
      [0, -0.04, -0.0124],
      [-Math.PI / 2, 0, 0]
    )
  );

  return group;
}

/**
 * DC 桶形电源插头（5.5/2.1 mm）。
 *
 * @param {CableKind} kind 线缆描述。
 * @returns {THREE.Group} 连接器组。
 */
function build_dc_barrel_plug(kind: CableKind): THREE.Group {
  const group = new THREE.Group();
  /* 外筒（筒身向 -Z）+ 中心针。 */
  group.add(
    part_mesh(z_cylinder(0.00275, 0.00275, 0.0098, 18), chassis_material(COLOR.silver), [
      0,
      0,
      -0.0049
    ])
  );
  group.add(
    part_mesh(z_cylinder(0.00105, 0.00105, 0.0122, 12), gold_material(), [0, 0, -0.0061])
  );
  /* 筒口暗环（表现中空）。 */
  group.add(
    part_mesh(
      new THREE.RingGeometry(0.00105, 0.00275, 18),
      plastic_material('#0c0f13', 0.9),
      [0, 0, -0.0002]
    )
  );
  group.add(
    part_mesh(
      rounded_box(0.0088, 0.0088, 0.0176, 0.002),
      plastic_material(COLOR.plastic_gray, 0.7),
      [0, 0, -0.0184]
    )
  );
  append_boot(group, kind, -0.0272, 0.012);

  return group;
}

/**
 * DC 端子压接（接地/机柜供电用）：压接环 + 金属压接管 + 绝缘套。
 *
 * @param {CableKind} kind 线缆描述。
 * @returns {THREE.Group} 连接器组。
 */
function build_terminal_connector(kind: CableKind): THREE.Group {
  const group = new THREE.Group();
  const metal = chassis_material(COLOR.silver, { roughness: 0.32, metalness: 0.85 });
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.0026, 0.0009, 8, 20), metal);
  ring.position.set(0, 0, -0.0002);
  group.add(ring);
  group.add(part_mesh(z_cylinder(0.0018, 0.0018, 0.009, 14), metal, [0, 0, -0.0055]));
  /* 压接痕迹（两道棱）。 */
  for (const crimp_z of [-0.0044, -0.0066]) {
    group.add(part_mesh(z_cylinder(0.0021, 0.0021, 0.0009, 14), gold_material(), [0, 0, crimp_z]));
  }
  /* 绝缘套（黄绿接地线用同色）。 */
  group.add(
    part_mesh(z_cylinder(0.003, 0.0026, 0.013, 16), jacket_material(kind), [0, 0, -0.0166])
  );
  append_boot(group, kind, -0.0231, 0.01);

  return group;
}

/**
 * SMA 天线接头（内针 + 外螺纹筒 + 六角锁母 + 同轴线）。
 *
 * @param {CableKind} kind 线缆描述。
 * @returns {THREE.Group} 连接器组。
 */
function build_sma_connector(kind: CableKind): THREE.Group {
  const group = new THREE.Group();
  const metal = chassis_material(COLOR.gold, { roughness: 0.3, metalness: 0.85 });
  /* 内针 + 外螺纹筒。 */
  group.add(part_mesh(z_cylinder(0.0006, 0.0006, 0.0056, 10), metal, [0, 0, -0.0028]));
  group.add(part_mesh(z_cylinder(0.0024, 0.0024, 0.0082, 16), metal, [0, 0, -0.0041]));
  /* 六角锁母。 */
  const nut = new THREE.Mesh(
    new THREE.CylinderGeometry(0.0036, 0.0036, 0.0032, 6),
    chassis_material(COLOR.silver, { roughness: 0.35, metalness: 0.8 })
  );
  nut.rotation.x = Math.PI / 2;
  nut.position.set(0, 0, -0.0102);
  group.add(nut);
  group.add(
    part_mesh(z_cylinder(0.003, 0.0024, 0.012, 16), jacket_material(kind), [0, 0, -0.0178])
  );
  append_boot(group, kind, -0.0238, 0.008);

  return group;
}

/**
 * 通用连接器（未登记类型的兜底）：插头本体 + 同色护套。
 *
 * @param {CableKind} kind 线缆描述。
 * @returns {THREE.Group} 连接器组。
 */
function build_generic_connector(kind: CableKind): THREE.Group {
  const group = new THREE.Group();
  group.add(
    part_mesh(
      rounded_box(0.009, 0.009, 0.016, 0.0012),
      plastic_material(COLOR.plastic_gray, 0.6),
      [0, 0, -0.008]
    )
  );
  append_boot(group, kind, -0.016, 0.014);

  return group;
}

/**
 * 构造线缆端头几何。
 *
 * @param {ConnectorType} connector 连接器类型。
 * @param {CableKind} kind 线缆描述（决定护套颜色与屏蔽/光纤形态）。
 * @returns {THREE.Group} 连接器组；局部 +Z 为插入方向，原点在插入端面，出线端在 -Z。
 */
export function build_cable_connector(connector: ConnectorType, kind: CableKind): THREE.Group {
  let group: THREE.Group;
  switch (connector) {
    case 'rj45':
    case 'console_rj45':
      group = build_rj45_plug(kind);
      break;
    case 'sfp':
    case 'sfp_plus':
      /* 光纤跳线用 LC 双芯接头；DAC/铜缆用 SFP+ 金属模块。 */
      group = is_fiber_kind(kind) ? build_lc_connector(kind) : build_sfp_module(kind);
      break;
    case 'gpon':
      group = build_sc_connector(kind);
      break;
    case 'usb':
      group = build_usb_plug(kind);
      break;
    case 'power_iec_c14':
      group = build_iec_plug(kind);
      break;
    case 'power_dc_barrel':
      group = build_dc_barrel_plug(kind);
      break;
    case 'power_dc_terminal':
      group = build_terminal_connector(kind);
      break;
    case 'antenna_sma':
      group = build_sma_connector(kind);
      break;
    default:
      group = build_generic_connector(kind);
      break;
  }
  group.name = 'cable_connector_' + connector;
  group.userData.connector = connector;
  group.userData.insert_direction = new THREE.Vector3(0, 0, 1);

  return group;
}

/**
 * 显示/隐藏连接器上的防尘帽（拔下时罩住插芯，插好后收起）。
 *
 * @param {THREE.Object3D} connector_group 连接器组。
 * @param {boolean} visible 是否显示防尘帽。
 * @returns {void}
 */
export function set_dust_cap(connector_group: THREE.Object3D, visible: boolean): void {
  if (!connector_group) {
    return;
  }
  connector_group.traverse((child) => {
    if (child.userData && child.userData.is_dust_cap) {
      child.visible = visible;
    }
  });
}

/**
 * 判断连接器是否带防尘帽。
 *
 * @param {THREE.Object3D} connector_group 连接器组。
 * @returns {boolean} 是否带防尘帽。
 */
export function has_dust_cap(connector_group: THREE.Object3D): boolean {
  let found = false;
  if (!connector_group) {
    return found;
  }
  connector_group.traverse((child) => {
    if (child.userData && child.userData.is_dust_cap) {
      found = true;
    }
  });

  return found;
}
