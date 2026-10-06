/**
 * @File : web/tests/templates.test.ts
 * @Time : 2026-10-05 22:20
 * @Author : Cetrp
 * @Description : 内置设备模板一致性测试：遍历 templates 目录下的全部模板，校验型号命名、
 *               部件完整性、装配结果与 assets/catalog 的 port_layout / chassis 严格对齐。
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { assemble_device } from '../src/devices/assembler';

import type { PortAnchor } from '../src/devices/assembler';
import type { ConnectorType, DeviceTemplate, PartSpec } from '../src/devices/template_types';

/** 模板模块集合（构建期收集，键为模块路径）。 */
const TEMPLATE_MODULES = import.meta.glob('./../src/devices/templates/*.ts', {
  eager: true
}) as Record<string, { default: DeviceTemplate }>;

/** 测试文件目录与资产目录（web/tests → <repo>/assets/catalog）。 */
const HERE = dirname(fileURLToPath(import.meta.url));
const CATALOG_DIR = resolve(HERE, '../../assets/catalog');

/** 电源类锚点允许的短名：这些口不在 port_layout 中，属于整机供电接口。 */
const POWER_NAMES = new Set(['PWR', 'PWR1', 'PWR2', 'POWER', 'DC']);

/** 尺寸由既有版本冻结、本次不参与"资产尺寸"比对的模板。 */
const LEGACY_MODELS = new Set(['generic-onu-gpon', 'huawei-s5731-s24t4x']);

/**
 * 既有模板的冻结差异（本次任务不允许改动这两个文件，仅跳过对应单项断言）：
 * - generic-onu-gpon：GPON 口由 single_port 部件实现，该部件固定 speed_bps = 0 且 group_id = 'misc'；
 * - huawei-s5731-s24t4x：24×GE 端口行统一置 poe = true（资产为 poe = false），
 *   10GE 端口行 group_id 记为 'xge'（资产为 'xg'）。
 * 端口数量、名称、类型等断言对这些型号依然全部生效，新模板一律使用 port_row 承载数据端口。
 */
const LEGACY_SKIP_FIELDS: Record<string, string[]> = {
  'generic-onu-gpon': ['speed_bps', 'group_id'],
  'huawei-s5731-s24t4x': ['poe', 'group_id']
};

/** 手持设备：资产 chassis 已是米制，其余网络设备的资产数值为分米制。 */
const HANDHELD_TYPES = new Set(['laptop', 'phone']);

/** 资产 port_layout 中的一行端口。 */
interface AssetPortRow {
  /** 起始序号（缺省为 1）。 */
  start_index?: number;
  /** 本行端口数。 */
  count: number;
}

/** 资产 port_layout 中的一个端口组。 */
interface AssetPortGroup {
  /** 分组标识。 */
  group_id: string;
  /** 端口物理类型（rj45 / sfp / sfp_plus / combo）。 */
  kind: string;
  /** 速率（bps）。 */
  speed_bps: number;
  /** 是否支持 PoE。 */
  poe?: boolean;
  /** 命名前缀。 */
  naming: { name_prefix?: string; short_prefix: string };
  /** 端口行。 */
  rows: AssetPortRow[];
}

/** 资产清单（仅取测试关心的字段）。 */
interface AssetManifest {
  /** 型号 ID。 */
  model_id: string;
  /** 厂商 ID。 */
  vendor_id: string;
  /** 设备类型。 */
  device_type: string;
  /** 可视化规格。 */
  visual: {
    chassis: { width: number; height: number; depth: number; u_height?: number };
    port_layout: AssetPortGroup[];
  };
}

/** 期望端口（由资产 port_layout 展开）。 */
interface ExpectedPort {
  /** 端口短名。 */
  short_name: string;
  /** 连接器类型。 */
  connector: ConnectorType;
  /** 速率（bps）。 */
  speed_bps: number;
  /** 是否支持 PoE。 */
  poe: boolean;
  /** 分组标识。 */
  group_id: string;
}

/**
 * 由模块路径推导型号 ID。
 *
 * @param {string} path 模块路径（形如 ./../src/devices/templates/huawei_ar6120.ts）。
 * @returns {string} 型号 ID。
 */
function model_id_from_path(path: string): string {
  const file = path.split('/').pop() || '';
  return file.replace(/\.ts$/, '').replace(/_/g, '-');
}

/**
 * 读取型号对应的资产清单。
 *
 * @param {string} model_id 型号 ID。
 * @returns {AssetManifest} 资产清单。
 */
