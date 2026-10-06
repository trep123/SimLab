/**
 * @File : web/src/core/desktop_runtime_bridge.ts
 * @Description : 桌面虚拟机资源池客户端：已有域绑定、受限规格创建、电源和 VNC 投影。
 */

import { ServerApiError, bootstrap_csrf, server_request_json } from './server_api';

/** 管理员上传独立 qcow2；返回后可在系统镜像清单中选用。 */
export async function upload_runtime_image(
  file: File, display_name: string, appliance_role: 'switch' | 'router' | 'firewall', vendor_id: string
): Promise<{ image_release: string; appliance_role: string }> {
  await bootstrap_csrf();
  const body = new FormData();
  body.append('image', file);
  body.append('display_name', display_name);
  body.append('appliance_role', appliance_role);
  body.append('vendor_id', vendor_id);
  return server_request_json('/api/v1/runtime/images/import/', { method: 'POST', body });
}

/** 将服务器 Vendor/model-version 目录中的候选镜像登记到不可变镜像仓库。 */
export async function register_vendor_image(folder: string): Promise<{ image_release: string }> {
  await bootstrap_csrf();
  return server_request_json('/api/v1/runtime/images/register-directory/', {
    method: 'POST', body: JSON.stringify({ folder })
  });
}

/** 为当前设备签发短期真实串口 WebSocket 地址。 */
export async function request_runtime_console(
  runtime_id: string, device_id: string
): Promise<{ console_url: string; quality: 'real_runtime' }> {
  await bootstrap_csrf();
  return server_request_json(`/api/v1/runtime/desktops/${runtime_id}/console/`, {
    method: 'POST', body: JSON.stringify({ device_id })
  });
}

/** 前端允许提交的虚拟机规格。 */
export interface DesktopRuntimeSpec {
  profile_release_id: string;
  image_release: string;
  vm_name: string;
  memory_mib: number;
  vcpu_count: number;
  disk_gib: number;
  nic_model: 'virtio' | 'e1000';
  nic_aliases: string[];
  gpu_model: 'virtio';
}

/** 后端批准的镜像与资源范围。 */
export interface DesktopRuntimeProfile {
  profile_release_id: string;
  image_release: string;
  display_name: string;
  device_types: string[];
  appliance_role?: 'switch' | 'router' | 'firewall';
  vendor_id?: string;
  model_id?: string;
  source_folder?: string;
  limits: {
    memory_mib: [number, number];
    vcpu_count: [number, number];
    disk_gib: [number, number];
  };
  defaults: { memory_mib: number; vcpu_count: number; disk_gib: number };
  capabilities: {
    nic_models: Array<'virtio' | 'e1000'>;
    nic_count: [number, number];
    gpu_models: Array<'virtio'>;
  };
}

export interface VendorImageCandidate {
  folder: string;
  vendor_id: string;
  model_id: string;
  appliance_role: 'switch' | 'router' | 'firewall';
  display_name: string;
  device_type: string;
  file_name: string | null;
  status: 'READY_TO_REGISTER' | 'MULTIPLE_DISKS' | 'IMAGE_MISSING';
  registered: boolean;
}

/** 一台可绑定后端虚拟机。 */
export interface DesktopRuntimeInstance {
  id: string;
  source_type: 'EXTERNAL' | 'MANAGED';
  managed: boolean;
  domain_name: string | null;
  bound_device_id: string | null;
  model_id: string | null;
  display_name: string | null;
  compatible_device_types: string[];
  profile_release_id: string;
  image_release: string;
  resource_config: Partial<DesktopRuntimeSpec> & { ipv4_address?: string };
  available_nic_aliases?: string[];
  port_bindings?: Array<{
    frontend_port_key: string;
    runtime_alias: string;
    mac_address: string;
    tap: string;
    network_status?: string;
    network_bridge?: string;
  }>;
  provision_state: 'READY' | 'PROVISIONING' | 'ERROR';
  power_state: string;
  vnc: { listen?: string; port?: number };
  novnc_url: string;
  source: string;
  quality: string;
  error?: { code?: string; message?: string; retryable?: boolean } | null;
}

/** 资源池快照。 */
export interface DesktopRuntimeInventory {
  success: boolean;
  available: boolean;
  instances: DesktopRuntimeInstance[];
  profiles: DesktopRuntimeProfile[];
  vendor_image_candidates?: VendorImageCandidate[];
  vendor_image_scan_error?: { code: string; message: string } | null;
  quality: string;
  message?: string;
  error_code?: string;
}

