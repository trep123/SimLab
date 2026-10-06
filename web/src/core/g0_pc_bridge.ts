/**
 * @File : web/src/core/g0_pc_bridge.ts
 * @Time : 2026-10-04 23:20
 * @Author : Codex
 * @Description : 本机 G0 PC1 绑定客户端：选择前端 PC、读取真实状态并控制固定虚拟机电源。
 */

import { ServerApiError, server_request_json } from './server_api';

/** G0 PC1 的前端投影。 */
export interface G0PcBinding {
  success: boolean;
  available: boolean;
  domain_name: string;
  bound_device_id: string | null;
  model_id: string | null;
  display_name: string | null;
  power_state: string;
  novnc_url: string;
  vnc: { listen?: string; port?: number };
  source: string;
  quality: string;
  message?: string;
  error_code?: string;
}

/** 统一解析 G0 桥响应，避免 HTML 错页再次触发 JSON 解析异常。 */
async function request_binding(path: string, options?: RequestInit): Promise<G0PcBinding> {
  try {
    return await server_request_json<G0PcBinding>(path, options);
  } catch (error) {
    return unavailable(
      error instanceof Error ? error.message : 'G0 控制接口不可用',
      error instanceof ServerApiError && error.code !== 'INVALID_API_RESPONSE'
        ? error.code
        : 'G0_BRIDGE_UNAVAILABLE'
    );
  }
}

/** 构造不可用状态。 */
function unavailable(message: string, error_code = 'G0_BRIDGE_UNAVAILABLE'): G0PcBinding {
  return {
    success: false,
    available: false,
    domain_name: 'simlab-g0-pc1',
    bound_device_id: null,
    model_id: null,
    display_name: null,
    power_state: 'UNKNOWN',
    novnc_url: '',
    vnc: {},
    source: 'unavailable',
    quality: 'real_runtime',
    message: message,
    error_code: error_code
  };
}

/** 读取当前绑定和真实 VM 状态。 */
export function fetch_g0_pc_binding(): Promise<G0PcBinding> {
  return request_binding('/api/v1/runtime/g0-pc1/');
}

/** 将 simlab-g0-pc1 改绑到选定前端 PC。 */
export function bind_g0_pc(
  experiment_id: string,
  device_id: string,
  model_id: string,
  display_name: string
): Promise<G0PcBinding> {
  return request_binding('/api/v1/runtime/g0-pc1/', {
    method: 'PUT',
    body: JSON.stringify({ experiment_id, device_id, model_id, display_name })
  });
}

/** 解除前端绑定，但不改变真实 VM 电源。 */
export function unbind_g0_pc(): Promise<G0PcBinding> {
  return request_binding('/api/v1/runtime/g0-pc1/', { method: 'DELETE' });
}

/** 启动或正常关闭已绑定的 simlab-g0-pc1。 */
export function power_g0_pc(
  device_id: string,
  is_on: boolean,
  keepalive = false
): Promise<G0PcBinding> {
  return request_binding('/api/v1/runtime/g0-pc1/power/', {
    method: 'POST',
    body: JSON.stringify({ device_id: device_id, on: is_on }),
    keepalive: keepalive
  });
}