function load_manifest(model_id: string): AssetManifest {
  const raw = readFileSync(resolve(CATALOG_DIR, model_id + '.json'), 'utf8');
  return JSON.parse(raw) as AssetManifest;
}

/**
 * 解析端口组在三维模板中使用的连接器类型。
 *
 * 资产 kind 只有 rj45/sfp/sfp_plus/combo 四种，需要三类细化（与既有两个内置模板保持一致）：
 * 1) PON/USB/Console 口按命名前缀细化，保证线缆栏给出正确的线缆；
 * 2) 10GE 端口在资产里记为 sfp，按速率细化为 sfp_plus；
 * 3) combo 口（光电复用）以电口呈现。
 *
 * @param {AssetPortGroup} group 资产端口组。
 * @returns {ConnectorType} 连接器类型。
 */
function expected_connector(group: AssetPortGroup): ConnectorType {
  const prefix = group.naming.short_prefix;
  if (prefix.startsWith('GPON')) {
    return 'gpon';
  }
  if (prefix.startsWith('USB')) {
    return 'usb';
  }
  if (prefix.startsWith('CON')) {
    return 'console_rj45';
  }
  if (group.kind === 'combo') {
    return 'rj45';
  }
  if (group.kind === 'sfp' && group.speed_bps >= 10000000000) {
    return 'sfp_plus';
  }

  return group.kind as ConnectorType;
}

/**
 * 按资产 port_layout 展开全部数据端口。
 *
 * @param {AssetManifest} manifest 资产清单。
 * @returns {ExpectedPort[]} 期望端口列表。
 */
function expected_ports(manifest: AssetManifest): ExpectedPort[] {
  const ports: ExpectedPort[] = [];
  for (const group of manifest.visual.port_layout) {
    for (const row of group.rows) {
      const start = row.start_index === undefined ? 1 : row.start_index;
      for (let offset = 0; offset < row.count; offset += 1) {
        ports.push({
          short_name: group.naming.short_prefix + (start + offset),
          connector: expected_connector(group),
          speed_bps: group.speed_bps,
          poe: Boolean(group.poe),
          group_id: group.group_id
        });
      }
    }
  }

  return ports;
}

/**
 * 取模板中的机箱部件。
 *
 * @param {DeviceTemplate} template 设备模板。
 * @returns {PartSpec | undefined} 机箱部件。
 */
function chassis_part(template: DeviceTemplate): PartSpec | undefined {
  return template.parts.find((part) => part.category === 'chassis');
}

/**
 * 判断锚点是否为整机供电口（不属于 port_layout）。
 *
 * @param {PortAnchor} anchor 端口锚点。
 * @returns {boolean} 是否供电口。
 */
function is_power_anchor(anchor: PortAnchor): boolean {
  return anchor.group_id === 'power' || POWER_NAMES.has(anchor.short_name);
}

/**
 * 取机箱包围盒尺寸（优先部件参数，缺省回退模板尺寸）。
 *
 * @param {DeviceTemplate} template 设备模板。
 * @returns {{width: number; height: number; depth: number}} 尺寸（米）。
 */
function chassis_size(template: DeviceTemplate): {
  width: number;
  height: number;
  depth: number;
} {
  const params = (chassis_part(template) || { params: {} }).params as Record<string, number>;
  return {
    width: Number(params.width) || template.dimensions.width,
    height: Number(params.height || params.thickness) || template.dimensions.height,
    depth: Number(params.depth) || template.dimensions.depth
  };
}

/** 全部模板条目（模块路径 + 模板）。 */
const TEMPLATES = Object.entries(TEMPLATE_MODULES).map(([path, module]) => ({
  path: path,
  model_id: model_id_from_path(path),
  template: module.default
}));

