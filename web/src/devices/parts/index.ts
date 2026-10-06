/**
 * @File : web/src/devices/parts/index.ts
 * @Time : 2026-10-06 13:00
 * @Author : Cetrp
 * @Description : 部件注册表汇总：按 kind 索引全部参数化部件，供模板装配与设备工坊使用。
 */

import { CHASSIS_PARTS } from './chassis';
import { COMPUTE_PARTS } from './compute';
import { COOLING_PARTS } from './cooling';
import { FRONT_PANEL_PARTS } from './front_panel';
import { INTERNAL_PARTS } from './internal';
import { PORT_PARTS } from './port_module';
import { POWER_PARTS } from './power';
import { WIRELESS_PARTS } from './wireless';

import type { PartCategory, PartDefinition } from '../template_types';

/** 全部部件定义。 */
export const PART_DEFINITIONS: PartDefinition[] = [
  ...CHASSIS_PARTS,
  ...FRONT_PANEL_PARTS,
  ...PORT_PARTS,
  ...POWER_PARTS,
  ...COOLING_PARTS,
  ...WIRELESS_PARTS,
  ...COMPUTE_PARTS,
  ...INTERNAL_PARTS
];

/** kind → 部件定义。 */
const PART_INDEX = new Map<string, PartDefinition>(
  PART_DEFINITIONS.map((definition) => [definition.kind, definition])
);

/**
 * 按 kind 取部件定义。
 *
 * @param {string} kind 部件类型。
 * @returns {PartDefinition | null} 部件定义；不存在时为 null。
 */
export function get_part_definition(kind: string): PartDefinition | null {
  return PART_INDEX.get(kind) || null;
}

/**
 * 按类别筛选部件（设备工坊的部件栏）。
 *
 * @param {PartCategory} category 类别。
 * @returns {PartDefinition[]} 部件列表。
 */
export function parts_by_category(category: PartCategory): PartDefinition[] {
  return PART_DEFINITIONS.filter(
    (definition) => definition.category === category && definition.kind !== 'port_row'
  );
}

/** 设备工坊部件栏的分类顺序与中文名。 */
export const PART_CATEGORY_LABELS: { category: PartCategory; label: string }[] = [
  { category: 'chassis', label: '机箱' },
  { category: 'front_panel', label: '面板与指示' },
  { category: 'port_module', label: '独立接口' },
  { category: 'power', label: '电源' },
  { category: 'cooling', label: '散热' },
  { category: 'wireless', label: '无线' },
  { category: 'compute', label: '屏幕与输入' },
  { category: 'internal', label: '内部结构' },
  { category: 'accessory', label: '附件' }
];
