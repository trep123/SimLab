/**
 * @File : web/src/devices/port_module_expansion.ts
 * @Description : 将历史端口矩阵描述展开成单个物理接口部件，供工坊逐口编辑。
 */

import type { DeviceTemplate, PartSpec } from './template_types';

/** 仅将网络接口类别中的 Ethernet 连接器视为网卡；电源、Console、USB 等保持原类型。 */
export function is_ethernet_port_module(part: PartSpec): boolean {
  if (part.category === 'power' || !['network_port', 'single_port'].includes(part.kind)) {
    return false;
  }
  const connector = String(part.params.connector || (part.kind === 'network_port' ? 'rj45' : ''));
  return ['rj45', 'sfp', 'sfp_plus'].includes(connector);
}

/** 将大端口行展开为独立接口部件，同时保留原面板坐标和接口参数。 */
export function expand_port_row_modules(template: DeviceTemplate): DeviceTemplate {
  let changed = false;
  const parts = template.parts.flatMap((part): PartSpec[] => {
    if (part.kind !== 'port_row') {
      return [part];
    }
    changed = true;
    const params = part.params;
    const rows = Math.max(1, Math.round(Number(params.rows) || 1));
    const columns = Math.max(1, Math.round(Number(params.columns) || 1));
    const pitch_x = Number(params.pitch_x) || 0.0165;
    const pitch_y = Number(params.pitch_y) || 0.0155;
    const origin = Array.isArray(params.origin) ? params.origin : [0, 0, 0];
    const names = Array.isArray(params.names) ? params.names.map(String) : [];
    const name_prefix = String(params.name_prefix || 'GE0/0/');
    const group_id = String(params.group_id || part.part_id);
    const expanded: PartSpec[] = [];

    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const index = row * columns + column;
        const short_name = names[index] || `${name_prefix}${index + 1}`;
        const x = (column - (columns - 1) / 2) * pitch_x;
        const y = ((rows - 1) / 2 - row) * pitch_y;
        const part_suffix = short_name.replace(/[^a-zA-Z0-9_-]/g, '_');
        expanded.push({
          part_id: `${part.part_id}_${part_suffix}`,
          kind: 'network_port',
          category: 'port_module',
          label: `${short_name} 接口`,
          params: {
            connector: String(params.connector || 'rj45'),
            position: [Number(origin[0] || 0) + x, Number(origin[1] || 0) + y, Number(origin[2] || 0)],
            short_name: short_name,
            direction: [0, 0, 1],
            speed_bps: Number(params.speed_bps) || 1_000_000_000,
            group_id: group_id,
            poe: params.poe === true
          },
          ...(part.transform ? { transform: structuredClone(part.transform) } : {}),
          ...(part.removable === undefined ? {} : { removable: part.removable }),
          ...(part.explode === undefined ? {} : { explode: part.explode })
        });
      }
    }
    return expanded;
  });

  const used_names = new Set<string>();
  let next_ethernet_index = 0;
  const normalized_parts = parts.map((part) => {
    if (!is_ethernet_port_module(part)) {
      return part;
    }
    let short_name = String(part.params.short_name || '').trim();
    if (!short_name || used_names.has(short_name)) {
      while (used_names.has(`eth${next_ethernet_index}`)) {
        next_ethernet_index += 1;
      }
      short_name = `eth${next_ethernet_index++}`;
      used_names.add(short_name);
      return {
        ...part,
        category: 'port_module' as const,
        label: `${short_name} 网络接口`,
        params: { ...part.params, short_name }
      };
    }
    used_names.add(short_name);
    return part.category === 'port_module'
      ? part
      : { ...part, category: 'port_module' as const };
  });

  return changed || normalized_parts.some((part, index) => part !== parts[index])
    ? { ...template, parts: normalized_parts }
    : template;
}
