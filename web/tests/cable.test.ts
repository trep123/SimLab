/**
 * @File : web/tests/cable.test.ts
 * @Time : 2026-10-04 14:40
 * @Author : Cetrp
 * @Description : 线缆模块单元测试：线缆目录与选型、参数化连接器几何、线缆对象的端点吸附/
 *               走线控制点/状态材质/资源释放，以及线缆图层的同步、拾取与拖拽预览。
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';

import {
  CABLE_CATALOG,
  CableLayer,
  CableObject,
  build_cable_connector,
  cables_for_connector,
  connector_exit,
  default_cable_id_for,
  get_cable_kind,
  has_dust_cap,
  is_compatible,
  layer_records_from_cables,
  order_kind_for_connector,
  set_dust_cap
} from '../src/cables';

import type { CableKind } from '../src/cables';
import type { CableRecord } from '../src/data/types';
import type { ConnectorType } from '../src/devices/template_types';
import type { PortAnchor } from '../src/devices/assembler';

/** 全部连接器类型（目录覆盖性检查用）。 */
const ALL_CONNECTORS: ConnectorType[] = [
  'rj45',
  'sfp',
  'sfp_plus',
  'gpon',
  'console_rj45',
  'usb',
  'power_iec_c14',
  'power_dc_barrel',
  'power_dc_terminal',
  'antenna_sma'
];

/**
 * 造一个端口锚点。
 *
 * @param {Partial<PortAnchor>} overrides 覆盖字段。
 * @returns {PortAnchor} 锚点。
 */
function make_anchor(overrides: Partial<PortAnchor> = {}): PortAnchor {
  return {
    short_name: 'GE0/0/1',
    name: 'GigabitEthernet0/0/1',
    connector: 'rj45',
    position: new THREE.Vector3(0, 0.01, 0.1),
    direction: new THREE.Vector3(0, 0, 1),
    speed_bps: 1000000000,
    poe: false,
    group_id: 'ge',
    label: 'GE0/0/1',
    ...overrides
  };
}

/**
 * 造一个设备对象（带平移/旋转，用于验证端点吸附走的是世界变换）。
 *
 * @param {number[]} position 位置 [x, y, z]。
 * @param {number} [rotation_y] 绕 Y 轴旋转（弧度）。
 * @returns {THREE.Group} 设备组。
 */
function make_device(position: number[], rotation_y = 0): THREE.Group {
  const device = new THREE.Group();
  device.position.set(position[0], position[1], position[2]);
  device.rotation.y = rotation_y;
  device.updateMatrixWorld(true);

  return device;
}

/**
 * 造一条测试线缆（两台设备相距约 2.4 m）。
 *
 * @param {string} cable_id_kind 线缆类型 ID。
 * @param {number} [scene_scale] 场景比例。
 * @returns {CableObject} 线缆对象。
 */
function make_cable(cable_id_kind: string, scene_scale = 1): CableObject {
  const kind = get_cable_kind(cable_id_kind) as CableKind;

  return new CableObject({
    kind: kind,
    from: { anchor: make_anchor(), device_object: make_device([1.2, 0.8, -0.6], 0.6) },
    to: {
      anchor: make_anchor({ short_name: 'GE0/0/2', label: 'GE0/0/2' }),
      device_object: make_device([-0.4, 0.8, 1.1], -0.35)
    },
    scene_scale: scene_scale,
    cable_id: 'test-' + cable_id_kind
  });
}

/**
 * 取某种连接器的代表线缆类型（没有兼容线缆时退回第一条目录项）。
 *
 * @param {ConnectorType} connector 连接器类型。
 * @returns {CableKind} 线缆类型。
 */
function kind_for_connector(connector: ConnectorType): CableKind {
  const matched = cables_for_connector(connector);

  return matched.length > 0 ? matched[0] : (CABLE_CATALOG[0] as CableKind);
}

