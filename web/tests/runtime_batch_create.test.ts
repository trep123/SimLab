import { beforeAll, describe, expect, it, vi } from 'vitest';

import { use_store } from '../src/core/store';
import { ensure_templates_loaded } from '../src/devices/registry';

import type { RuntimeClient } from '../src/core/runtime_types';
import type { DeviceRuntime } from '../src/core/device_runtime';

beforeAll(async () => {
  vi.stubGlobal('window', { localStorage: { getItem: () => null, setItem: () => undefined } });
  await ensure_templates_loaded();
});

describe('网络节点批量创建', () => {
  it('按 R1 递增命名并将设备错位放在实验台', async () => {
    const devices: Array<{ device_id: string; hostname: string; model_id: string; device_type: string }> = [];
    const positions: Array<{ x: number; z: number }> = [];
    const runtime = {
      list_devices: () => devices as DeviceRuntime[],
      get_device: (id: string) => (devices.find((device) => device.device_id === id) || null) as DeviceRuntime | null,
      create_device: vi.fn(async (model_id: string, hostname: string) => {
        const device_id = `dev-${devices.length + 1}`;
        devices.push({ device_id, hostname, model_id, device_type: 'router' });
        return { success: true, data: { device_id } };
      }),
      move_device: vi.fn(async (_id: string, position: { x: number; z: number }) => {
        positions.push(position);
        return { success: true };
      }),
      delete_device: vi.fn(async () => ({ success: true })),
      cables_snapshot: () => []
    } as unknown as RuntimeClient;
    const save = vi.fn(async () => undefined);
    use_store.setState({
      runtime,
      experiment_id: 'test-experiment',
      pending_runtime_device: {
        model_id: 'ruijie-rg-rsr20-x-28', position: { x: 2, y: 0, z: 3 }
      },
      desktop_runtime_busy: false,
      desktop_runtime_error: null,
      refresh_desktop_runtimes: async () => undefined,
      save_experiment: save
    });

    const last = await use_store.getState().create_device_without_runtime(3, 'R1');

    expect(last).toBe('dev-3');
    expect(devices.map((device) => device.hostname)).toEqual(['R1', 'R2', 'R3']);
    expect(positions).toEqual([{ x: 2, y: 0, z: 3 }, { x: 3.8, y: 0, z: 3 },
      { x: 5.6, y: 0, z: 3 }]);
    expect(save).toHaveBeenCalledOnce();
    expect(use_store.getState().pending_runtime_device).toBeNull();
  });

  it('每台新节点分别传入递增名称创建后端虚拟机', async () => {
    const devices: Array<{ device_id: string; hostname: string; model_id: string; device_type: string }> = [];
    const runtime = {
      list_devices: () => devices as DeviceRuntime[],
      get_device: (id: string) => (devices.find((device) => device.device_id === id) || null) as DeviceRuntime | null,
      create_device: vi.fn(async (model_id: string, hostname: string) => {
        const device_id = `dev-${devices.length + 1}`;
        devices.push({ device_id, hostname, model_id, device_type: 'router' });
        return { success: true, data: { device_id } };
      }),
      move_device: vi.fn(async () => ({ success: true })),
      delete_device: vi.fn(async () => ({ success: true })),
      cables_snapshot: () => []
    } as unknown as RuntimeClient;
    const requests: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      requests.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ success: true, instance: { id: `runtime-${requests.length}` } }), {
        status: 201, headers: { 'Content-Type': 'application/json' }
      });
    }));
    use_store.setState({
      runtime, experiment_id: 'test-experiment',
      pending_runtime_device: { model_id: 'ruijie-rg-rsr20-x-28' },
      refresh_desktop_runtimes: async () => undefined,
      save_experiment: async () => undefined,
      desktop_runtime_error: null
    });
    const spec = {
      profile_release_id: 'linux-router-profile-v1', image_release: 'uploaded-' + 'a'.repeat(64),
      vm_name: 'r1', memory_mib: 2048, vcpu_count: 2, disk_gib: 16,
      nic_model: 'virtio' as const, nic_aliases: ['eth0'], gpu_model: 'virtio' as const
    };

    await use_store.getState().create_device_with_new_runtime(spec, 2, 'R1');

    expect(requests.map((request) => request.display_name)).toEqual(['R1', 'R2']);
    expect(requests.map((request) => (request.spec as { vm_name: string }).vm_name)).toEqual(['r1', 'r2']);
    expect(use_store.getState().desktop_runtime_error).toBeNull();
    vi.unstubAllGlobals();
  });
});
