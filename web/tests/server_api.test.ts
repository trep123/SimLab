/** 服务器账户与实验文档客户端测试。 */

import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('服务器账户与实验库 API', () => {
  it('登录前获取 CSRF token，并用 Session 请求提交账户密码', async () => {
    const fetch_mock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ csrf_token: 'csrf-one' }), {
          headers: { 'Content-Type': 'application/json' }
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            csrf_token: 'csrf-two',
            user: { id: 7, username: 'teacher', is_staff: true, is_superuser: false }
          }),
          { headers: { 'Content-Type': 'application/json' } }
        )
      );
    vi.stubGlobal('fetch', fetch_mock);
    const { login_user } = await import('../src/core/server_api');

    const user = await login_user('teacher', 'secret');

    expect(user.username).toBe('teacher');
    expect(fetch_mock).toHaveBeenNthCalledWith(
      2,
      '/api/v1/auth/login/',
      expect.objectContaining({
        method: 'POST',
        credentials: 'same-origin',
        body: JSON.stringify({ username: 'teacher', password: 'secret' }),
        headers: expect.objectContaining({ 'X-CSRFToken': 'csrf-one' })
      })
    );
  });

  it('把服务器实验所有者和成员权限映射到实验库列表', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify([
            {
              id: '64a3c880-9488-48c3-a2db-2e5c70962d55',
              name: 'VLAN 实验',
              owner: 'teacher',
              role: 'VIEWER',
              config_revision: 4,
              has_document: true,
              device_count: 3,
              cable_count: 2,
              created_at: '2026-10-05T00:00:00Z',
              updated_at: '2026-10-05T01:00:00Z'
            }
          ]),
          { headers: { 'Content-Type': 'application/json' } }
        )
      )
    );
    const { list_server_experiments } = await import('../src/core/server_api');

    const experiments = await list_server_experiments();

    expect(experiments[0]).toMatchObject({
      experiment_id: '64a3c880-9488-48c3-a2db-2e5c70962d55',
      owner: 'teacher',
      role: 'VIEWER',
      device_count: 3
    });
  });

  it('HTML 代理错误返回稳定错误码，不触发 JSON Unexpected token', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('<!DOCTYPE html><title>Proxy error</title>', {
          status: 502,
          headers: { 'Content-Type': 'text/html' }
        })
      )
    );
    const { list_server_experiments, ServerApiError } = await import('../src/core/server_api');

    await expect(list_server_experiments()).rejects.toEqual(
      expect.objectContaining<Partial<InstanceType<typeof ServerApiError>>>({
        code: 'INVALID_API_RESPONSE'
      })
    );
  });
});
