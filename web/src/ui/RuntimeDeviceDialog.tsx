/**
 * @File : web/src/ui/RuntimeDeviceDialog.tsx
 * @Description : 新增 PC/笔记本时选择已有虚拟机或指定参数创建后端虚拟机。
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import { get_registry } from '../data/assets';
import { use_store } from '../core/store';
import {
  desktop_port_aliases, desktop_port_keys, desktop_runtime_port_keys
} from '../core/desktop_ports';
import { register_vendor_image, upload_runtime_image } from '../core/desktop_runtime_bridge';
import { ServerApiError } from '../core/server_api';
import { plan_runtime_node_names } from '../core/runtime_node_names';

import type { JSX } from 'react';
import type { DesktopRuntimeSpec } from '../core/desktop_runtime_bridge';

type ResourcePreset = 'standard' | 'light' | 'dense' | 'custom';

const NETWORK_DEVICE_TYPES = new Set(['switch', 'l3switch', 'router', 'firewall']);

function image_label(release: string): string {
  return release === 'ubuntu-noble-20260725'
    ? 'Ubuntu 24.04 LTS · 2026-07-25 基础镜像'
    : release.startsWith('uploaded-') ? '已导入镜像' : release;
}

/** 规格预设只填入当前 Runtime 真正支持的资源字段。 */
function preset_resources(
  preset: Exclude<ResourcePreset, 'custom'>,
  defaults: { vcpu_count: number; memory_mib: number; disk_gib: number },
  limits: { vcpu_count: [number, number]; memory_mib: [number, number]; disk_gib: [number, number] }
): { vcpu_count: number; memory_mib: number; disk_gib: number } {
  if (preset === 'standard') return defaults;
  const requested = preset === 'light'
    ? { vcpu_count: 1, memory_mib: 1024, disk_gib: 8 }
    : { vcpu_count: 4, memory_mib: 4096, disk_gib: 32 };
  return {
    vcpu_count: Math.max(limits.vcpu_count[0], Math.min(requested.vcpu_count, limits.vcpu_count[1])),
    memory_mib: Math.max(limits.memory_mib[0], Math.min(requested.memory_mib, limits.memory_mib[1])),
    disk_gib: Math.max(limits.disk_gib[0], Math.min(requested.disk_gib, limits.disk_gib[1]))
  };
}