describe('线缆目录', () => {
  it('至少 9 种线缆，且每种字段完整、两端连接器都合法', () => {
    /* Act */
    const identifiers = CABLE_CATALOG.map((kind) => kind.cable_id);

    /* Assert */
    expect(CABLE_CATALOG.length).toBeGreaterThanOrEqual(9);
    expect(new Set(identifiers).size).toBe(CABLE_CATALOG.length);
    for (const kind of CABLE_CATALOG) {
      expect(kind.cable_id.length).toBeGreaterThan(0);
      expect(kind.label.length).toBeGreaterThan(0);
      expect(['copper', 'fiber', 'power', 'console']).toContain(kind.category);
      expect(kind.connectors.length).toBe(2);
      expect(ALL_CONNECTORS).toContain(kind.connectors[0]);
      expect(ALL_CONNECTORS).toContain(kind.connectors[1]);
      expect(kind.color).toMatch(/^#[0-9a-fA-F]{6}$/);
      expect(kind.diameter_m).toBeGreaterThan(0);
      expect(kind.max_length_m).toBeGreaterThan(0);
      expect(kind.speed_text.length).toBeGreaterThan(0);
      expect(kind.description.length).toBeGreaterThan(0);
      expect(kind.compatible_connectors.length).toBeGreaterThan(0);
      /* 两端连接器都必须在适用端口列表里。 */
      expect(kind.compatible_connectors).toContain(kind.connectors[0]);
      expect(kind.compatible_connectors).toContain(kind.connectors[1]);
    }
    expect(get_cable_kind('cat6')?.label).toContain('六类');
    expect(get_cable_kind('not_exist')).toBeNull();
    expect(get_cable_kind('')).toBeNull();
  });

  it('cables_for_connector 只返回兼容线缆，is_compatible 判定一致', () => {
    /* Act & Assert */
    for (const connector of ALL_CONNECTORS) {
      const matched = cables_for_connector(connector);
      for (const kind of matched) {
        expect(is_compatible(kind, connector)).toBe(true);
      }
      /* 目录里凡声明兼容的连接器都必须被查出来。 */
      for (const kind of CABLE_CATALOG) {
        if (kind.compatible_connectors.includes(connector)) {
          expect(matched.map((item) => item.cable_id)).toContain(kind.cable_id);
        }
      }
    }
    expect(cables_for_connector('rj45').map((kind) => kind.cable_id)).toEqual([
      'cat6',
      'cat6a'
    ]);
    expect(cables_for_connector('gpon').map((kind) => kind.cable_id)).toEqual(['fiber_sc']);
    expect(cables_for_connector('sfp_plus').map((kind) => kind.cable_id)).toEqual([
      'fiber_lc',
      'dac_sfp'
    ]);
    expect(cables_for_connector('antenna_sma')).toEqual([]);
    expect(is_compatible(get_cable_kind('cat6') as CableKind, 'gpon')).toBe(false);
    expect(is_compatible(get_cable_kind('ground') as CableKind, 'power_dc_terminal')).toBe(true);
  });

  it('default_cable_id_for 按端口给出缺省线缆', () => {
    /* Act & Assert */
    expect(default_cable_id_for('rj45')).toBe('cat6');
    expect(default_cable_id_for('sfp')).toBe('fiber_lc');
    expect(default_cable_id_for('sfp_plus')).toBe('fiber_lc');
    expect(default_cable_id_for('gpon')).toBe('fiber_sc');
    expect(default_cable_id_for('console_rj45')).toBe('console');
    expect(default_cable_id_for('usb')).toBe('console');
    expect(default_cable_id_for('power_iec_c14')).toBe('power_iec');
    expect(default_cable_id_for('power_dc_barrel')).toBe('power_dc');
    expect(default_cable_id_for('power_dc_terminal')).toBe('ground');
    expect(default_cable_id_for('antenna_sma')).toBe('');
    /* 每个缺省类型都必须能在目录里查到，并且兼容该端口。 */
    for (const connector of ALL_CONNECTORS) {
      const cable_id = default_cable_id_for(connector);
      if (!cable_id) {
        continue;
      }
      const kind = get_cable_kind(cable_id);
      expect(kind).not.toBeNull();
      expect(is_compatible(kind as CableKind, connector)).toBe(true);
    }
  });

  it('order_kind_for_connector 把起点端口放到第一端且不修改目录对象', () => {
    /* Arrange */
    const console_kind = get_cable_kind('console') as CableKind;

    /* Act */
    const ordered = order_kind_for_connector(console_kind, 'console_rj45');

    /* Assert */
    expect(ordered.connectors).toEqual(['console_rj45', 'usb']);
    expect(console_kind.connectors).toEqual(['usb', 'console_rj45']);
    expect(order_kind_for_connector(console_kind, 'usb')).toBe(console_kind);
    expect(order_kind_for_connector(console_kind, 'rj45')).toBe(console_kind);
  });
});

describe('连接器几何', () => {
  it('每种连接器都返回非空 Group，且本体长在插入端面的 -Z 侧', () => {
    /* Act & Assert */
    for (const connector of ALL_CONNECTORS) {
      const kind = kind_for_connector(connector);
      const group = build_cable_connector(connector, kind);
      const box = new THREE.Box3().setFromObject(group);

      expect(group).toBeInstanceOf(THREE.Group);
      expect(group.children.length).toBeGreaterThan(0);
      expect(group.userData.connector).toBe(connector);
      expect(group.userData.insert_direction.z).toBe(1);
      /* 插入端面在原点：连接器本体全部在 -Z 侧，最前端不越过端面。 */
      expect(box.min.z).toBeLessThan(-0.008);
      expect(box.max.z).toBeLessThanOrEqual(0.002);
    }
  });

  it('RJ45 水晶头带透明头壳与 8 根金手指，护套与线缆同色', () => {
    /* Arrange */
    const kind = get_cable_kind('cat6') as CableKind;

    /* Act */
    const group = build_cable_connector('rj45', kind);
    const contacts = group.getObjectByName('rj45_contacts') as THREE.Mesh;

    /* Assert */
    expect(contacts).toBeInstanceOf(THREE.Mesh);
    /* 8 根金手指合并成一个网格：顶点数远多于单个盒体（24）。 */
    expect(contacts.geometry.getAttribute('position').count).toBeGreaterThanOrEqual(8 * 8);
    const transparent_materials = group.children.filter((child) => {
      const material = (child as THREE.Mesh).material as THREE.MeshStandardMaterial;

      return material && material.transparent && material.opacity < 1;
    });
    expect(transparent_materials.length).toBeGreaterThanOrEqual(1);
    const jacket = group.children.find((child) => {
      const material = (child as THREE.Mesh).material as THREE.MeshStandardMaterial;

      return (
        material &&
        material.isMeshStandardMaterial &&
        material.color.getHex() === new THREE.Color(kind.color).getHex()
      );
    });
    expect(jacket).toBeDefined();
    expect(has_dust_cap(group)).toBe(false);
  });

  it('LC/SC 光纤接头带陶瓷插芯与防尘帽，DAC 模块带金属外壳与拉环', () => {
    /* Arrange */
    const fiber_kind = get_cable_kind('fiber_lc') as CableKind;
    const gpon_kind = get_cable_kind('fiber_sc') as CableKind;
    const dac_kind = get_cable_kind('dac_sfp') as CableKind;

    /* Act */
    const lc = build_cable_connector('sfp', fiber_kind);
    const sc = build_cable_connector('gpon', gpon_kind);
    const dac = build_cable_connector('sfp_plus', dac_kind);

    /* Assert */
    expect(lc.getObjectByName('dust_cap')).toBeInstanceOf(THREE.Mesh);
    expect(sc.getObjectByName('dust_cap')).toBeInstanceOf(THREE.Mesh);
    expect(has_dust_cap(lc)).toBe(true);
    expect(has_dust_cap(sc)).toBe(true);
    expect(has_dust_cap(dac)).toBe(false);
    /* 光纤接头有陶瓷插芯（白色圆柱），DAC 模块没有。 */
    const has_ceramic = (group: THREE.Group): boolean =>
      group.children.some((child) => {
        const material = (child as THREE.Mesh).material as THREE.MeshStandardMaterial;

        return Boolean(material) && material.color.getHex() === new THREE.Color('#f2f0e6').getHex();
      });
    expect(has_ceramic(lc)).toBe(true);
    expect(has_ceramic(sc)).toBe(true);
    expect(has_ceramic(dac)).toBe(false);
    /* DAC 模块有拉环（圆环几何）。 */
    const has_bail = dac.children.some((child) => {
      const geometry = (child as THREE.Mesh).geometry;

      return Boolean(geometry) && geometry.type === 'TorusGeometry';
    });
    expect(has_bail).toBe(true);
    /* 防尘帽可收起（插好后由线缆对象隐藏）。 */
    set_dust_cap(lc, false);
    expect(lc.getObjectByName('dust_cap')?.visible).toBe(false);
    set_dust_cap(lc, true);
    expect(lc.getObjectByName('dust_cap')?.visible).toBe(true);
  });

  it('电源连接器：IEC 直角向下出线、DC 桶形直出、端子压接黄绿绝缘套', () => {
    /* Arrange */
    const iec_kind = get_cable_kind('power_iec') as CableKind;
    const dc_kind = get_cable_kind('power_dc') as CableKind;
    const ground_kind = get_cable_kind('ground') as CableKind;

    /* Act */
    const iec_exit = connector_exit('power_iec_c14', iec_kind);
    const dc_exit = connector_exit('power_dc_barrel', dc_kind);
    const terminal = build_cable_connector('power_dc_terminal', ground_kind);
    const ground_colors = terminal.children.filter((child) => {
      const material = (child as THREE.Mesh).material as THREE.MeshStandardMaterial;

      return (
        material &&
        material.isMeshStandardMaterial &&
        material.color.getHex() === new THREE.Color(ground_kind.color).getHex()
      );
    });

    /* Assert */
    expect(iec_exit.direction.y).toBe(-1);
    expect(iec_exit.offset.y).toBeLessThan(0);
    expect(dc_exit.direction.z).toBe(-1);
    expect(ground_colors.length).toBeGreaterThan(0);
    /* SFP 口在光纤线缆下走 LC 接头（更短），在 DAC 下走模块（更长）。 */
    const lc_exit = connector_exit('sfp_plus', get_cable_kind('fiber_lc') as CableKind);
    const dac_exit = connector_exit('sfp_plus', get_cable_kind('dac_sfp') as CableKind);
    expect(dac_exit.offset.length()).toBeGreaterThan(lc_exit.offset.length());
  });
});

describe('线缆对象', () => {
  it('两端连接器吸附到锚点世界坐标（误差 < 1e-6）且朝向端口内部', () => {
    /* Arrange */
    const cable = make_cable('cat6');
    const from_anchor = cable.connector_object('from');
    const to_anchor = cable.connector_object('to');
    const from_device = make_device([0.35, 1.05, 0.2], -1.1);
    const to_device = make_device([-0.8, 1.05, -0.4], 0.4);

    /* Act */
    const from_offset = make_anchor({ position: new THREE.Vector3(0.03, 0.02, 0.12) });
    const to_offset = make_anchor({ position: new THREE.Vector3(-0.02, 0.03, 0.11) });
    cable.set_endpoint('from', from_offset, from_device);
    cable.set_endpoint('to', to_offset, to_device);
    const expected_from = cable.endpoint_world('from');
    const expected_to = cable.endpoint_world('to');
    const actual_from = new THREE.Vector3();
    const actual_to = new THREE.Vector3();
    from_anchor.getWorldPosition(actual_from);
    to_anchor.getWorldPosition(actual_to);

    /* Assert：接头原点沿端口轴向内座入（不横向偏移），深度不超过接头长度。 */
    const offset_from = actual_from.clone().sub(expected_from);
    const offset_to = actual_to.clone().sub(expected_to);
    const outward_from = cable.endpoint_direction('from');
    const outward_to = cable.endpoint_direction('to');
    expect(offset_from.dot(outward_from)).toBeLessThan(0);
    expect(offset_to.dot(outward_to)).toBeLessThan(0);
    expect(offset_from.length()).toBeLessThan(0.2);
    expect(offset_to.length()).toBeLessThan(0.2);
    /* 横向偏移为 0（严格贴合端口轴线）。 */
    expect(
      offset_from.clone().addScaledVector(outward_from, -offset_from.dot(outward_from)).length()
    ).toBeLessThan(1e-6);
    expect(
      offset_to.clone().addScaledVector(outward_to, -offset_to.dot(outward_to)).length()
    ).toBeLessThan(1e-6);
    /* 线缆本体从真实接口长出：曲线起点 = 起点连接器出线点。 */
    const curve_points = cable.route_curve.getPoints(8);
    expect(curve_points[0].distanceTo(cable.exit_world('from'))).toBeLessThan(1e-6);
    expect(curve_points[curve_points.length - 1].distanceTo(cable.exit_world('to'))).toBeLessThan(
      1e-6
    );
    /* 连接器局部 +Z = 插入方向（与锚点朝向相反，本体因此露在机箱外侧）。 */
    const insert_axis = new THREE.Vector3(0, 0, 1)
      .transformDirection(from_anchor.matrixWorld)
      .normalize();
    expect(insert_axis.dot(cable.endpoint_direction('from'))).toBeCloseTo(-1, 6);
  });

  it('默认走线带自然垂度（曲线最低点低于两端出线点）', () => {
    /* Arrange */
    const cable = make_cable('cat6');

    /* Act */
    const from_exit = cable.exit_world('from');
    const to_exit = cable.exit_world('to');
    const samples = cable.route_curve.getPoints(24);
    const lowest = samples.reduce(
      (min_y, point) => Math.min(min_y, point.y),
      Number.POSITIVE_INFINITY
    );

    /* Assert */
    expect(lowest).toBeLessThan(Math.min(from_exit.y, to_exit.y) - 0.01);
    expect(cable.route_length()).toBeGreaterThan(0.5);
    expect(cable.connector_types).toEqual(['rj45', 'rj45']);
    expect(cable.kind.cable_id).toBe('cat6');
    cable.dispose();
  });

it('可拉动的控制点：取样不改变形状，导入导出可复原走线', () => {
    /* Arrange */
    const cable = make_cable('cat6');
    const base_length = cable.route_length();
    const base_points = cable
      .route_curve
      .getPoints(24)
      .map((point) => [point.x, point.y, point.z] as [number, number, number]);

    /* Act：生成 3 个可拖拽控制点 */
    const created = cable.ensure_pull_waypoints(3);
    const after_length = cable.route_length();
    const exported = cable.export_waypoints();

    /* Assert：取样点落在曲线上，形状只有小幅变化（控制点接管后按 CatmullRom 重采样，
       实测偏差 < 8%）；重复调用幂等。 */
    expect(created).toBe(3);
    expect(exported.length).toBe(3);
    expect(Math.abs(after_length - base_length)).toBeLessThan(base_length * 0.08);
    expect(cable.ensure_pull_waypoints(3)).toBe(0);

    /* Act：拉动中间控制点 */
    const pulled = exported[1];
    cable.move_waypoint(1, new THREE.Vector3(pulled[0] + 1.5, pulled[1] + 0.8, pulled[2] + 0.4));
    const moved_length = cable.route_length();
    const moved_export = cable.export_waypoints();

    /* Assert：路径确实改变 */
    expect(Math.abs(moved_length - after_length)).toBeGreaterThan(0.05);
    expect(moved_export[1][1]).toBeCloseTo(pulled[1] + 0.8, 5);

    /* Act：清空后按导出数据复原 */
    cable.reset_route();
    expect(cable.waypoints.length).toBe(0);
    cable.import_waypoints(moved_export);

    /* Assert */
    expect(cable.waypoints.length).toBe(3);
    expect(cable.route_length()).toBeCloseTo(moved_length, 5);
    expect(base_points.length).toBe(25);
  });

  it('waypoint 增删改会改变走线长度，把手带拾取数据', () => {
    /* Arrange */
    const cable = make_cable('cat6');
    const base_length = cable.route_length();
    const middle = cable
      .exit_world('from')
      .clone()
      .add(cable.exit_world('to'))
      .multiplyScalar(0.5);

    /* Act：抬高走线 */
    const index = cable.add_waypoint(new THREE.Vector3(middle.x, middle.y + 1.2, middle.z));
    const lifted_length = cable.route_length();
    const handles = cable.waypoint_handles();

    /* Assert：默认走线是"贴地走线"，抬高走线点后应与两端直线距离比较，
       而不是与贴地长度比较（贴地本身更长）。 */
    const direct_length = cable.exit_world('from').distanceTo(cable.exit_world('to'));
    expect(index).toBe(0);
    expect(cable.waypoints.length).toBe(1);
    expect(lifted_length).toBeGreaterThan(direct_length);
    expect(handles.length).toBe(1);
    expect(handles[0].userData.cable_id).toBe(cable.cable_id);
    expect(handles[0].userData.waypoint_index).toBe(0);
    expect(handles[0].position.distanceTo(cable.waypoints[0])).toBeLessThan(1e-6);

    /* Act：压低走线 */
    const lowered_point = new THREE.Vector3(middle.x, middle.y - 0.7, middle.z);
    expect(cable.move_waypoint(0, lowered_point)).toBe(true);
    const lowered_length = cable.route_length();

    /* Assert */
    expect(Math.abs(lowered_length - lifted_length)).toBeGreaterThan(0.1);
    expect(lowered_length).toBeGreaterThan(direct_length);
    expect(base_length).toBeGreaterThan(direct_length);
    expect(cable.move_waypoint(9, middle)).toBe(false);
    expect(cable.remove_waypoint(-1)).toBe(false);

    /* Act：删除后恢复自然走线 */
    expect(cable.remove_waypoint(0)).toBe(true);

    /* Assert */
    expect(cable.waypoints.length).toBe(0);
    expect(cable.waypoint_handles().length).toBe(0);
    expect(cable.route_length()).toBeCloseTo(base_length, 5);

    /* Act：reset_route 清除全部控制点 */
    cable.add_waypoint(new THREE.Vector3(middle.x + 0.3, middle.y + 0.4, middle.z));
    cable.add_waypoint(new THREE.Vector3(middle.x - 0.3, middle.y + 0.2, middle.z));
    expect(cable.waypoint_handles().length).toBe(2);
    cable.reset_route();

    /* Assert */
    expect(cable.waypoints.length).toBe(0);
    expect(cable.route_length()).toBeCloseTo(base_length, 5);
    cable.dispose();
  });

  it('set_selected 加粗线径并显示走线把手', () => {
    /* Arrange */
    const cable = make_cable('cat6', 2);
    cable.add_waypoint(new THREE.Vector3(0.4, 1.6, 0.3));
    const base_radius = cable.sheath_radius();

    /* Act */
    cable.set_selected(true);

    /* Assert */
    expect(cable.selected).toBe(true);
    expect(cable.sheath_radius()).toBeGreaterThan(base_radius);
    const tube = cable.sheath_mesh.geometry as THREE.TubeGeometry;
    expect(tube.parameters.radius).toBeCloseTo(cable.sheath_radius(), 6);
    expect(cable.waypoint_handles()[0].visible).toBe(true);

    /* Act */
    cable.set_selected(false);

    /* Assert */
    expect(cable.sheath_radius()).toBeCloseTo(base_radius, 6);
    expect(cable.waypoint_handles()[0].visible).toBe(false);
    cable.dispose();
  });

  it('set_state 切换材质表现：UP 亮 / DOWN 暗 / CONNECTING 闪烁', () => {
    /* Arrange */
    const cable = make_cable('cat6');
    const sheath_color = new THREE.Color((get_cable_kind('cat6') as CableKind).color).getHex();

    /* Act：UP */
    cable.set_state('UP');
    const up_intensity = cable.sheath_material.emissiveIntensity;
    const up_color = cable.sheath_material.color.getHex();

    /* Assert */
    expect(cable.state).toBe('UP');
    expect(up_intensity).toBeGreaterThan(0.1);
    expect(up_color).toBe(sheath_color);
    expect(cable.sheath_material.emissive.getHex()).toBe(sheath_color);

    /* Act：流动粒子前进 */
    cable.update(0.3);
    const first_phase = cable.flow_phase;
    cable.update(0.3);

    /* Assert */
    expect(first_phase).toBeGreaterThan(0);
    expect(cable.flow_phase).toBeGreaterThan(first_phase);

    /* Act：DOWN */
    cable.set_state('DOWN');

    /* Assert */
    expect(cable.sheath_material.emissiveIntensity).toBe(0);
    expect(cable.sheath_material.color.getHex()).not.toBe(up_color);
    cable.update(0.3);
    expect(cable.flow_phase).toBe(0);

    /* Act：CONNECTING 闪烁 */
    cable.set_state('CONNECTING');
    const blink_first = cable.sheath_material.emissiveIntensity;
    cable.update(0.12);
    const blink_second = cable.sheath_material.emissiveIntensity;

    /* Assert */
    expect(blink_first).toBeGreaterThan(0);
    expect(Math.abs(blink_second - blink_first)).toBeGreaterThan(0.05);
    cable.dispose();
  });

  it('set_power_flow 控制电源线发光与流动（0 = 断电）', () => {
    /* Arrange */
    const cable = make_cable('power_iec');
    cable.set_state('UP');

    /* Act */
    cable.set_power_flow(1);
    const full_intensity = cable.sheath_material.emissiveIntensity;
    cable.set_power_flow(0.4);
    const half_intensity = cable.sheath_material.emissiveIntensity;

    /* Assert */
    expect(half_intensity).toBeLessThan(full_intensity);
    expect(half_intensity).toBeGreaterThan(0);

    /* Act：断电后不再流动 */
    cable.set_power_flow(0);
    cable.update(0.4);

    /* Assert */
    expect(cable.flow_phase).toBe(0);
    cable.dispose();
  });

  it('set_endpoint 改插到别的端口后重新吸附并重算走线', () => {
    /* Arrange */
    const cable = make_cable('cat6');
    const other_device = make_device([-1.4, 0.9, 0.6], 1.2);
    const other_anchor = make_anchor({
      short_name: 'GE0/0/5',
      label: 'GE0/0/5',
      position: new THREE.Vector3(-0.05, 0.01, 0.1)
    });
    const before_length = cable.route_length();

    /* Act */
    cable.set_endpoint('to', other_anchor, other_device);

    /* Assert */
    const expected = other_anchor.position.clone().applyMatrix4(other_device.matrixWorld);
    expect(cable.endpoint_world('to').distanceTo(expected)).toBeLessThan(1e-6);
    const connector_world = new THREE.Vector3();
    cable.connector_object('to').getWorldPosition(connector_world);
    /* 接头沿端口轴向内座入：只在轴线方向有位移。 */
    const seat_offset = connector_world.clone().sub(expected);
    const outward = cable.endpoint_direction('to');
    expect(seat_offset.dot(outward)).toBeLessThan(0);
    expect(seat_offset.length()).toBeLessThan(0.2);
    expect(cable.route_length()).not.toBeCloseTo(before_length, 4);
    cable.dispose();
  });

  it('scene_scale 按比例换算线径，dispose 释放几何体且可重复调用', () => {
    /* Arrange */
    const cable = make_cable('cat6', 4);
    cable.add_waypoint(new THREE.Vector3(0.4, 1.6, 0.3));
    cable.set_selected(true);
    const expected_radius = ((get_cable_kind('cat6') as CableKind).diameter_m * 4) / 2;

    /* Assert：选中会加粗，取消选中后回到按比例换算的基准线径 */
    cable.set_selected(false);
    expect(cable.sheath_radius()).toBeCloseTo(expected_radius, 6);

    /* Act */
    cable.set_scene_scale(2);
    let released = 0;
    cable.sheath_mesh.geometry.addEventListener('dispose', () => {
      released += 1;
    });
    const connector_mesh = cable.connector_object('from').children[0] as THREE.Mesh;
    connector_mesh.geometry.addEventListener('dispose', () => {
      released += 1;
    });
    cable.dispose();
    cable.dispose();

    /* Assert */
    expect(cable.disposed).toBe(true);
    expect(released).toBe(2);
    expect(cable.group.children.length).toBe(0);
    expect(cable.sheath_radius()).toBeCloseTo(expected_radius / 2, 6);
  });
});

describe('线缆图层', () => {
  /**
   * 造一套图层测试夹具（两台设备各一个端口）。
   *
   * @returns {object} 夹具。
   */
  function make_layer_fixture(): {
    layer: CableLayer;
    device_objects: Map<string, THREE.Object3D>;
    anchors: Map<string, Map<string, PortAnchor>>;
    record: {
      cable_id: string;
      cable_id_kind: string;
      from: { device_id: string; port: string };
      to: { device_id: string; port: string };
      state: string;
    };
  } {
    const layer = new CableLayer();
    const device_a = make_device([1.2, 0.8, -0.6], 0.6);
    const device_b = make_device([-0.4, 0.8, 1.1], -0.35);
    const device_objects = new Map<string, THREE.Object3D>([
      ['sw1', device_a],
      ['sw2', device_b]
    ]);
    const anchor_a = make_anchor();
    const anchor_b = make_anchor({ short_name: 'GE0/0/1', label: 'GE0/0/1' });
    const anchors = new Map<string, Map<string, PortAnchor>>([
      ['sw1', new Map([['GE0/0/1', anchor_a]])],
      ['sw2', new Map([['GE0/0/1', anchor_b]])]
    ]);
    const record = {
      cable_id: 'c1',
      cable_id_kind: 'cat6',
      from: { device_id: 'sw1', port: 'GE0/0/1' },
      to: { device_id: 'sw2', port: 'GE0/0/1' },
      state: 'UP'
    };

    return { layer: layer, device_objects: device_objects, anchors: anchors, record: record };
  }

  it('拔线：图层先播放退线动画，动画结束后才销毁对象', () => {
    /* Arrange */
    const fixture = make_layer_fixture();
    const { layer, device_objects, anchors, record } = fixture;
    layer.sync([record], device_objects, anchors, 1);
    expect(layer.get_cable('c1')).toBeTruthy();

    /* Act：记录消失（拔线） */
    layer.sync([], device_objects, anchors, 1);
    const cable = layer.get_cable('c1');
    const detached_before = layer.detached_count;

    /* Assert：已从索引移除但仍在播放退线动画 */
    expect(cable).toBeNull();
    expect(detached_before).toBe(1);

    /* Act：推进动画到结束 */
    for (let step = 0; step < 12; step += 1) {
      layer.update_detached(0.05);
    }

    /* Assert：动画结束后彻底释放 */
    expect(layer.detached_count).toBe(0);
  });

  it('标签避让：同一端口区的标签按偏移错开摆放', () => {
    /* Arrange */
    const fixture = make_layer_fixture();
    const { layer, device_objects, anchors, record } = fixture;
    layer.sync([record], device_objects, anchors, 1);
    const first = layer.get_cable('c1') as CableObject;

    /* Act：给端点设置避让偏移 */
    const base_position = first.label_position('from').clone();
    first.set_label_offset('from', new THREE.Vector3(0.5, 0.3, 0.2));
    const with_offset = first.label_position('from').clone();

    /* Assert：标签位置 = 锚点 + 偏移，复位后回到锚点 */
    expect(with_offset.distanceTo(base_position)).toBeGreaterThan(0.5);
    first.set_label_offset('from', new THREE.Vector3());
    expect(first.label_position('from').distanceTo(base_position)).toBeLessThan(1e-6);

    /* Act：批量自定义标签 */
    layer.set_custom_labels({ c1: { from: 'CAB-12A', to: 'CAB-12B' } });
    layer.sync([record], device_objects, anchors, 1);

    /* Assert：自定义文本优先（无 DOM 环境只校验状态） */
    expect(layer.get_cable('c1')?.label_text.from).toBe('CAB-12A');
    expect(layer.get_cable('c1')?.label_text.to).toBe('CAB-12B');
  });

  it('sync 增删改线缆，缺省类型按端口自动选型', () => {
    /* Arrange */
    const fixture = make_layer_fixture();
    const { layer, device_objects, anchors, record } = fixture;

    /* Act */
    layer.sync([record], device_objects, anchors, 1);

    /* Assert */
    expect(layer.count()).toBe(1);
    expect(layer.group.children.length).toBe(1);
    expect(layer.cable_ids()).toEqual(['c1']);
    const cable = layer.get_cable('c1');
    expect(cable?.kind.cable_id).toBe('cat6');
    expect(cable?.state).toBe('UP');

    /* Act：状态更新 */
    layer.sync([{ ...record, state: 'DOWN' }], device_objects, anchors, 1);

    /* Assert */
    expect(layer.get_cable('c1')?.state).toBe('DOWN');

    /* Act：缺省类型（不指定 cable_id_kind） */
    layer.sync(
      [{ ...record, cable_id: 'c2', cable_id_kind: null, state: 'UP' }],
      device_objects,
      anchors,
      1
    );

    /* Assert：rj45 端口缺省六类网线，且 c1 已被清理 */
    expect(layer.get_cable('c2')?.kind.cable_id).toBe('cat6');
    expect(layer.get_cable('c1')).toBeNull();
    expect(layer.count()).toBe(1);

    /* Act：设备移动后重新同步 */
    const before_length = layer.get_cable('c2')?.route_length() || 0;
    const moved_device = device_objects.get('sw2') as THREE.Group;
    moved_device.position.x -= 1.5;
    moved_device.updateMatrixWorld(true);
    layer.sync(
      [{ ...record, cable_id: 'c2', cable_id_kind: null, state: 'UP' }],
      device_objects,
      anchors,
      1
    );

    /* Assert */
    const after_cable = layer.get_cable('c2');
    expect(after_cable?.route_length()).toBeGreaterThan(before_length);
    const expected_to = anchors
      .get('sw2')
      ?.get('GE0/0/1')
      ?.position.clone()
      .applyMatrix4(moved_device.matrixWorld) as THREE.Vector3;
    expect(after_cable?.endpoint_world('to').distanceTo(expected_to)).toBeLessThan(1e-6);

    /* Act：清空记录 */
    layer.sync([], device_objects, anchors, 1);

    /* Assert */
    expect(layer.count()).toBe(0);
    /* 拔线走后是"退线动画 → 销毁"两段：动画播放完才从场景移除。 */
    for (let step = 0; step < 12; step += 1) {
      layer.update_detached(0.05);
    }
    expect(layer.detached_count).toBe(0);
    expect(layer.group.children.length).toBe(0);
    layer.dispose();
  });

  it('sync 跳过缺一端或缺少锚点的记录', () => {
    /* Arrange */
    const fixture = make_layer_fixture();
    const { layer, device_objects, anchors, record } = fixture;

    /* Act */
    layer.sync(
      [
        { ...record, cable_id: 'half', to: null },
        { ...record, cable_id: 'ghost_port', to: { device_id: 'sw2', port: 'GE9/9/9' } },
        { ...record, cable_id: 'ghost_device', to: { device_id: 'sw9', port: 'GE0/0/1' } }
      ],
      device_objects,
      anchors,
      1
    );

    /* Assert */
    expect(layer.count()).toBe(0);
    layer.dispose();
  });

  it('图层支持走线把手拾取与选中', () => {
    /* Arrange */
    const fixture = make_layer_fixture();
    const { layer, device_objects, anchors, record } = fixture;
    layer.sync([record], device_objects, anchors, 1);
    const cable = layer.get_cable('c1') as CableObject;

    /* Act */
    const index = layer.add_waypoint('c1', new THREE.Vector3(0.4, 1.6, 0.3));
    const handle = cable.waypoint_handles()[0];
    const pick = layer.pick_waypoint([{ object: handle } as unknown as THREE.Intersection]);
    const body_pick = layer.pick_waypoint([
      { object: cable.sheath_mesh } as unknown as THREE.Intersection
    ]);
    const cable_pick = layer.pick_cable([
      { object: cable.sheath_mesh } as unknown as THREE.Intersection
    ]);

    /* Assert */
    expect(index).toBe(0);
    expect(pick?.cable_id).toBe('c1');
    expect(pick?.waypoint_index).toBe(0);
    expect(pick?.cable).toBe(cable);
    expect(body_pick).toBeNull();
    expect(cable_pick).toBe('c1');
    expect(layer.pick_cable([])).toBeNull();

    /* 真实射线拾取：从线缆中点上方垂直下打，应命中线缆本体。 */
    expect(layer.pickable_meshes().length).toBe(1);
    expect(layer.waypoint_meshes().length).toBe(1);
    const wire_point = cable.route_curve.getPoint(0.5);
    const raycaster = new THREE.Raycaster(
      new THREE.Vector3(wire_point.x, wire_point.y + 1, wire_point.z),
      new THREE.Vector3(0, -1, 0)
    );
    const ray_hits = raycaster.intersectObjects(layer.pickable_meshes(), true);
    expect(ray_hits.length).toBeGreaterThan(0);
    expect(layer.pick_cable(ray_hits)).toBe('c1');

    /* Act：拖动把手 + 选中 */
    expect(layer.move_waypoint('c1', 0, new THREE.Vector3(0.4, 0.2, 0.3))).toBe(true);
    expect(layer.remove_waypoint('c1', 0)).toBe(true);
    expect(layer.remove_waypoint('c1', 0)).toBe(false);
    expect(layer.add_waypoint('c1', new THREE.Vector3(0.4, 0.6, 0.3))).toBe(0);
    expect(layer.reset_route('c1')).toBe(true);
    expect(layer.get_cable('c1')?.waypoints.length).toBe(0);
    layer.set_selected('c1');

    /* Assert */
    expect(layer.selected_id()).toBe('c1');
    expect(layer.get_cable('c1')?.selected).toBe(true);
    layer.set_selected(null);
    expect(layer.get_cable('c1')?.selected).toBe(false);

    /* Act：每帧更新 */
    layer.update(0.16);

    /* Assert：不抛异常且线缆仍在 */
    expect(layer.count()).toBe(1);
    layer.dispose();
  });

  it('拖拽预览：半截线缆跟随指针并吸附在起点端口，取消后释放', () => {
    /* Arrange */
    const fixture = make_layer_fixture();
    const { layer, device_objects, anchors, record } = fixture;
    layer.sync([record], device_objects, anchors, 1);
    const device_a = device_objects.get('sw1') as THREE.Object3D;
    const anchor_a = anchors.get('sw1')?.get('GE0/0/1') as PortAnchor;
    const target = new THREE.Vector3(2.1, 1.35, 0.75);

    /* Act */
    const created = layer.create_preview('fiber_lc', anchor_a, device_a);

    /* Assert */
    expect(created?.cable_id).toBe('fiber_lc');
    expect(layer.has_preview()).toBe(true);
    const preview_cable = layer.preview_cable() as CableObject;
    expect(preview_cable.kind.cable_id).toBe('fiber_lc');
    expect(preview_cable.state).toBe('CONNECTING');
    /* 预览的起点仍在真实端口上，悬空端的防尘帽保持可见。 */
    const preview_anchor_world = anchor_a.position.clone().applyMatrix4(device_a.matrixWorld);
    const preview_start = preview_cable.endpoint_world('from');
    expect(preview_start.distanceTo(preview_anchor_world)).toBeLessThan(1e-6);
    const preview_connector_world = new THREE.Vector3();
    preview_cable.connector_object('from').getWorldPosition(preview_connector_world);
    /* 接头沿端口轴向座入（只在轴线方向有位移，横向严格贴合）。 */
    const preview_seat = preview_connector_world.clone().sub(preview_anchor_world);
    const preview_outward = preview_cable.endpoint_direction('from');
    expect(preview_seat.dot(preview_outward)).toBeLessThan(0);
    expect(preview_seat.length()).toBeLessThan(0.2);
    expect(preview_cable.connector_object('to').getObjectByName('dust_cap')?.visible).toBe(true);

    /* Act */
    layer.update_preview(target);
    layer.update(0.16);

    /* Assert */
    expect(preview_cable.endpoint_world('to').distanceTo(target)).toBeLessThan(1e-6);
    expect(layer.get_cable('c1')?.kind.cable_id).toBe('cat6');

    /* Act */
    layer.cancel_preview();

    /* Assert */
    expect(layer.has_preview()).toBe(false);
    expect(layer.preview_cable()).toBeNull();
    expect(layer.create_preview('not_exist', anchor_a, device_a)).toBeNull();
    layer.dispose();
  });

  it('layer_records_from_cables 适配后端线缆记录', () => {
    /* Arrange */
    const cables: CableRecord[] = [
      {
        cable_id: 'c1',
        cable_type: 'cat6',
        state: 'UP',
        source: { device_id: 'sw1', port: 'GE0/0/1' },
        target: { device_id: 'sw2', port: 'GE0/0/1' }
      },
      {
        cable_id: 'c2',
        cable_type: 'ETHERNET_COPPER',
        state: 'DOWN',
        source: { device_id: 'sw1', port: 'GE0/0/2' },
        target: null
      }
    ];

    /* Act */
    const records = layer_records_from_cables(cables, new Map([['c1', 'fiber_sc']]));

    /* Assert */
    expect(records.length).toBe(2);
    expect(records[0].cable_id_kind).toBe('fiber_sc');
    expect(records[0].to).toEqual({ device_id: 'sw2', port: 'GE0/0/1' });
    expect(records[1].cable_id_kind).toBeNull();
    expect(records[1].to).toBeNull();
  });
});

describe('线缆走线物理与插拔动画', () => {
  it('避障：路径不穿过设备包围盒，且折角满足最小弯曲半径', () => {
    /* Arrange */
    const cable = make_cable('cat6');
    const from_exit = cable.exit_world('from');
    const to_exit = cable.exit_world('to');
    const middle = from_exit.clone().add(to_exit).multiplyScalar(0.5);
    /* 在两端之间放一个"设备"挡路 */
    const obstacle = new THREE.Box3(
      new THREE.Vector3(middle.x - 0.5, -0.2, middle.z - 0.5),
      new THREE.Vector3(middle.x + 0.5, 0.9, middle.z + 0.5)
    );

    /* Act */
    cable.set_obstacles([obstacle]);
    const points = cable.route_curve.getPoints(48);
    const inside_count = points.filter((point) => obstacle.containsPoint(point)).length;
    let min_radius = Number.POSITIVE_INFINITY;
    for (let index = 1; index < points.length - 1; index += 1) {
      const cross = new THREE.Vector3()
        .subVectors(points[index], points[index - 1])
        .cross(new THREE.Vector3().subVectors(points[index + 1], points[index]));
      const area = cross.length();
      if (area < 1e-7) {
        continue;
      }
      const radius =
        (points[index - 1].distanceTo(points[index]) *
          points[index].distanceTo(points[index + 1]) *
          points[index + 1].distanceTo(points[index - 1])) /
        (2 * area);
      min_radius = Math.min(min_radius, radius);
    }

    /* Assert：避开障碍，且折角半径不小于 0.1 场景单位 */
    expect(inside_count).toBe(0);
    expect(min_radius).toBeGreaterThan(0.1);
    cable.dispose();
  });

  it('插拔动画：插入有推进过程并自动结束，拔出需回调后才释放', () => {
    /* Arrange */
    const cable = make_cable('cat6');
    const seated = new THREE.Vector3();
    cable.connector_object('from').getWorldPosition(seated);

    /* Act：播放插入动画 */
    cable.play_insert();
    const animating_at_start = cable.animating;
    cable.update(0.05);
    const pulled = new THREE.Vector3();
    cable.connector_object('from').getWorldPosition(pulled);
    cable.update(0.4);

    /* Assert：动画期间插头有位移，结束后回到座上且不再动画 */
    expect(animating_at_start).toBe(true);
    expect(pulled.distanceTo(seated)).toBeGreaterThan(0.005);
    expect(cable.animating).toBe(false);
    const settled = new THREE.Vector3();
    cable.connector_object('from').getWorldPosition(settled);
    expect(settled.distanceTo(seated)).toBeLessThan(1e-6);

    /* Act：拔出动画 */
    let released = false;
    cable.play_unplug(() => {
      released = true;
    });
    cable.update(0.05);
    const still_animated = cable.animating;
    expect(released).toBe(false);
    /* 拔出总时长 0.55 s（轴向退出 + 悬垂），这里推进到结束。 */
    cable.update(0.6);

    /* Assert */
    expect(still_animated).toBe(true);
    expect(released).toBe(true);
    cable.dispose();
  });

  it('拔线悬垂：插头沿重力下垂，且不超过地面限制', () => {
    /* Arrange */
    const cable = make_cable('cat6');
    const port_world = cable.endpoint_world('from').clone();
    let released = false;
    cable.play_unplug(() => {
      released = true;
    });

    /* Act：推进到"轴向退出"结束（40%），再推进到悬垂中段 */
    cable.update(0.24);
    const after_withdraw = cable.endpoint_world('from').clone();
    cable.update(0.16);
    const mid_hang = cable.endpoint_world('from').clone();
    const mid_drop = port_world.y - mid_hang.y;
    cable.update(0.4);

    /* Assert：先沿出线方向脱出端口，再往下垂（下垂量 > 0 且 ≤ 30 cm 换算值 + 容差） */
    expect(after_withdraw.distanceTo(port_world)).toBeGreaterThan(0.01);
    expect(mid_drop).toBeGreaterThan(0.05);
    expect(mid_drop).toBeLessThanOrEqual(0.3 * cable.scene_scale + 1e-6);
    expect(released).toBe(true);
    cable.dispose();
  });

  it('改插预览：虚拟端点跟随指针且可恢复真实锚点', () => {
    /* Arrange */
    const cable = make_cable('cat6');
    const anchor_world = cable.endpoint_world('to');
    const target = anchor_world.clone().add(new THREE.Vector3(0.6, 0.3, 0.2));

    /* Act */
    cable.set_virtual_endpoint('to', target);

    /* Assert：端点跟随虚拟位置 */
    expect(cable.endpoint_world('to').distanceTo(target)).toBeLessThan(1e-6);

    /* Act：取消预览 */
    cable.clear_virtual_endpoint('to');

    /* Assert：回到真实锚点 */
    expect(cable.endpoint_world('to').distanceTo(anchor_world)).toBeLessThan(1e-6);
    cable.dispose();
  });
});
