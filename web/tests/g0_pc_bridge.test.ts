/**
 * @File : web/tests/g0_pc_bridge.test.ts
 * @Time : 2026-10-04 23:50
 * @Author : Codex
 * @Description : G0 PC1 前端桥接测试：绑定请求与 HTML 错页安全降级。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { bind_g0_pc, fetch_g0_pc_binding } from '../src/core/g0_pc_bridge';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('simlab-g0-pc1 前端桥', () => {
  it('可把用户选中的前端 PC 作为绑定命令发送', async () => {
    const fetch_mock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          available: true,
          domain_name: 'simlab-g0-pc1',
          bound_device_id: 'dev-009',
          model_id: 'generic-atx-pc',
          display_name: 'PC-009',
          power_state: 'RUNNING',
          novnc_url: '/g0-novnc/vnc.html',
          vnc: { port: 5905 },
          source: 'observed',
          quality: 'real_runtime'
        }),
        { headers: { 'Content-Type': 'application/json' } }
      )
    );
    vi.stubGlobal('fetch', fetch_mock);

    const binding = await bind_g0_pc('64a3c880-9488-48c3-a2db-2e5c70962d55', 'dev-009', 'generic-atx-pc', 'PC-009');

    expect(binding.bound_device_id).toBe('dev-009');
    expect(fetch_mock).toHaveBeenCalledWith(
      '/api/v1/runtime/g0-pc1/',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({
          experiment_id: '64a3c880-9488-48c3-a2db-2e5c70962d55',
          device_id: 'dev-009',
          model_id: 'generic-atx-pc',
          display_name: 'PC-009'
        })
      })
    );
  });

  it('后端或代理返回 HTML 时生成可读错误，不抛出 JSON Unexpected token', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('<!DOCTYPE html><title>Vite fallback</title>', {
          headers: { 'Content-Type': 'text/html' }
        })
      )
    );

    const binding = await fetch_g0_pc_binding();

    expect(binding.success).toBe(false);
    expect(binding.error_code).toBe('G0_BRIDGE_UNAVAILABLE');
    expect(binding.message).toContain('没有返回 JSON');
  });
});
