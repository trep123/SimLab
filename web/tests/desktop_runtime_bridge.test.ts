/**
 * @File : web/tests/desktop_runtime_bridge.test.ts
 * @Description : PC/笔记本虚拟机资源池前端桥接测试。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  bind_desktop_runtime,
  destroy_bound_desktop_runtime,
  fetch_desktop_runtimes,
  provision_desktop_runtime,
  release_desktop_runtimes
} from '../src/core/desktop_runtime_bridge';

afterEach(() => {
  vi.unstubAllGlobals();
});

const laptop_target = {
  experiment_id: '64a3c880-9488-48c3-a2db-2e5c70962d55',
  device_id: 'dev-012',
  model_id: 'generic-laptop-wifi6',
  display_name: 'Laptop-012',
  device_type: 'laptop'
};

describe('PC/笔记本虚拟机资源池前端桥', () => {
  it('能把已有虚拟机绑定到笔记本', async () => {
    const instance = {
      id: 'runtime-2',
      domain_name: 'simlab-g0-pc2',
      bound_device_id: 'dev-012'
    };
    const fetch_mock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, instance }), {
        headers: { 'Content-Type': 'application/json' }
      })
    );
    vi.stubGlobal('fetch', fetch_mock);

    const result = await bind_desktop_runtime('runtime-2', laptop_target);

    expect(result.domain_name).toBe('simlab-g0-pc2');
    expect(fetch_mock).toHaveBeenCalledWith(
      '/api/v1/runtime/desktops/runtime-2/binding/',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify(laptop_target) })
    );
  });

  it('创建新虚拟机时原样提交前端选择的受限资源参数', async () => {
    const spec = {
      profile_release_id: 'linux-cloud-profile-v1',
      image_release: 'ubuntu-noble-20260725',
      memory_mib: 3072,
      vcpu_count: 3,
      disk_gib: 24
    };
    const fetch_mock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, instance: { id: 'runtime-new' } }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' }
      })
    );
    vi.stubGlobal('fetch', fetch_mock);

    await provision_desktop_runtime(laptop_target, spec);

    expect(fetch_mock).toHaveBeenCalledWith(
      '/api/v1/runtime/desktops/',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ ...laptop_target, spec })
      })
    );
  });

  it('代理返回 HTML 时显示可读错误而不是 JSON 解析异常', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('<!DOCTYPE html><title>Vite fallback</title>', {
          headers: { 'Content-Type': 'text/html' }
        })
      )
    );

    const result = await fetch_desktop_runtimes();

    expect(result.available).toBe(false);
    expect(result.error_code).toBe('RUNTIME_BRIDGE_UNAVAILABLE');
    expect(result.message).toContain('没有返回 JSON');
  });

  it('删除前端设备时调用虚拟机生命周期销毁接口', async () => {
    const fetch_mock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          backend_destroyed: true,
          external_runtime_preserved: false,
          unbound_device_id: 'dev-exp-one-001'
        }),
        { headers: { 'Content-Type': 'application/json' } }
      )
    );
    vi.stubGlobal('fetch', fetch_mock);

    const result = await destroy_bound_desktop_runtime('runtime-managed', 'dev-exp-one-001');

    expect(result.backend_destroyed).toBe(true);
    expect(fetch_mock).toHaveBeenCalledWith(
      '/api/v1/runtime/desktops/runtime-managed/lifecycle/',
      expect.objectContaining({
        method: 'DELETE',
        body: JSON.stringify({ device_id: 'dev-exp-one-001' })
      })
    );
  });

  it('实验关闭使用 keepalive 批量关闭并解绑当前设备', async () => {
    const fetch_mock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, released: [] }), {
        headers: { 'Content-Type': 'application/json' }
      })
    );
    vi.stubGlobal('fetch', fetch_mock);

    await release_desktop_runtimes(laptop_target.experiment_id, ['dev-exp-one-001', 'dev-exp-one-001'], true);

    expect(fetch_mock).toHaveBeenCalledWith(
      '/api/v1/runtime/desktops/release/',
      expect.objectContaining({
        method: 'POST',
        keepalive: true,
        body: JSON.stringify({ experiment_id: laptop_target.experiment_id, device_ids: ['dev-exp-one-001'] })
      })
    );
  });
});
