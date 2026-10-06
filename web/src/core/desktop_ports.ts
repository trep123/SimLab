import { get_template } from '../devices/registry';
import { is_ethernet_port_module } from '../devices/port_module_expansion';
import type { PortLayoutGroup } from '../data/types';

/** 按前面板顺序返回以太网模块标识；名称保留给前端端口，VM 按顺序映射为 ethN。 */
export function desktop_port_keys(model_id: string): string[] {
  const template = get_template(model_id);
  const ethernet_names = (template?.parts || [])
    .filter(is_ethernet_port_module)
    .map((part) => String(part.params.short_name || ''));
  if (ethernet_names.some((name) => !name) || new Set(ethernet_names).size !== ethernet_names.length) {
    throw new Error('每个以太网模块都必须有唯一端口名；请在设备工坊修正后重试');
  }
  const device_type = template?.device_type;
  // 笔记本预留第 8 张网卡给逻辑射频口 RADIO0，避免超出 Runtime 的网卡上限。
  const nic_limit = device_type === 'laptop' ? 7 : device_type === 'pc' ? 8 : 32;
  if (ethernet_names.length > nic_limit) {
    throw new Error(`当前设备最多支持 ${nic_limit} 个以太网模块，请移除多余模块后重试`);
  }
  return ethernet_names.length ? ethernet_names : ['eth0'];
}

/** VM 内稳定接口名按前面板模块顺序一一映射。 */
export function desktop_port_aliases(model_id: string): string[] {
  return desktop_runtime_port_keys(model_id).map((_name, index) => `eth${index}`);
}

/** Runtime 网卡顺序：笔记本 RJ45 → eth0、RADIO0 → eth1，额外实体口顺延。 */
export function desktop_runtime_port_keys(model_id: string, nic_count?: number): string[] {
  const physical = desktop_port_keys(model_id);
  const is_laptop = get_template(model_id)?.device_type === 'laptop';
  if (!is_laptop || nic_count === physical.length) return physical;
  if (nic_count !== undefined && nic_count !== physical.length + 1) {
    throw new Error('NIC_PORTS_MISMATCH：笔记本需与实体网口数相同，或多一张射频虚拟网卡。');
  }
  if (physical.includes('RADIO0')) {
    throw new Error('NIC_PORT_MAPPING_INVALID：RADIO0 已被实体网口占用；请修改模块端口名。');
  }
  return [physical[0], 'RADIO0', ...physical.slice(1)];
}

/** 运行时端口清单由实体以太网模块生成，不能混入旧 Manifest 中的幽灵网口。 */
export function desktop_port_layout(model_id: string, port_keys: string[]): PortLayoutGroup[] {
  const modules = (get_template(model_id)?.parts || []).filter(is_ethernet_port_module);
  return port_keys.map((key, index) => {
    const module = modules.find((part) => part.params.short_name === key);
    const connector = String(module?.params.connector || 'rj45');
    return {
      group_id: `frontend-eth-${index}`,
      kind: connector,
      label: `${key} 实体接口`,
      speed_bps: Number(module?.params.speed_bps) || 1_000_000_000,
      poe: module?.params.poe === true,
      naming: { short_prefix: 'eth' },
      rows: [{ start_index: index, count: 1, names: [key] }]
    };
  });
}