describe('内置设备模板与资产一致性', () => {
  it('模板数量覆盖全部内置型号（含既有模板不少于 19 个）', () => {
    /* Assert */
    expect(TEMPLATES.length).toBeGreaterThanOrEqual(19);
    for (const entry of TEMPLATES) {
      expect(entry.template, entry.path).toBeTruthy();
      expect(entry.template.model_id.length).toBeGreaterThan(0);
    }
  });

  it('model_id 与文件名一致、parts 非空且必有 chassis 类别部件', () => {
    for (const entry of TEMPLATES) {
      /* Assert */
      expect(entry.template.model_id, entry.path).toBe(entry.model_id);
      expect(entry.template.parts.length, entry.model_id).toBeGreaterThan(0);
      expect(chassis_part(entry.template), entry.model_id).toBeTruthy();
      expect(entry.template.leds.length, entry.model_id).toBeGreaterThanOrEqual(2);
      expect(entry.template.description || '', entry.model_id).not.toBe('');
    }
  });

  it('每个模板都能装配成功且无缺失部件 kind', () => {
    for (const entry of TEMPLATES) {
      /* Act */
      const assembled = assemble_device(entry.template);

      /* Assert */
      expect(assembled.missing_kinds, entry.model_id).toEqual([]);
      expect(assembled.group.children.length, entry.model_id).toBeGreaterThan(2);
      expect(assembled.port_anchors.length, entry.model_id).toBeGreaterThan(0);
      expect(assembled.leds.length, entry.model_id).toBe(entry.template.leds.length);
    }
  });

  it('端口锚点与资产 port_layout 的数量、名称、类型、速率、PoE 完全一致', () => {
    for (const entry of TEMPLATES) {
      /* Arrange */
      const manifest = load_manifest(entry.model_id);
      const expected = expected_ports(manifest);

      /* Act */
      const anchors = assemble_device(entry.template).port_anchors;
      const data_anchors = anchors.filter((anchor) => !is_power_anchor(anchor));

      /* Assert：数量与名称（含分组）一一对应。 */
      expect(data_anchors.length, entry.model_id).toBe(expected.length);
      expect(
        data_anchors.map((anchor) => anchor.short_name).sort(),
        entry.model_id
      ).toEqual(expected.map((port) => port.short_name).sort());

      for (const port of expected) {
        const anchor = data_anchors.find((item) => item.short_name === port.short_name);
        const skip_fields = LEGACY_SKIP_FIELDS[entry.model_id] || [];
        expect(anchor, entry.model_id + ' ' + port.short_name).toBeTruthy();
        expect(anchor?.connector, entry.model_id + ' ' + port.short_name).toBe(port.connector);
        if (!skip_fields.includes('group_id')) {
          expect(anchor?.group_id, entry.model_id + ' ' + port.short_name).toBe(port.group_id);
        }
        if (!skip_fields.includes('speed_bps')) {
          expect(anchor?.speed_bps, entry.model_id + ' ' + port.short_name).toBe(port.speed_bps);
        }
        if (!skip_fields.includes('poe')) {
          expect(anchor?.poe, entry.model_id + ' ' + port.short_name).toBe(port.poe);
        }
      }
    }
  });

  it('端口锚点位于机箱外沿附近且 direction 为单位向量', () => {
    for (const entry of TEMPLATES) {
      /* Arrange */
      const size = chassis_size(entry.template);
      const anchors = assemble_device(entry.template).port_anchors;

      /* Assert */
      for (const anchor of anchors) {
        const distance = Math.max(
          Math.abs(anchor.position.x) / (size.width / 2),
          Math.abs(anchor.position.y) / (size.height / 2),
          Math.abs(anchor.position.z) / (size.depth / 2)
        );
        expect(distance, entry.model_id + ' ' + anchor.short_name).toBeGreaterThanOrEqual(0.5);
        expect(
          anchor.direction.length(),
          entry.model_id + ' ' + anchor.short_name
        ).toBeCloseTo(1, 5);
      }
    }
  });

  it('模板尺寸与机箱部件参数一致、厂商与设备类型与资产一致', () => {
    for (const entry of TEMPLATES) {
      /* Arrange */
      const manifest = load_manifest(entry.model_id);
      const size = chassis_size(entry.template);

      /* Assert：模板内部自洽。 */
      expect(entry.template.dimensions.width, entry.model_id).toBeCloseTo(size.width, 6);
      expect(entry.template.dimensions.depth, entry.model_id).toBeCloseTo(size.depth, 6);
      expect(entry.template.dimensions.height, entry.model_id).toBeGreaterThanOrEqual(size.height);

      /* Assert：与资产 manifest 对齐。 */
      expect(entry.template.vendor_id, entry.model_id).toBe(manifest.vendor_id);
      expect(entry.template.device_type, entry.model_id).toBe(manifest.device_type);
      expect(entry.template.rack_mountable, entry.model_id).toBe(
        Number(manifest.visual.chassis.u_height || 0) >= 1
      );
    }
  });

it('内置件不得露在机箱外（内部/电源/无线部件的包围盒落在机箱内）', () => {
    /* 说明：电池、天线、主板等"内置件"曾因在模板里多加了 90° 旋转而竖起来穿出机身，
       这里用包围盒约束把它们钉住（容差 6 mm，够容纳 PSU 提手/按键凸台等真机细节）。 */
    const TOLERANCE_M = 0.006;
    const INTERNAL_CATEGORIES = new Set(['internal', 'power', 'wireless']);
    /* 外置天线阵列本来就伸出机箱（真机 AP 的外置天线），不在约束内。 */
    const EXTERNAL_KINDS = new Set(['antenna_array']);

    for (const entry of TEMPLATES) {
      const assembled = assemble_device(entry.template);
      const chassis = assembled.group.children.find((child) => {
        const spec = child.userData.part_spec as PartSpec | undefined;
        return spec && spec.category === 'chassis';
      });
      if (!chassis) {
        continue;
      }
      assembled.group.updateMatrixWorld(true);
      const chassis_box = new THREE.Box3().setFromObject(chassis);
      const allowed = chassis_box.clone().expandByScalar(TOLERANCE_M);

      for (const child of assembled.group.children) {
        const spec = child.userData.part_spec as PartSpec | undefined;
        if (!spec || !INTERNAL_CATEGORIES.has(spec.category) || EXTERNAL_KINDS.has(spec.kind)) {
          continue;
        }
        const box = new THREE.Box3().setFromObject(child);
        const size = box.getSize(new THREE.Vector3());
        /* 逐轴计算超出量，便于定位是哪一侧冒出来。 */
        const overflow = {
          x: Math.max(allowed.min.x - box.min.x, box.max.x - allowed.max.x),
          y: Math.max(allowed.min.y - box.min.y, box.max.y - allowed.max.y),
          z: Math.max(allowed.min.z - box.min.z, box.max.z - allowed.max.z)
        };
        const outside = overflow.x > 0 || overflow.y > 0 || overflow.z > 0;
        expect(
          outside,
          entry.model_id +
            ' 的 ' +
            spec.part_id +
            '（' +
            spec.kind +
            '）超出机箱：尺寸 ' +
            [size.x, size.y, size.z].map((value) => value.toFixed(4)).join(' × ') +
            '，超出量 ' +
            [overflow.x, overflow.y, overflow.z].map((value) => value.toFixed(4)).join(' / ')
        ).toBe(false);
      }
    }
  });

  it('机箱尺寸按资产换算（手持设备米制，网络设备分米制）', () => {
    for (const entry of TEMPLATES) {
      /* Arrange：既有两个模板的尺寸由历史版本冻结，不做换算比对。 */
      if (LEGACY_MODELS.has(entry.model_id)) {
        continue;
      }
      const chassis = load_manifest(entry.model_id).visual.chassis;
      const scale = HANDHELD_TYPES.has(entry.template.device_type) ? 1 : 0.1;
      const size = chassis_size(entry.template);

      /* Assert */
      expect(size.width, entry.model_id).toBeCloseTo(chassis.width * scale, 4);
      expect(size.depth, entry.model_id).toBeCloseTo(chassis.depth * scale, 4);
      if (Number(chassis.u_height || 0) >= 1) {
        expect(entry.template.dimensions.height, entry.model_id).toBeCloseTo(0.0436, 4);
      } else if (!HANDHELD_TYPES.has(entry.template.device_type)) {
        expect(size.height, entry.model_id).toBeCloseTo(chassis.height * scale, 4);
      }
    }
  });

  it('打印模板清单（型号 → 端口数 / 机箱尺寸）', () => {
    /* Act & Assert */
    const lines: string[] = [];
    for (const entry of TEMPLATES) {
      const size = chassis_size(entry.template);
      const anchors = assemble_device(entry.template).port_anchors;
      const data_count = anchors.filter((anchor) => !is_power_anchor(anchor)).length;
      lines.push(
        [
          entry.model_id,
          entry.template.device_type,
          entry.template.vendor_id,
          'ports=' + data_count,
          'anchors=' + anchors.length,
          'size=' +
            size.width.toFixed(3) +
            '×' +
            size.height.toFixed(4) +
            '×' +
            size.depth.toFixed(3) +
            'm'
        ].join(' | ')
      );
    }
    console.log('\n' + lines.join('\n'));

    /* Assert */
    expect(lines.length).toBeGreaterThanOrEqual(19);
  });
});