/** 绑定所需的前端设备身份。 */
export interface DesktopBindingTarget {
  experiment_id: string;
  device_id: string;
  model_id: string;
  display_name: string;
  device_type: string;
  nic_aliases: string[];
  port_keys: string[];
}

/** 构造不可用状态。 */
function unavailable(message: string, error_code = 'RUNTIME_BRIDGE_UNAVAILABLE'):
  DesktopRuntimeInventory {
  return {
    success: false,
    available: false,
    instances: [],
    profiles: [],
    quality: 'real_runtime',
    message: message,
    error_code: error_code
  };
}

/** 读取已有与平台创建的虚拟机。 */
export async function fetch_desktop_runtimes(): Promise<DesktopRuntimeInventory> {
  try {
    return (await server_request_json('/api/v1/runtime/desktops/')) as unknown as
      DesktopRuntimeInventory;
  } catch (error) {
    return unavailable(
      error instanceof Error ? error.message : '虚拟机控制接口不可用',
      error instanceof ServerApiError && error.code !== 'INVALID_API_RESPONSE'
        ? error.code
        : undefined
    );
  }
}

/** 将已有虚拟机绑定到前端设备。 */
export async function bind_desktop_runtime(
  runtime_id: string,
  target: DesktopBindingTarget
): Promise<DesktopRuntimeInstance> {
  const payload = await server_request_json<Record<string, unknown>>(`/api/v1/runtime/desktops/${runtime_id}/binding/`, {
    method: 'PUT',
    body: JSON.stringify(target)
  });
  return payload.instance as DesktopRuntimeInstance;
}

/** 按规格创建并绑定新虚拟机。 */
export async function provision_desktop_runtime(
  target: DesktopBindingTarget,
  spec: DesktopRuntimeSpec
): Promise<DesktopRuntimeInstance> {
  const payload = await server_request_json<Record<string, unknown>>('/api/v1/runtime/desktops/', {
    method: 'POST',
    body: JSON.stringify({ ...target, spec: spec })
  });
  return payload.instance as DesktopRuntimeInstance;
}

/** 解除设备映射但保留后端虚拟机。 */
export async function unbind_desktop_runtime(
  runtime_id: string
): Promise<DesktopRuntimeInstance> {
  const payload = await server_request_json<Record<string, unknown>>(`/api/v1/runtime/desktops/${runtime_id}/binding/`, {
    method: 'DELETE'
  });
  return payload.instance as DesktopRuntimeInstance;
}

/** 控制已绑定虚拟机电源。 */
export async function power_desktop_runtime(
  runtime_id: string,
  device_id: string,
  is_on: boolean
): Promise<DesktopRuntimeInstance> {
  const payload = await server_request_json<Record<string, unknown>>(`/api/v1/runtime/desktops/${runtime_id}/power/`, {
    method: 'POST',
    body: JSON.stringify({ device_id: device_id, on: is_on })
  });
  return payload.instance as DesktopRuntimeInstance;
}

/** 删除平台创建的后端虚拟机。 */
export async function delete_desktop_runtime(runtime_id: string): Promise<void> {
  await server_request_json(`/api/v1/runtime/desktops/${runtime_id}/`, { method: 'DELETE' });
}

/** 删除前端设备时关闭、解绑并销毁其平台创建虚拟机。 */
export async function destroy_bound_desktop_runtime(
  runtime_id: string,
  device_id: string
): Promise<{
  backend_destroyed: boolean;
  external_runtime_preserved: boolean;
  unbound_device_id: string;
}> {
  return (await server_request_json(`/api/v1/runtime/desktops/${runtime_id}/lifecycle/`, {
    method: 'DELETE',
    body: JSON.stringify({ device_id: device_id })
  })) as unknown as {
    backend_destroyed: boolean;
    external_runtime_preserved: boolean;
    unbound_device_id: string;
  };
}

/** 实验关闭、新建或载入时批量关闭并解绑当前场景中的虚拟机。 */
export async function release_desktop_runtimes(
  experiment_id: string,
  device_ids: string[],
  keepalive = false
): Promise<void> {
  await server_request_json('/api/v1/runtime/desktops/release/', {
    method: 'POST',
    body: JSON.stringify({ experiment_id, device_ids: [...new Set(device_ids)] }),
    keepalive: keepalive
  });
}
