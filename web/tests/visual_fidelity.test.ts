/**
 * @File : web/tests/visual_fidelity.test.ts
 * @Time : 2026-10-04 21:18
 * @Author : Codex
 * @Description : 设备高精度外观防回归测试：圆角拓扑、合并几何、接口细节、风扇结构和真实装配朝向。
 */

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { assemble_device } from '../src/devices/assembler';
import {
  fan_module,
  iec_c14_jack,
  merge_geometries,
  rounded_box,
  trs
} from '../src/devices/part_kit';
import cisco_switch_template from '../src/devices/templates/cisco_c2960x_24ts_l';
import laptop_template from '../src/devices/templates/generic_laptop_wifi6';
import pc_template from '../src/devices/templates/generic_atx_pc';

/** 收集对象树内的名称，便于验证结构细节没有被简化掉。 */
function object_names(root: THREE.Object3D): string[] {
  const names: string[] = [];
  root.traverse((object) => {
    if (object.name) {
      names.push(object.name);
    }
  });

  return names;
}

describe('高精度几何原语', () => {
  it('圆角盒使用细分曲面并保持精确外形尺寸', () => {
    /* Act */
    const geometry = rounded_box(0.3, 0.04, 0.2, 0.004);
    geometry.computeBoundingBox();
    const size = geometry.boundingBox?.getSize(new THREE.Vector3());

    /* Assert */
    expect(geometry.getAttribute('position').count).toBeGreaterThan(100);
    expect(size?.x).toBeCloseTo(0.3, 5);
    expect(size?.y).toBeCloseTo(0.04, 5);
    expect(size?.z).toBeCloseTo(0.2, 5);
  });

  it('合并索引几何前会展开三角形，避免机框与栅格缺面', () => {
    /* Arrange */
    const first = new THREE.BoxGeometry(1, 1, 1);
    const second = new THREE.BoxGeometry(1, 1, 1);

    /* Act */
    const geometry = merge_geometries([
      { geometry: first, matrix: trs(-1, 0, 0) },
      { geometry: second, matrix: trs(1, 0, 0) }
    ]);
    geometry.computeBoundingBox();

    /* Assert：每个立方体展开后为 12 个三角形、36 个顶点。 */
    expect(geometry.index).toBeNull();
    expect(geometry.getAttribute('position').count).toBe(72);
    expect(geometry.boundingBox?.min.x).toBeCloseTo(-1.5, 6);
    expect(geometry.boundingBox?.max.x).toBeCloseTo(1.5, 6);
  });
});

describe('真实设备接口细节', () => {
  it('IEC C14 插座包含内凹腔体、三枚金属插片与固定件', () => {
    /* Act */
    const inlet = iec_c14_jack();
    const names = object_names(inlet);

    /* Assert */
    expect(names).toContain('iec_outer_bezel');
    expect(names).toContain('iec_recessed_cavity');
    expect(names.filter((name) => name === 'iec_ground_blade')).toHaveLength(1);
    expect(names.filter((name) => name === 'iec_power_blade')).toHaveLength(2);
    expect(names.filter((name) => name === 'iec_fastener')).toHaveLength(2);
  });

  it('轴流风扇采用镂空框、扇叶、风道和同心钢丝护网', () => {
    /* Act */
    const fan = fan_module(0.04);
    const names = object_names(fan);

    /* Assert */
    expect(names).toContain('fan_open_frame');
    expect(names).toContain('fan_duct');
    expect(names).toContain('fan_blades');
    expect(names.filter((name) => name === 'fan_guard_ring')).toHaveLength(3);
    expect(names.filter((name) => name === 'fan_guard_brace')).toHaveLength(2);
    expect(names.filter((name) => name === 'fan_fastener')).toHaveLength(4);
  });
});

describe('真实设备装配姿态', () => {
  it('机架电源口贴合背板并朝设备后方', () => {
    /* Act */
    const assembled = assemble_device(cisco_switch_template);
    const power = assembled.port_anchors.find((port) => port.connector === 'power_iec_c14');

    /* Assert */
    expect(power).toBeDefined();
    expect(power?.direction.z).toBeLessThan(-0.99);
    expect(power?.position.z).toBeLessThan(-cisco_switch_template.dimensions.depth * 0.48);
  });

  it('笔记本屏幕以铰链为轴打开且底边贴近底座', () => {
    /* Act */
    const assembled = assemble_device(laptop_template);
    const lid = assembled.group.getObjectByName('lid');
    const screen = assembled.group.getObjectByName('vnc_screen');
    const screen_surface = assembled.group.getObjectByName('vnc_screen_surface');
    const box = lid ? new THREE.Box3().setFromObject(lid) : null;

    /* Assert */
    expect(lid).toBeDefined();
    expect(box?.min.y).toBeLessThan(0.02);
    expect(box?.max.y).toBeGreaterThan(0.19);
    expect(screen?.userData.vnc_screen_size).toEqual({
      width: expect.any(Number),
      height: expect.any(Number)
    });
    expect(screen_surface).toBeInstanceOf(THREE.Mesh);
  });

  it('教学 PC 包含可投影 VNC 的显示器、真实电源键和 eth0 接口', () => {
    /* Act */
    const assembled = assemble_device(pc_template);
    const screen = assembled.group.getObjectByName('vnc_screen');
    const screen_surface = assembled.group.getObjectByName('vnc_screen_surface');
    const ethernet = assembled.port_anchors.find((port) => port.short_name === 'eth0');
    const names = object_names(assembled.group);
    const switch_names = object_names(assemble_device(cisco_switch_template).group);

    /* Assert */
    expect(screen?.userData.vnc_screen_size).toEqual({
      width: expect.any(Number),
      height: expect.any(Number)
    });
    expect(screen_surface).toBeInstanceOf(THREE.Mesh);
    expect(assembled.power_buttons).toHaveLength(1);
    expect(ethernet?.connector).toBe('rj45');
    expect(ethernet?.speed_bps).toBe(1_000_000_000);
    expect(ethernet?.direction.z).toBeLessThan(-0.99);
    expect(ethernet?.position.z).toBeCloseTo(-0.18, 3);
    expect(names).toContain('port_led_window_1_-1');
    expect(names).toContain('port_led_window_1_1');
    expect(names).toContain('port_label_eth0');
    expect(switch_names).toContain('port_led_window_1_-1');
    expect(switch_names).toContain('port_led_window_1_1');
    expect(switch_names).toContain('port_label_Gi1/0/1');
  });
});
