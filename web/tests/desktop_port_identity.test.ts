import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { EventBus } from '../src/core/event_bus';
import { LocalRuntime } from '../src/core/local_runtime';
import {
  desktop_port_aliases, desktop_port_keys, desktop_runtime_port_keys
} from '../src/core/desktop_ports';
import { clear_user_templates, ensure_templates_loaded, get_template, save_user_template } from '../src/devices/registry';

describe('PC 实体网口与运行时端口一一对应', () => {
  beforeAll(async () => {
    vi.stubGlobal('window', { localStorage: { getItem: () => null, setItem: () => undefined } });
    await ensure_templates_loaded();
  });

  afterEach(() => clear_user_templates());

  it('工坊将唯一网口重命名为 eth1 时，不保留旧 Manifest 的幽灵 eth0', async () => {
    const base = get_template('generic-atx-pc')!;
    save_user_template({
      ...structuredClone(base),
      parts: base.parts.map((part) => part.kind === 'network_port'
        ? { ...structuredClone(part), params: { ...part.params, short_name: 'eth1' } }
        : structuredClone(part))
    });
    const runtime = new LocalRuntime({ bus: new EventBus({ history_limit: 20 }), experiment_id: 'exp-test' });
    const created = await runtime.create_device('generic-atx-pc');
    expect(created.success).toBe(true);
    const device = runtime.get_device(String(created.data.device_id))!;
    expect(desktop_port_keys('generic-atx-pc')).toEqual(['eth1']);
    expect(desktop_port_aliases('generic-atx-pc')).toEqual(['eth0']);
    expect(device.ports.map((port) => port.short_name)).toEqual(['eth1']);
    expect(device.find_port('eth0')).toBeNull();
  });

  it('26 口交换机的每个实体模块都映射到独立虚拟网卡', () => {
    const ports = desktop_port_keys('cisco-c2960x-24ts-l');
    expect(ports).toHaveLength(26);
    expect(ports[0]).toBe('Gi1/0/1');
    expect(ports[25]).toBe('Gi1/0/26');
    expect(desktop_port_aliases('cisco-c2960x-24ts-l')[25]).toBe('eth25');
  });

  it('笔记本射频虚拟网卡与机身 RJ45 分离，且不生成可插线的幽灵端口', async () => {
    const runtime = new LocalRuntime({ bus: new EventBus({ history_limit: 20 }),
      experiment_id: 'exp-laptop' });
    const created = await runtime.create_device('generic-laptop-wifi6');
    const device = runtime.get_device(String(created.data.device_id))!;
    expect(desktop_port_keys('generic-laptop-wifi6')).toEqual(['ETH0/0/1']);
    expect(desktop_runtime_port_keys('generic-laptop-wifi6')).toEqual([
      'ETH0/0/1', 'RADIO0'
    ]);
    expect(desktop_port_aliases('generic-laptop-wifi6')).toEqual(['eth0', 'eth1']);
    expect(device.ports.map((port) => port.short_name)).toEqual(['ETH0/0/1']);
    expect(device.find_port('RADIO0')).toBeNull();
  });
});