/** 计算设备 Runtime 创建对话框。 */
export function RuntimeDeviceDialog(props: { can_upload_images: boolean }): JSX.Element | null {
  const pending = use_store((state) => state.pending_runtime_device);
  const runtime = use_store((state) => state.runtime);
  const runtimes = use_store((state) => state.desktop_runtimes);
  const profiles = use_store((state) => state.desktop_profiles);
  const vendor_image_candidates = use_store((state) => state.vendor_image_candidates);
  const vendor_image_scan_error = use_store((state) => state.vendor_image_scan_error);
  const busy = use_store((state) => state.desktop_runtime_busy);
  const error = use_store((state) => state.desktop_runtime_error);
  const refresh = use_store((state) => state.refresh_desktop_runtimes);
  const cancel = use_store((state) => state.cancel_runtime_device_creation);
  const create_existing = use_store((state) => state.create_device_with_existing_runtime);
  const create_new = use_store((state) => state.create_device_with_new_runtime);
  const create_without = use_store((state) => state.create_device_without_runtime);
  const [mode, set_mode] = useState<'existing' | 'new' | 'none'>('existing');
  const mode_ref = useRef<'existing' | 'new' | 'none'>('existing');
  const user_selected_mode = useRef(false);
  const select_mode = (next: 'existing' | 'new' | 'none'): void => {
    user_selected_mode.current = true;
    mode_ref.current = next;
    set_mode(next);
  };
  const [runtime_id, set_runtime_id] = useState('');
  const [profile_id, set_profile_id] = useState('');
  const [memory_mib, set_memory_mib] = useState(2048);
  const [vcpu_count, set_vcpu_count] = useState(2);
  const [disk_gib, set_disk_gib] = useState(16);
  const [vm_name, set_vm_name] = useState('simlab-pc');
  const [quantity, set_quantity] = useState(1);
  const [nic_model, set_nic_model] = useState<'virtio' | 'e1000'>('virtio');
  const [gpu_model, set_gpu_model] = useState<'virtio'>('virtio');
  const [resource_preset, set_resource_preset] = useState<ResourcePreset>('standard');
  const [image_file, set_image_file] = useState<File | null>(null);
  const [image_name, set_image_name] = useState('');
  const [uploading, set_uploading] = useState(false);
  const [upload_error, set_upload_error] = useState('');
  const [imported_release, set_imported_release] = useState('');

  const manifest = pending ? get_registry().manifest(pending.model_id) : null;
  const is_network_device = !!manifest && NETWORK_DEVICE_TYPES.has(manifest.device_type);
  const image_role = manifest?.device_type === 'l3switch' ? 'switch' : manifest?.device_type;
  const compatible = useMemo(
    () =>
      runtimes.filter(
        (item) =>
          !item.bound_device_id &&
          manifest &&
          item.compatible_device_types.includes(manifest.device_type) &&
          item.provision_state === 'READY'
      ),
    [manifest, runtimes]
  );
  const compatible_profiles = profiles
    .filter((item) => manifest && item.device_types.includes(manifest.device_type) && (
      !is_network_device || (
        item.image_release !== 'ubuntu-noble-20260725' &&
        item.vendor_id === manifest.vendor_id &&
        item.appliance_role === image_role &&
        (!item.model_id || item.model_id === manifest.model_id)
      )
    ));
  const matching_candidates = vendor_image_candidates.filter(
    (item) => item.vendor_id === manifest?.vendor_id && item.appliance_role === image_role
  );
  const has_vendor_image = compatible_profiles.length > 0;
  const profile = compatible_profiles.find(
    (item) => `${item.profile_release_id}:${item.image_release}` === profile_id
  ) ||
    compatible_profiles[0];
  const nic_aliases = pending ? desktop_port_aliases(pending.model_id) : ['eth0'];
  const physical_port_keys = pending ? desktop_port_keys(pending.model_id) : ['eth0'];
  const port_keys = pending ? desktop_runtime_port_keys(pending.model_id) : ['eth0'];

  const select_preset = (value: ResourcePreset): void => {
    set_resource_preset(value);
    if (!profile || value === 'custom') return;
    const resources = preset_resources(value, profile.defaults, profile.limits);
    set_vcpu_count(resources.vcpu_count);
    set_memory_mib(resources.memory_mib);
    set_disk_gib(resources.disk_gib);
  };

  useEffect(() => {
    if (!pending) {
      return;
    }
    const device_type = get_registry().manifest(pending.model_id)?.device_type || 'node';
    const prefix = device_type === 'l3switch' ? 'switch' : device_type;
    try {
      set_vm_name(plan_runtime_node_names(
        pending.hostname || `${prefix}1`, 1,
        runtime?.list_devices().map((device) => device.hostname) || []
      )[0]);
    } catch {
      set_vm_name(`${prefix}1`);
    }
    set_quantity(1);
    /* 每次打开都重新观测 virsh 资源池，已关机的空闲域也会立即出现。 */
    void refresh();
  }, [pending, refresh]);

  useEffect(() => {
    if (!pending) {
      return;
    }
    const first_runtime = compatible[0]?.id || '';
    user_selected_mode.current = false;
    set_runtime_id(first_runtime);
    const next = first_runtime ? 'existing' : 'new';
    mode_ref.current = next;
    set_mode(next);
  }, [pending?.model_id]);

  useEffect(() => {
    if (pending && !runtime_id && compatible[0]) {
      set_runtime_id(compatible[0].id);
      if (!user_selected_mode.current) {
        mode_ref.current = 'existing';
        set_mode('existing');
      }
    }
  }, [pending, compatible, runtime_id]);

  useEffect(() => {
    if (!profile) {
      set_profile_id('');
      return;
    }
    set_profile_id(`${profile.profile_release_id}:${profile.image_release}`);
    set_memory_mib(profile.defaults.memory_mib);
    set_vcpu_count(profile.defaults.vcpu_count);
    set_disk_gib(profile.defaults.disk_gib);
    set_resource_preset('standard');
  }, [profile?.profile_release_id, profile?.image_release]);

  useEffect(() => {
    if (!imported_release) return;
    const imported_profile = compatible_profiles.find(
      (item) => item.image_release === imported_release
    );
    if (imported_profile) {
      set_profile_id(`${imported_profile.profile_release_id}:${imported_release}`);
      set_imported_release('');
    }
  }, [imported_release, profiles, manifest?.device_type]);

  const import_image = async (): Promise<void> => {
    if (!image_file || !image_role || !['switch', 'router', 'firewall'].includes(image_role)) return;
    set_uploading(true);
    set_upload_error('');
    try {
      const imported = await upload_runtime_image(
        image_file, image_name.trim(), image_role as 'switch' | 'router' | 'firewall', manifest!.vendor_id
      );
      set_imported_release(imported.image_release);
      await refresh();
      set_image_file(null);
    } catch (cause) {
      set_upload_error(cause instanceof ServerApiError
        ? `${cause.code}：${cause.message}`
        : cause instanceof Error ? `IMAGE_IMPORT_FAILED：${cause.message}`
          : 'IMAGE_IMPORT_FAILED：镜像导入失败，请重试。');
    } finally {
      set_uploading(false);
    }
  };

  const register_candidate = async (folder: string): Promise<void> => {
    set_uploading(true);
    set_upload_error('');
    try {
      const registered = await register_vendor_image(folder);
      set_imported_release(registered.image_release);
      await refresh();
    } catch (cause) {
      set_upload_error(cause instanceof ServerApiError
        ? `${cause.code}：${cause.message}`
        : 'IMAGE_REGISTER_FAILED：目录镜像登记失败；请检查目录权限和镜像格式。');
    } finally {
      set_uploading(false);
    }
  };

  if (!pending || !manifest) {
    return null;
  }

  const spec: DesktopRuntimeSpec | null = profile
    ? {
        profile_release_id: profile.profile_release_id,
        image_release: profile.image_release,
        vm_name: vm_name.trim().toLowerCase(),
        memory_mib: memory_mib,
        vcpu_count: vcpu_count,
        disk_gib: disk_gib,
        nic_model: nic_model,
        nic_aliases: nic_aliases,
        gpu_model: gpu_model
      }
    : null;
  let planned_names: string[] = [];
  try {
    planned_names = plan_runtime_node_names(
      vm_name, quantity, runtime?.list_devices().map((device) => device.hostname) || []
    );
  } catch { /* 输入过程中通过 aria-invalid 和按钮状态提示。 */ }
  const valid_vm_name = planned_names.length === quantity;
  const valid_resources = !!profile &&
    Number.isInteger(vcpu_count) && vcpu_count >= profile.limits.vcpu_count[0] &&
    vcpu_count <= profile.limits.vcpu_count[1] &&
    Number.isInteger(memory_mib) && memory_mib >= profile.limits.memory_mib[0] &&
    memory_mib <= profile.limits.memory_mib[1] &&
    Number.isInteger(disk_gib) && disk_gib >= profile.limits.disk_gib[0] &&
    disk_gib <= profile.limits.disk_gib[1] &&
    nic_aliases.length >= profile.capabilities.nic_count[0] &&
    nic_aliases.length <= profile.capabilities.nic_count[1];

  return (
    <div className="runtime-dialog" role="dialog" aria-modal="true" aria-label="配置后端虚拟机">
      <div className="runtime-dialog-window">
        <div className="runtime-dialog-head">
          <div>
            <h2>{is_network_device ? '配置网络节点' : '配置后端虚拟机'}</h2>
            <span>{manifest.display_name} · {manifest.device_type}</span>
          </div>
          <button type="button" disabled={busy} onClick={cancel}>取消 ×</button>
        </div>

        <div className="runtime-mode-tabs">
          <button
            type="button"
            className={mode === 'existing' ? 'on' : ''}
            disabled={compatible.length === 0}
            onClick={() => select_mode('existing')}
          >
            绑定已有虚拟机 ({compatible.length})
          </button>
          <button
            type="button"
            className={mode === 'new' ? 'on' : ''}
            onClick={() => select_mode('new')}
          >
            创建新虚拟机
          </button>
          <button
            type="button"
            className={mode === 'none' ? 'on' : ''}
            onClick={() => select_mode('none')}
          >
            暂不绑定
          </button>
        </div>

        {mode === 'existing' ? (
          <div className="runtime-dialog-body">
            <label className="field">
              <span>已有虚拟机</span>
              <select value={runtime_id} onChange={(event) => set_runtime_id(event.target.value)}>
                {compatible.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.domain_name || item.id} · {item.power_state} ·
                    {item.source_type === 'EXTERNAL' ? '宿主已有' : '平台创建'} ·
                    {item.available_nic_aliases?.length || '未知'} 张网卡
                    {manifest.device_type === 'laptop' &&
                      item.available_nic_aliases?.length === physical_port_keys.length
                      ? '（仅有线）' : ''}
                  </option>
                ))}
              </select>
            </label>
            {compatible.find((item) => item.id === runtime_id) && (
              <RuntimeSummary runtime={compatible.find((item) => item.id === runtime_id)!} />
            )}
          </div>
        ) : mode === 'new' ? (
          <div className="runtime-dialog-body runtime-spec-grid">
            {is_network_device && (
              <div className="runtime-spec-section wide">
                <strong>节点模板</strong>
                <span>{manifest.display_name} · {manifest.device_type} ·
                  实体接口 {physical_port_keys.length} 个</span>
              </div>
            )}
            <label className="field wide">
              <span>{is_network_device ? '起始节点名（如 router1 或 R1）' : '虚拟机名称'}</span>
              <input
                type="text"
                value={vm_name}
                maxLength={63}
                onChange={(event) => set_vm_name(event.target.value)}
                aria-invalid={!valid_vm_name}
              />
            </label>
            {is_network_device && (
              <label className="field wide">
                <span>创建数量（1–20 台）</span>
                <input type="number" min={1} max={20} step={1} value={quantity}
                  onChange={(event) => set_quantity(Number(event.target.value))} />
                {valid_vm_name && <em>将创建：{planned_names.join('、')}</em>}
              </label>
            )}
            <label className="field wide">
              <span>系统镜像 / Runtime Profile</span>
              <select value={profile ? `${profile.profile_release_id}:${profile.image_release}` : ''}
                onChange={(event) => set_profile_id(event.target.value)}>
                {!profile && <option value="">暂无该厂商类型的已登记镜像</option>}
                {compatible_profiles.map((item) => (
                  <option key={`${item.profile_release_id}:${item.image_release}`} value={`${item.profile_release_id}:${item.image_release}`}>
                    {item.display_name} · {image_label(item.image_release)}
                  </option>
                ))}
              </select>
            </label>
            {is_network_device && (
              <div className="runtime-spec-note wide">
                {has_vendor_image
                  ? `IMAGE_VENDOR_MATCH：已找到 ${manifest.vendor_id}-${image_role} 的已登记镜像；请按详细型号手动选择。`
                  : `IMAGE_NOT_FOUND：没有 ${manifest.vendor_id}-${image_role} 的已登记镜像。将镜像放入服务器 vendor/${manifest.vendor_id}/${manifest.vendor_id}-${image_role}-型号版本/ 下，刷新资源池后由管理员登记；目录内须有一个 .qcow2 文件。`}
              </div>
            )}
            {is_network_device && (
              <div className="runtime-interface-section wide">
                <strong>厂商目录镜像 · {manifest.vendor_id}-{image_role}</strong>
                {vendor_image_scan_error && <span className="g0-binding-error">
                  {vendor_image_scan_error.code}：{vendor_image_scan_error.message}
                </span>}
                {matching_candidates.length ? matching_candidates.map((candidate) => (
                  <div key={candidate.folder} className="runtime-image-upload-row">
                    <span>{candidate.folder}/{candidate.file_name || '缺少镜像文件'} · {
                      candidate.registered ? '已登记' : candidate.status === 'READY_TO_REGISTER'
                        ? '待校验登记' : candidate.status === 'MULTIPLE_DISKS'
                          ? '目录有多个 qcow2，请只保留一个' : '未发现 .qcow2 磁盘'
                    }</span>
                    {props.can_upload_images && !candidate.registered && candidate.status === 'READY_TO_REGISTER' && (
                      <button type="button" disabled={uploading || busy}
                        onClick={() => void register_candidate(candidate.folder)}>
                        {uploading ? '校验中…' : '登记此镜像'}
                      </button>
                    )}
                  </div>
                )) : <span>服务器对应厂商类型目录中尚未发现镜像；放入后点击“刷新资源池”。</span>}
                <button type="button" disabled={uploading || busy} onClick={() => void refresh()}>
                  刷新资源池
                </button>
                <strong>或直接上传镜像</strong>
                {props.can_upload_images ? (
                  <>
                    <span>管理员可直接上传独立 qcow2（最大 8 GiB）；导入后自动选中。镜像须支持 x86_64、UEFI 与 virtio 磁盘。</span>
                    <input type="file" accept=".qcow2" disabled={uploading || busy}
                      onChange={(event) => {
                        const next = event.target.files?.[0] || null;
                        set_image_file(next);
                        set_image_name(next?.name.replace(/\.qcow2$/i, '') || '');
                        set_upload_error('');
                      }} />
                    <div className="runtime-image-upload-row">
                      <input type="text" value={image_name} maxLength={120} aria-label="导入镜像名称"
                        placeholder="镜像显示名称" disabled={uploading || busy}
                        onChange={(event) => set_image_name(event.target.value)} />
                      <button type="button" disabled={!image_file || !image_name.trim() || uploading || busy}
                        onClick={() => void import_image()}>
                        {uploading ? '上传并校验中…' : '导入镜像'}
                      </button>
                    </div>
                    {upload_error && <span className="g0-binding-error">{upload_error}</span>}
                  </>
                ) : <span>镜像导入需要管理员账户；已登记的镜像可直接从上方清单选择。</span>}
              </div>
            )}
            {is_network_device && (
              <label className="field wide">
                <span>资源规格预设</span>
                <select value={resource_preset} onChange={(event) => select_preset(event.target.value as ResourcePreset)}>
                  <option value="standard">模板默认</option>
                  <option value="light">轻量：1 vCPU / 1 GiB / 8 GiB</option>
                  <option value="dense">高性能：4 vCPU / 4 GiB / 32 GiB</option>
                  <option value="custom">自定义</option>
                </select>
              </label>
            )}
            <NumberField
              label="vCPU"
              value={vcpu_count}
              limits={profile?.limits.vcpu_count || [1, 4]}
              onChange={(value) => { set_vcpu_count(value); set_resource_preset('custom'); }}
            />
            <NumberField
              label="内存 MiB"
              value={memory_mib}
              limits={profile?.limits.memory_mib || [512, 4096]}
              step={256}
              onChange={(value) => { set_memory_mib(value); set_resource_preset('custom'); }}
            />
            <NumberField
              label="磁盘 GiB"
              value={disk_gib}
              limits={profile?.limits.disk_gib || [4, 32]}
              onChange={(value) => { set_disk_gib(value); set_resource_preset('custom'); }}
            />
            <label className="field runtime-resource-field">
              <span>虚拟网卡型号</span>
              <select
                value={nic_model}
                onChange={(event) => set_nic_model(event.target.value as 'virtio' | 'e1000')}
              >
                {(profile?.capabilities.nic_models || ['virtio']).map((model) => (
                  <option key={model} value={model}>{model}</option>
                ))}
              </select>
            </label>
            <div className="field runtime-resource-field">
              <span>以太网接口数量</span>
              <output className="runtime-resource-value" aria-label="虚拟网卡映射">
                {physical_port_keys.length} 个实体接口 +
                {manifest.device_type === 'laptop' ? ' 1 个射频虚拟接口' : ' 0 个射频接口'}
                = {nic_aliases.length} 张虚拟网卡
              </output>
            </div>
            <label className="field runtime-resource-field">
              <span>虚拟显示适配器</span>
              <select
                value={gpu_model}
                disabled={(profile?.capabilities.gpu_models.length || 1) === 1}
                onChange={(event) => set_gpu_model(event.target.value as 'virtio')}
              >
                {(profile?.capabilities.gpu_models || ['virtio']).map((model) => (
                  <option key={model} value={model}>{model.toUpperCase()}</option>
                ))}
              </select>
            </label>
            {is_network_device && (
              <div className="runtime-interface-section wide">
                <strong>实体接口与虚拟网卡映射</strong>
                <span>接口数量由 3D 设备模块决定；需要增减接口时，先在设备工坊修改模块。</span>
                <div className="runtime-interface-list">
                  {port_keys.map((key, index) => (
                    <div key={`${key}-${index}`}>
                      <span>{key}</span><span>→</span><code>{nic_aliases[index]}</code>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {is_network_device && (
              <div className="runtime-fixed-capabilities wide">
                <span>架构：x86_64 / Q35</span>
                <span>启动：UEFI</span>
                <span>控制台：鉴权 VNC</span>
                <span>启动配置：客体系统内配置</span>
              </div>
            )}
            <div className="runtime-spec-note wide">
              名称、CPU、内存、磁盘、网卡型号和实体接口映射会提交后端校验。每个前端网络接口对应独立虚拟网卡；镜像名称与目录匹配不代表厂商功能已验收，实际 CLI 取决于客体镜像。虚拟机域名、磁盘、MAC 和 VNC 端口由 Host Agent 生成。
            </div>
          </div>
        ) : (
          <div className="runtime-dialog-body">
            {is_network_device && (
              <>
                <label className="field"><span>起始节点名（如 router1 或 R1）</span>
                  <input type="text" value={vm_name} maxLength={63}
                    onChange={(event) => set_vm_name(event.target.value)} aria-invalid={!valid_vm_name} />
                </label>
                <label className="field"><span>创建数量（1–20 台）</span>
                  <input type="number" min={1} max={20} step={1} value={quantity}
                    onChange={(event) => set_quantity(Number(event.target.value))} />
                </label>
                {valid_vm_name && <span>将创建：{planned_names.join('、')}</span>}
              </>
            )}
            <div className="runtime-spec-note wide">
              只把设备放入当前实验，不占用后端虚拟机。之后可在“设备检视”中绑定空闲虚拟机，或按参数创建新实例。
            </div>
          </div>
        )}

        {error && <div className="g0-binding-error">{error}</div>}
        <div className="runtime-dialog-actions">
          <button type="button" disabled={busy} onClick={cancel}>取消</button>
          <button
            type="button"
            className="on"
            disabled={busy || uploading || (mode === 'existing' ? !runtime_id : mode === 'new' ? !spec || !valid_vm_name || !valid_resources : is_network_device && !valid_vm_name)}
            onClick={() => {
              if (mode_ref.current === 'existing') {
                void create_existing(runtime_id);
              } else if (mode_ref.current === 'new' && spec) {
                void create_new(spec, is_network_device ? quantity : 1, vm_name);
              } else if (mode_ref.current === 'none') {
                void create_without(is_network_device ? quantity : 1, vm_name);
              }
            }}
          >
            {busy ? '正在配置后端虚拟机…' : is_network_device && mode !== 'existing'
              ? `创建 ${quantity} 台并放入实验台` : '创建并放入实验台'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 数字规格输入。 */
function NumberField(props: {
  label: string;
  value: number;
  limits: [number, number];
  step?: number;
  onChange: (value: number) => void;
}): JSX.Element {
  return (
    <label className="field runtime-resource-field">
      <span>{props.label}</span>
      <input
        type="number"
        min={props.limits[0]}
        max={props.limits[1]}
        step={props.step || 1}
        value={props.value}
        onChange={(event) => props.onChange(Number(event.target.value))}
      />
      <em>可选范围：{props.limits[0]}–{props.limits[1]}</em>
    </label>
  );
}

/** 已有虚拟机摘要。 */
function RuntimeSummary(props: {
  runtime: {
    domain_name: string | null;
    source_type: string;
    power_state: string;
    resource_config: Record<string, unknown>;
    image_release: string;
  };
}): JSX.Element {
  const runtime = props.runtime;
  return (
    <div className="runtime-summary">
      <div><span>Domain</span><b>{runtime.domain_name}</b></div>
      <div><span>来源</span><b>{runtime.source_type === 'EXTERNAL' ? '宿主已有' : '平台创建'}</b></div>
      <div><span>状态</span><b>{runtime.power_state}</b></div>
      <div><span>镜像</span><b>{image_label(runtime.image_release)}</b></div>
      {runtime.resource_config.vcpu_count && (
        <div><span>配置</span><b>{String(runtime.resource_config.vcpu_count)} vCPU · {String(runtime.resource_config.memory_mib)} MiB · {String(runtime.resource_config.disk_gib)} GiB</b></div>
      )}
    </div>
  );
}
