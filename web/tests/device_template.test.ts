/**
 * @File : web/tests/device_template.test.ts
 * @Time : 2026-10-06 15:30
 * @Author : Cetrp
 * @Description : 设备模板与装配单元测试：部件注册表、模板装配、端口锚点、参数化生效与用户模板持久化。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PART_DEFINITIONS, get_part_definition, parts_by_category } from '../src/devices/parts';
import { assemble_device, template_bounds } from '../src/devices/assembler';
import { get_template, list_templates, save_user_template } from '../src/devices/registry';

import type { DeviceTemplate } from '../src/devices/template_types';

/**
 * 构造最小模板（1 台 8 口交换机）。
 *
 * @param {Partial<DeviceTemplate>} overrides 覆盖字段。
 * @returns {DeviceTemplate} 模板。
 */
function make_template(overrides: Partial<DeviceTemplate> = {}): DeviceTemplate {
  return {
    model_id: 'test-switch-8',
    vendor_id: 'test',
    display_name: '测试交换机 8 口',
    device_type: 'switch',
    dimensions: { width: 0.3, height: 0.04, depth: 0.2, u_height: 1 },
    rack_mountable: true,
    version: 1,
    origin: 'user',
    parts: [
      {
        part_id: 'chassis',
        kind: 'rack_chassis',
        category: 'chassis',
        label: '机箱',
        params: { width: 0.3, height: 0.04, depth: 0.2 }
      },
      {
        part_id: 'ports',
        kind: 'port_row',
        category: 'port_module',
        label: '8×GE',
        params: {
          connector: 'rj45',
          rows: 1,
          columns: 8,
          pitch_x: 0.017,
          origin: [0, 0, 0.1],
          name_prefix: 'GE0/0/'
        }
      }
    ],
    ports: [],
    leds: [{ name: 'SYS', position: [0, 0.01, 0.101], color: '#37e0c9' }],
    ...overrides
  };
}

describe('部件注册表', () => {
  it('内置部件覆盖机箱/面板/端口/电源/散热/无线/显示与内部结构', () => {
    /* Act */
    const categories = new Set(PART_DEFINITIONS.map((definition) => definition.category));

    /* Assert */
    expect(PART_DEFINITIONS.length).toBeGreaterThanOrEqual(16);
    for (const category of [
      'chassis',
      'front_panel',
      'port_module',
      'power',
      'cooling',
      'wireless',
      'compute',
      'internal'
    ]) {
      expect(categories.has(category as never)).toBe(true);
    }
  });

  it('每个部件都声明默认参数与中文说明', () => {
    /* Act & Assert */
    for (const definition of PART_DEFINITIONS) {
      expect(definition.kind.length).toBeGreaterThan(0);
      expect(definition.label.length).toBeGreaterThan(0);
      expect(Object.keys(definition.defaults).length).toBeGreaterThan(0);
    }
    expect(get_part_definition('port_row')).not.toBeNull();
    expect(get_part_definition('not_exist')).toBeNull();
    expect(parts_by_category('port_module').length).toBeGreaterThanOrEqual(3);
  });
});

describe('模板装配', () => {
  it('装配后可得到机箱与全部端口锚点', () => {
    /* Arrange */
    const template = make_template();

    /* Act */
    const assembled = assemble_device(template);

    /* Assert */
    expect(assembled.missing_kinds).toEqual([]);
    expect(assembled.port_anchors.length).toBe(8);
    expect(assembled.port_anchors[0].short_name).toBe('GE0/0/1');
    expect(assembled.port_anchors[0].connector).toBe('rj45');
    expect(assembled.group.children.length).toBeGreaterThanOrEqual(2);
    expect(assembled.leds.length).toBe(1);
  });

  it('端口锚点位于设备局部坐标且朝向设备外（+Z）', () => {
    /* Arrange */
    const template = make_template();

    /* Act */
    const assembled = assemble_device(template);
    const first = assembled.port_anchors[0];
    const last = assembled.port_anchors[7];

    /* Assert */
    expect(first.position.z).toBeCloseTo(0.1022, 4);
    expect(first.direction.z).toBeCloseTo(1, 6);
    expect(last.position.x).toBeGreaterThan(first.position.x);
  });

  it('端口数量由参数决定（参数化生效）', () => {
    /* Arrange */
    const template = make_template();
    const widened: DeviceTemplate = {
      ...template,
      parts: template.parts.map((part) =>
        part.part_id === 'ports'
          ? { ...part, params: { ...part.params, columns: 4, name_prefix: 'Gi0/0/' } }
          : part
      )
    };

    /* Act */
    const assembled = assemble_device(widened);

    /* Assert */
    expect(assembled.port_anchors.length).toBe(4);
    expect(assembled.port_anchors.map((anchor) => anchor.short_name)).toEqual([
      'Gi0/0/1',
      'Gi0/0/2',
      'Gi0/0/3',
      'Gi0/0/4'
    ]);
  });

  it('部件变换会传递到端口锚点（面板前移/旋转）', () => {
    /* Arrange */
    const template = make_template();
    const shifted: DeviceTemplate = {
      ...template,
      parts: template.parts.map((part) =>
        part.part_id === 'ports'
          ? { ...part, transform: { position: [0, 0.008, 0.01] } }
          : part
      )
    };

    /* Act */
    const assembled = assemble_device(shifted);

    /* Assert */
    expect(assembled.port_anchors[0].position.y).toBeCloseTo(0.008, 4);
    expect(assembled.port_anchors[0].position.z).toBeCloseTo(0.1122, 4);
    /* origin(0.1) + 模板偏移(0.01) + 插座开口平面(0.0022) = 0.1122 */
  });

  it('未注册的部件 kind 会被记录但不阻断装配', () => {
    /* Arrange */
    const template = make_template();
    template.parts.push({
      part_id: 'ghost',
      kind: 'not_a_part',
      category: 'accessory',
      label: '未知部件',
      params: {}
    });

    /* Act */
    const assembled = assemble_device(template);

    /* Assert */
    expect(assembled.missing_kinds).toEqual(['not_a_part']);
    expect(assembled.port_anchors.length).toBe(8);
  });

  it('template_bounds 返回正的外形尺寸', () => {
    /* Act */
    const bounds = template_bounds(make_template());

    /* Assert */
    expect(bounds.width).toBeGreaterThan(0.29);
    expect(bounds.height).toBeGreaterThan(0.03);
    expect(bounds.depth).toBeGreaterThan(0.19);
  });
});

describe('模板注册表与用户模板', () => {
  beforeEach(() => {
    const storage = new Map<string, string>();
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key)
      }
    });
  });

  it('保存用户模板后可再次取回（版本递增）', () => {
    /* Arrange */
    const template = make_template();

    /* Act */
    const saved = save_user_template(template);
    const loaded = get_template('test-switch-8');

    /* Assert */
    expect(saved.origin).toBe('user');
    expect(loaded).not.toBeNull();
    expect(loaded?.display_name).toBe('测试交换机 8 口');
    expect(list_templates().some((item) => item.model_id === 'test-switch-8')).toBe(true);
  });
});
