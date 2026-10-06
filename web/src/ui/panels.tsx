/**
 * @File : web/src/ui/panels.tsx
 * @Time : 2026-10-05 10:10
 * @Author : Cetrp
 * @Description : 侧边与顶部面板：设备目录、实验内设备与拓扑速览、检视面板（含连通性测试）、
 *               无线仿真面板、事件流与顶部状态条。
 */

import { useEffect, useMemo, useState } from 'react';

import type { JSX } from 'react';

import { get_registry } from '../data/assets';
import { ensure_templates_loaded, get_template, list_user_templates } from '../devices/registry';
import { device_thumbnail } from '../devices/thumbnailer';
import { DeviceRuntime } from '../core/device_runtime';
import type { PortState } from '../data/types';
import { describe_event, event_time, is_runtime_model, use_store } from '../core/store';
import { DEVICE_STATE, DEVICE_TYPE_TEXT } from '../core/constants';
import { is_olt, is_onu, is_wireless_ap, is_wireless_client } from '../core/local_runtime';
import { rssi_text } from '../scene/wireless_layer';
import { server_request_json } from '../core/server_api';

/** 设备状态中文。 */
const STATE_TEXT: Record<string, string> = {
  CREATED: '已创建',
  READY_FOR_POWER: '待上电',
  POWERING_ON: '上电中',
  BOOTING: '启动中',
  RUNNING: '运行中',
  OFF: '已关机',
  FAULT: '故障'
};

/**
 * 设备目录面板。
 *
 * @returns {JSX.Element} 组件。
 */
export function CatalogPanel(): JSX.Element {
  const create_device = use_store((state) => state.create_device);
  const open_workshop = use_store((state) => state.open_workshop);
  const delete_template = use_store((state) => state.delete_template);
  const [keyword, set_keyword] = useState('');
  const [vendor_filter, set_vendor_filter] = useState<string | null>(null);
  const [workshop_templates, set_workshop_templates] = useState<
    { model_id: string; display_name: string; parts: number }[]
  >([]);
  /* 工坊保存后版本号自增：用户设备列表与缩略图随之刷新。 */
  const template_revision = use_store((state) => state.template_revision);

  /* 载入设备工坊产出的用户模板（设备栏展示与编辑入口）。 */
  useEffect(() => {
    let cancelled = false;
    void ensure_templates_loaded().then(() => {
      if (cancelled) {
        return;
      }
      set_workshop_templates(
        list_user_templates().map((template) => ({
          model_id: template.model_id,
          display_name: template.display_name,
          parts: template.parts.length
        }))
      );
    });
    return () => {
      cancelled = true;
    };
  }, [template_revision]);

  const catalog = useMemo(() => get_registry().catalog_groups(), []);
  const filtered = catalog
    .filter((group) => !vendor_filter || group.vendor_id === vendor_filter)
    .map((group) => ({
      ...group,
      models: group.models.filter(
        (model) =>
          keyword.length === 0 ||
          (model.display_name + model.model_id + (model.device_class || ''))
            .toLowerCase()
            .includes(keyword.toLowerCase())
      )
    }))
    .filter((group) => group.models.length > 0);

  return (
    <div className="panel catalog-panel">
      <div className="panel-head">
        <h2>设备目录</h2>
        <span>
          {catalog.length} 厂商 · {get_registry().model_count()} 型号
        </span>
      </div>
      <div className="vendor-row">
        <button
          type="button"
          className={vendor_filter === null ? 'chip on' : 'chip'}
          onClick={() => set_vendor_filter(null)}
        >
          全部
        </button>
        {catalog.map((group) => (
          <button
            key={group.vendor_id}
            type="button"
            className={vendor_filter === group.vendor_id ? 'chip on' : 'chip'}
            style={{ borderColor: group.brand?.logo_color || undefined }}
            onClick={() => set_vendor_filter(group.vendor_id)}
          >
            {group.vendor_name.split(' ')[0]}
          </button>
        ))}
      </div>
      <input
        className="search"
        placeholder="搜索厂商 / 型号 / 类型…"
        value={keyword}
        onChange={(event) => set_keyword(event.target.value)}
      />
      <div className="workshop-entry">
        <button type="button" className="on" onClick={() => void open_workshop(null)}>
          + 新建设备（进入设备工坊）
        </button>
        {workshop_templates.map((template) => (
          <div
            key={template.model_id}
            className="workshop-item"
            draggable
            onDragStart={(event) => {
              event.dataTransfer.setData('application/x-simlab-kind', 'device_template');
              event.dataTransfer.setData('application/x-simlab-value', template.model_id);
              event.dataTransfer.effectAllowed = 'copy';
            }}
          >
            <b>{template.display_name}</b>
            <em>
              {template.model_id} · {template.parts} 部件
            </em>
            <div className="workshop-item-actions">
              <button
                type="button"
                className="mini"
                onClick={() => void open_workshop(template.model_id)}
              >
                编辑
              </button>
              <button
                type="button"
                className="mini warn"
                onClick={() => {
                  delete_template(template.model_id);
                  set_workshop_templates(
                    list_user_templates().map((item) => ({
                      model_id: item.model_id,
                      display_name: item.display_name,
                      parts: item.parts.length
                    }))
                  );
                }}
              >
                删除
              </button>
            </div>
          </div>
        ))}
        {workshop_templates.length === 0 && (
          <div className="empty">工坊中组装的设备会显示在这里，可直接创建到实验台。</div>
        )}
      </div>
      <div className="scroll">
        {filtered.map((group) => (
          <div key={group.vendor_id} className="catalog-group">
            <div className="group-title">
              <span className="dot" style={{ background: group.brand?.logo_color || '#37e0c9' }} />
              {group.vendor_name}
            </div>
            {group.models.map((model) => {
              const role = model.wireless?.role;
              const port_count = (model.visual?.port_layout || []).reduce(
                (sum, row) =>
                  sum + (row.rows || []).reduce((inner, item) => inner + (item.count || 0), 0),
                0
              );
              return (
                <button
                  key={model.model_id}
                  type="button"
                  className="catalog-card with-thumb"
                  style={{ borderLeftColor: group.brand?.logo_color || '#37e0c9' }}
                  draggable
                  onDragStart={(event) => {
                    event.dataTransfer.setData('application/x-simlab-kind', 'device_template');
                    event.dataTransfer.setData('application/x-simlab-value', model.model_id);
                    event.dataTransfer.effectAllowed = 'copy';
                  }}
                  onClick={() => void create_device(model.model_id)}
                >
                  <DeviceThumb model_id={model.model_id} />
                  <div className="card-text">
                    <b>{model.display_name}</b>
                    <span>{model.device_class}</span>
                  </div>
                  <div className="tip">
                    <b>{model.display_name}</b>
                    <em>型号：{model.model_id}</em>
                    <em>类型：{model.device_class}</em>
                    <em>系统：{model.os_version}</em>
                    <em>接口：{port_count} 个</em>
                    {role === 'ap' && <em>无线 AP（射频呈现）</em>}
                    {role === 'sta' && <em>无线客户端</em>}
                    <em>拖到场景可直接创建</em>
                  </div>
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * 设备 3D 缩略图（模板渲染为图片，失败时回落到占位块）。
 *
 * @param {object} props 属性。
 * @param {string} props.model_id 型号 ID。
 * @returns {JSX.Element} 组件。
 */
export function DeviceThumb({ model_id }: { model_id: string }): JSX.Element {
  const [src, set_src] = useState('');
  const template_revision = use_store((state) => state.template_revision);
  useEffect(() => {
    let cancelled = false;
    let handle = 0;
    /* 模板是懒加载的：先等注册表就绪，再渲染缩略图（避免拿到 null 模板）。 */
    void ensure_templates_loaded().then(() => {
      if (cancelled) {
        return;
      }
      handle = window.setTimeout(() => {
        const template = get_template(model_id);
        if (!cancelled && template) {
          set_src(device_thumbnail(template));
        }
      }, 0);
    });

    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [model_id, template_revision]);

  return src ? (
    <img className="thumb" src={src} alt={model_id} draggable={false} />
  ) : (
    <span className="thumb placeholder" />
  );
}

/**
 * 实验内设备列表 + 拓扑速览。
 *
 * @returns {JSX.Element} 组件。
 */
export function DeviceListPanel(): JSX.Element {
  const runtime = use_store((state) => state.runtime);
  const device_ids = use_store((state) => state.device_ids);
  const cables = use_store((state) => state.cables);
  const selected = use_store((state) => state.selected_device_id);
  const select_device = use_store((state) => state.select_device);
  const revision = use_store((state) => state.revision);
  void revision;

  const device_list = device_ids
    .map((device_id) => (runtime ? runtime.get_device(device_id) : null))
    .filter((device): device is DeviceRuntime => Boolean(device));

  return (
    <div className="panel device-panel">
      <div className="panel-head">
        <h2>实验内设备</h2>
        <span>
          {device_list.length} 台 · {cables.length} 条链路
        </span>
      </div>
      <div className="device-chips">
        {device_list.map((device) => {
          const is_running = device.power_state === DEVICE_STATE.RUNNING;
          const up = device.ports.filter((port) => port.link_up).length;
          return (
            <button
              key={device.device_id}
              type="button"
              className={selected === device.device_id ? 'device-chip on' : 'device-chip'}
              onClick={() => select_device(device.device_id)}
            >
              <span className={is_running ? 'dot up' : 'dot'} />
              <b>{device.hostname}</b>
              <em>{DEVICE_TYPE_TEXT[device.device_type] || device.device_type}</em>
              <i>
                {up}/{device.ports.length}
              </i>
            </button>
          );
        })}
        {device_list.length === 0 && <div className="empty">左侧目录点击型号即可创建实验设备</div>}
      </div>
      <TopologyMiniMap />
    </div>
  );
}

/**
 * 拓扑速览（SVG 小地图）。
 *
 * @returns {JSX.Element} 组件。
 */
export function TopologyMiniMap(): JSX.Element {
  const runtime = use_store((state) => state.runtime);
  const revision = use_store((state) => state.revision);
  const cables = use_store((state) => state.cables);
  const selected = use_store((state) => state.selected_device_id);
  const select_device = use_store((state) => state.select_device);
  void revision;

  const devices = runtime ? runtime.list_devices() : [];
  const width = 280;
  const height = 132;
  const xs = devices.map((device) => device.position.x);
  const zs = devices.map((device) => device.position.z);
  const min_x = Math.min(-6, ...xs);
  const max_x = Math.max(6, ...xs);
  const min_z = Math.min(-6, ...zs);
  const max_z = Math.max(6, ...zs);
  const project = (x: number, z: number): { x: number; y: number } => ({
    x: ((x - min_x) / Math.max(1, max_x - min_x)) * (width - 40) + 20,
    y: ((z - min_z) / Math.max(1, max_z - min_z)) * (height - 34) + 17
  });

  return (
    <div className="mini-map">
      <svg viewBox={'0 0 ' + width + ' ' + height} width="100%" height={height}>
        {cables.map((cable) => {
          const from = devices.find((device) => device.device_id === cable.source.device_id);
          const to = cable.target
            ? devices.find((device) => device.device_id === cable.target?.device_id)
            : null;
          if (!from || !to) {
            return null;
          }
          const a = project(from.position.x, from.position.z);
          const b = project(to.position.x, to.position.z);
          return (
            <line
              key={cable.cable_id}
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              stroke={cable.state === 'UP' ? '#2bff9a' : '#5a6472'}
              strokeWidth={2}
            />
          );
        })}
        {devices.map((device) => {
          const point = project(device.position.x, device.position.z);
          const fill = is_wireless_ap(device.manifest)
            ? '#8ab6ff'
            : is_wireless_client(device.manifest)
              ? '#ffb648'
              : '#37e0c9';
          return (
            <g
              key={device.device_id}
              onClick={() => select_device(device.device_id)}
              style={{ cursor: 'pointer' }}
            >
              <circle
                cx={point.x}
                cy={point.y}
                r={device.device_id === selected ? 7 : 5}
                fill={fill}
                stroke="#0b1117"
                strokeWidth={1}
              />
              <text x={point.x + 8} y={point.y + 4} fill="#9fb3c8" fontSize={9}>
                {device.hostname}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="hint">
        <i style={{ background: '#37e0c9' }} />
        有线设备
        <i style={{ background: '#8ab6ff' }} />
        AP
        <i style={{ background: '#ffb648' }} />
        无线客户端
      </div>
    </div>
  );
}

/**
 * 检视面板。
 *
 * @returns {JSX.Element} 组件。
 */
export function InspectorPanel(): JSX.Element {
  const runtime = use_store((state) => state.runtime);
  const selected_device = use_store((state) => state.selected_device_id);
  const selected_port = use_store((state) => state.selected_port);
  const revision = use_store((state) => state.revision);
  const link_source = use_store((state) => state.link_source);
  const start_link = use_store((state) => state.start_link);
  const cancel_link = use_store((state) => state.cancel_link);
  const complete_link = use_store((state) => state.complete_link);
  const connect_peer = use_store((state) => state.connect_peer);
  const disconnect_port = use_store((state) => state.disconnect_port);
  const toggle_power = use_store((state) => state.toggle_power);
  const configure_port = use_store((state) => state.configure_port);
  const inject_fault = use_store((state) => state.inject_fault);
  const save_config = use_store((state) => state.save_config);
  const ping = use_store((state) => state.ping);
  const ping_result = use_store((state) => state.ping_result);
  const select_port = use_store((state) => state.select_port);
  const desktop_runtimes = use_store((state) => state.desktop_runtimes);
  const desktop_profiles = use_store((state) => state.desktop_profiles);
  const runtime_busy = use_store((state) => state.desktop_runtime_busy);
  const runtime_error = use_store((state) => state.desktop_runtime_error);
  const cloud_uplinks = use_store((state) => state.cloud_uplinks);
  const set_cloud_uplink = use_store((state) => state.set_cloud_uplink);
  const experiment_error = use_store((state) => state.experiment_error);
  const experiment_busy = use_store((state) => state.experiment_busy);
  const [available_cloud_uplinks, set_available_cloud_uplinks] = useState<string[]>([]);
  const [cloud_quality, set_cloud_quality] = useState('development_mock');
  const [cloud_list_error, set_cloud_list_error] = useState('');
  const bind_runtime = use_store((state) => state.bind_desktop_to_device);
  const unbind_runtime = use_store((state) => state.unbind_desktop_from_device);
  const provision_runtime = use_store((state) => state.provision_desktop_for_device);
  const refresh_runtimes = use_store((state) => state.refresh_desktop_runtimes);
  const [ping_target, set_ping_target] = useState('');
  const [binding_target, set_binding_target] = useState('');
  const [memory_mib, set_memory_mib] = useState(2048);
  const [vcpu_count, set_vcpu_count] = useState(2);
  const [disk_gib, set_disk_gib] = useState(16);
  const [vm_name, set_vm_name] = useState('');
  const [nic_model, set_nic_model] = useState<'virtio' | 'e1000'>('virtio');
  void revision;

  const device = runtime && selected_device ? runtime.get_device(selected_device) : null;
  const bound_runtime = device
    ? desktop_runtimes.find((item) => item.bound_device_id === device.device_id)
    : undefined;
  const available_runtimes = device
    ? desktop_runtimes.filter(
        (item) =>
          (!item.bound_device_id || item.bound_device_id === device.device_id) &&
          item.compatible_device_types.includes(device.device_type) &&
          item.provision_state === 'READY'
      )
    : [];
  const desktop_profile = desktop_profiles.find(
    (profile) => device && profile.device_types.includes(device.device_type)
  );
  useEffect(() => {
    set_binding_target(bound_runtime?.id || available_runtimes[0]?.id || '');
  }, [device?.device_id, bound_runtime?.id, available_runtimes[0]?.id]);
  useEffect(() => {
    if (device) set_vm_name(device.hostname.toLowerCase());
  }, [device?.device_id]);
  useEffect(() => {
    if (device?.model_id !== 'generic-cloud-bridge') return;
    void server_request_json<{ uplinks: { bridge: string }[]; quality: string }>(
      '/api/v1/runtime/cloud-uplinks/'
    ).then((payload) => {
      set_available_cloud_uplinks(payload.uplinks.map((item) => item.bridge));
      set_cloud_quality(payload.quality);
      set_cloud_list_error('');
    }).catch((error: unknown) => {
      set_cloud_list_error(`CLOUD_UPLINK_LIST_FAILED：${error instanceof Error ? error.message : '请求失败'}；请检查服务器配置后刷新页面。`);
    });
  }, [device?.device_id, device?.model_id]);
  if (!device) {
    return (
      <div className="panel inspector-panel">
        <div className="panel-head">
          <h2>设备检视</h2>
          <span>未选中</span>
        </div>
        <div className="empty">
          在三维场景中点击设备或端口，或在「实验内设备」中选择一台设备查看详情。
        </div>
      </div>
    );
  }

  const port: PortState | null = selected_port ? device.find_port(selected_port) : null;
  const summary = device.summary();
  const is_running = device.power_state === DEVICE_STATE.RUNNING;
  const is_wireless_client_device = is_wireless_client(device.manifest);
  const is_desktop_device = is_runtime_model(device.model_id);
  const is_bound_desktop = Boolean(bound_runtime);
  const is_network_vm = ['switch', 'l3switch', 'router', 'firewall'].includes(device.device_type);

  return (
    <div className="panel inspector-panel">
      <div className="panel-head">
        <h2>{device.hostname}</h2>
        <span>{device.vendor_profile.display_name}</span>
      </div>
      <div className="scroll">
        <div className="badge-row">
          <span className={is_running ? 'badge ok' : 'badge bad'}>
            {STATE_TEXT[device.power_state] || device.power_state}
          </span>
          <span className={device.config_saved ? 'badge ok' : 'badge warn'}>
            {device.config_saved ? '配置已保存' : '配置未保存'}
          </span>
          <span className="badge">
            {DEVICE_TYPE_TEXT[device.device_type] || device.device_type}
          </span>
          {is_network_vm && (
            <span className={bound_runtime?.quality === 'real_runtime' ? 'badge ok' : 'badge warn'}>
              {bound_runtime?.quality === 'real_runtime' ? '真实网络 VM' : 'development_mock'}
            </span>
          )}
          {device.manifest.wireless && (
            <span className="badge info">
              {device.manifest.wireless.role === 'ap' ? 'AP' : 'STA'}
            </span>
          )}
        </div>
        {device.model_id === 'generic-cloud-bridge' && (
          <div className="g0-binding-card">
            <div className="section">Cloud 宿主桥接</div>
            <p>上联选择管理员开放的 OVS 桥（桥内物理网卡由管理员配置）；下联通过设备的 eth0–eth3 网口连线。</p>
            <label htmlFor="cloud-uplink-select">上联桥接网卡</label>
            <select id="cloud-uplink-select" value={cloud_uplinks[device.device_id] || ''}
              disabled={experiment_busy}
              onChange={(event) => void set_cloud_uplink(device.device_id, event.target.value)}>
              <option value="">未接入宿主网络</option>
              {available_cloud_uplinks.map((bridge) => (
                <option key={bridge} value={bridge}>{bridge}</option>
              ))}
            </select>
            <div className="runtime-spec-note">
              {cloud_quality === 'runtime_real_configured'
                ? 'runtime_real 配置模式：保存命令成功且宿主预检通过后，由 Host Agent 接通 OVS 桥；下联设备需配置 IP/DHCP。'
                : 'development_mock：仅保存 Cloud 布局与选择，不建立真实宿主桥接。'}
            </div>
            {available_cloud_uplinks.length === 0 && <p>暂无可用桥接网卡；请管理员配置 SIMLAB_CLOUD_UPLINK_BRIDGES。</p>}
            {cloud_list_error && <p className="error">{cloud_list_error}</p>}
            {experiment_error && <p className="error">{experiment_error}</p>}
          </div>
        )}
        <div className="kv">
          <span>型号</span>
          <b>{summary.product_name}</b>
        </div>
        <div className="kv">
          <span>系统</span>
          <b>{is_network_vm && bound_runtime?.source_type === 'MANAGED'
            ? 'Ubuntu 24.04 通用 Linux 网络系统'
            : summary.os_version}</b>
        </div>
        {is_network_vm && (
          <div className="runtime-spec-note">
            {bound_runtime
              ? '实际流量经后端虚拟网卡；设备外观、厂商 CLI、温度和指示灯仍为界面模拟。请在 VNC 控制台配置客体网络功能。'
              : '当前设备尚未绑定真实网络虚拟机；厂商 CLI、状态与通信结果属于 development_mock。'}
          </div>
        )}
        <div className="kv">
          <span>序列号</span>
          <b>{summary.serial_number}</b>
        </div>
        <div className="kv">
          <span>管理 MAC</span>
          <b>{summary.mac_address}</b>
        </div>
        <div className="kv">
          <span>端口</span>
          <b>
            {summary.up_count} UP / {summary.port_count}
          </b>
        </div>
        <div className="kv">
          <span>温度</span>
          <b>{summary.temperature.toFixed(1)} ℃</b>
        </div>
        <div className="kv">
          <span>场景坐标</span>
          <b>
            x {device.position.x.toFixed(1)} · z {device.position.z.toFixed(1)}
          </b>
        </div>

        {is_desktop_device && (
          <>
            <div className="section">真实虚拟机绑定与控制台</div>
            <div className="g0-binding-card">
              <label htmlFor="desktop-runtime-select">选择已有后端虚拟机</label>
              <select
                id="desktop-runtime-select"
                value={binding_target}
                onChange={(event) => set_binding_target(event.target.value)}
              >
                <option value="">选择一台未占用虚拟机…</option>
                {available_runtimes.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.domain_name || item.id} · {item.power_state} ·{' '}
                    {item.source_type === 'EXTERNAL' ? '宿主已有' : '平台创建'}
                  </option>
                ))}
              </select>
              <div className="kv">
                <span>宿主虚拟机</span>
                <b>{bound_runtime?.domain_name || '尚未绑定'}</b>
              </div>
              <div className="kv">
                <span>实际状态</span>
                <b>{bound_runtime?.power_state || '未连接'}</b>
              </div>
              <div className="kv">
                <span>VNC</span>
                <b>
                  {bound_runtime?.vnc?.port && bound_runtime.vnc.port > 0
                    ? `${bound_runtime.vnc.listen || '127.0.0.1'}:${bound_runtime.vnc.port}`
                    : '等待开机'}
                </b>
              </div>
              <div className="kv">
                <span>资源配置</span>
                <b>
                  {bound_runtime?.resource_config.vcpu_count
                    ? `${bound_runtime.resource_config.vcpu_count} vCPU · ${bound_runtime.resource_config.memory_mib} MiB · ${bound_runtime.resource_config.disk_gib} GiB`
                    : bound_runtime?.source_type === 'EXTERNAL' ? '宿主已有配置' : '未配置'}
                </b>
              </div>
              {bound_runtime?.port_bindings?.map((mapping) => (
                <div className="kv" key={mapping.frontend_port_key}>
                  <span>实体网口 {mapping.frontend_port_key}</span>
                  <b title={mapping.mac_address || '虚拟网卡尚未观测到 MAC'}>
                    {mapping.runtime_alias}
                    {mapping.mac_address ? ` · ${mapping.mac_address}` : ' · 待观测 MAC'}
                    {` · ${mapping.network_status === 'WIRED' ? '真实链路已接线' :
                      mapping.network_status === 'PENDING_POWER_ON' ? '待开机接线' :
                      mapping.network_status === 'DISCONNECTED' ? '未接线' :
                      mapping.network_status === 'DRIFTED' ? '链路漂移，请重存实验' : '链路待同步'}`}
                  </b>
                </div>
              ))}
              <div className="actions g0-binding-actions">
                <button
                  type="button"
                  className="on"
                  disabled={!binding_target || runtime_busy}
                  onClick={() => void bind_runtime(device.device_id, binding_target)}
                >
                  {runtime_busy ? '处理中…' : '绑定已有虚拟机'}
                </button>
                <button type="button" disabled={runtime_busy} onClick={() => void refresh_runtimes()}>
                  刷新状态
                </button>
                {is_bound_desktop && (
                  <button
                    type="button"
                    disabled={runtime_busy}
                    onClick={() => void unbind_runtime(device.device_id)}
                  >
                    解除绑定
                  </button>
                )}
                {is_bound_desktop && (
                  <button
                    type="button"
                    disabled={!bound_runtime?.novnc_url}
                    onClick={() =>
                      window.dispatchEvent(
                        new CustomEvent('simlab:open-vnc', {
                          detail: { device_id: device.device_id }
                        })
                      )
                    }
                  >
                    放大 VNC 画面
                  </button>
                )}
              </div>
              {!is_bound_desktop && desktop_profile && (
                <div className="runtime-inline-create">
                  <b>没有可用实例？按参数创建后端虚拟机</b>
                  <div className="runtime-inline-spec">
                    <label>
                      虚拟机名称
                      <input
                        type="text"
                        maxLength={63}
                        value={vm_name}
                        onChange={(event) => set_vm_name(event.target.value.toLowerCase())}
                      />
                    </label>
                    <label>
                      vCPU
                      <input
                        type="number"
                        min={desktop_profile.limits.vcpu_count[0]}
                        max={desktop_profile.limits.vcpu_count[1]}
                        value={vcpu_count}
                        onChange={(event) => set_vcpu_count(Number(event.target.value))}
                      />
                    </label>
                    <label>
                      内存 MiB
                      <input
                        type="number"
                        min={desktop_profile.limits.memory_mib[0]}
                        max={desktop_profile.limits.memory_mib[1]}
                        step={256}
                        value={memory_mib}
                        onChange={(event) => set_memory_mib(Number(event.target.value))}
                      />
                    </label>
                    <label>
                      磁盘 GiB
                      <input
                        type="number"
                        min={desktop_profile.limits.disk_gib[0]}
                        max={desktop_profile.limits.disk_gib[1]}
                        value={disk_gib}
                        onChange={(event) => set_disk_gib(Number(event.target.value))}
                      />
                    </label>
                    <label>
                      网卡型号
                      <select
                        value={nic_model}
                        onChange={(event) => set_nic_model(event.target.value as 'virtio' | 'e1000')}
                      >
                        {(desktop_profile.capabilities.nic_models || ['virtio']).map((model) => (
                          <option key={model} value={model}>{model}</option>
                        ))}
                      </select>
                    </label>
                    <label>
                      显示适配器
                      <select value="virtio" disabled>
                        <option value="virtio">Virtio GPU</option>
                      </select>
                    </label>
                  </div>
                  <button
                    type="button"
                    className="on"
                    disabled={runtime_busy}
                    onClick={() =>
                      void provision_runtime(device.device_id, {
                        profile_release_id: desktop_profile.profile_release_id,
                        image_release: desktop_profile.image_release,
                        vm_name: vm_name,
                        memory_mib: memory_mib,
                        vcpu_count: vcpu_count,
                        disk_gib: disk_gib,
                        nic_model: nic_model,
                        nic_aliases: ['eth0'],
                        gpu_model: 'virtio'
                      })
                    }
                  >
                    按以上参数创建并绑定
                  </button>
                </div>
              )}
              {is_bound_desktop && (
                <div className="g0-binding-ok">已映射到当前设备的三维屏幕</div>
              )}
              {runtime_error && <div className="g0-binding-error">{runtime_error}</div>}
            </div>
          </>
        )}

        <div className="section">设备操作</div>
        <div className="actions">
          <button
            type="button"
            disabled={is_desktop_device && (!is_bound_desktop || runtime_busy)}
            onClick={() => void toggle_power(device.device_id)}
          >
            {is_running ? '关机' : '开机'}
          </button>
          <button type="button" onClick={() => void save_config(device.device_id)}>
            保存配置
          </button>
          <button
            type="button"
            onClick={() => void inject_fault(device.device_id, null, 'high_temp')}
          >
            注入高温
          </button>
        </div>

        <div className="section">连通性测试（端到端转发）</div>
        <div className="ping-row">
          <select value={ping_target} onChange={(event) => set_ping_target(event.target.value)}>
            <option value="">选择目标设备…</option>
            {(runtime ? runtime.list_devices() : [])
              .filter((item) => item.device_id !== device.device_id)
              .map((item) => (
                <option key={item.device_id} value={item.device_id}>
                  {item.hostname}（{item.model_id}）
                </option>
              ))}
          </select>
          <button
            type="button"
            disabled={!ping_target}
            onClick={() => void ping(device.device_id, { device_id: ping_target })}
          >
            Ping
          </button>
        </div>
        {ping_result && (
          <div className={ping_result.reachable ? 'ping-result ok' : 'ping-result bad'}>
            <div>
              {ping_result.reachable
                ? `可达 · 平均 ${ping_result.rtt_avg_ms} ms · 丢包 ${ping_result.loss_percent}%`
                : `不可达（${ping_result.unreachable_reason}）`}
            </div>
            {ping_result.path.length > 0 && (
              <div className="path">{ping_result.path.join(' → ')}</div>
            )}
          </div>
        )}

        <div className="section">
          端口列表{link_source ? '（连线模式：点击目标端口完成连接）' : ''}
        </div>
        {link_source && (
          <div className="link-banner">
            已选择起点 {link_source.device_id} / {link_source.port}
            <button type="button" onClick={cancel_link}>
              取消
            </button>
          </div>
        )}
        <table className="port-table">
          <thead>
            <tr>
              <th>端口</th>
              <th>状态</th>
              <th>速率</th>
              <th>VLAN</th>
              <th>对端</th>
            </tr>
          </thead>
          <tbody>
            {device.ports.map((item) => {
              const is_up = item.link_up;
              return (
                <tr
                  key={item.short_name}
                  className={item.short_name === selected_port ? 'selected' : ''}
                  onClick={() => {
                    if (
                      link_source &&
                      (link_source.device_id !== device.device_id ||
                        link_source.port !== item.short_name)
                    ) {
                      void complete_link({ device_id: device.device_id, port: item.short_name });
                    } else {
                      select_port(device.device_id, item.short_name);
                    }
                  }}
                >
                  <td>{item.short_name}</td>
                  <td>
                    <span
                      className={is_up ? 'badge ok' : item.admin_up ? 'badge bad' : 'badge warn'}
                    >
                      {!item.admin_up ? 'ADMIN DOWN' : is_up ? 'UP' : 'DOWN'}
                    </span>
                  </td>
                  <td>{is_up ? item.speed : '--'}</td>
                  <td>{item.vlan}</td>
                  <td>{item.peer_device_id ? item.peer_device_id + '/' + item.peer_port : '--'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {port && (
          <>
            <div className="section">
              端口 {port.name}
              {port.cable ? '（已接线）' : ''}
            </div>
            <div className="actions">
              {!port.plugged ? (
                <>
                  <button
                    type="button"
                    onClick={() =>
                      start_link({ device_id: device.device_id, port: port.short_name })
                    }
                  >
                    连线到其它设备
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      void connect_peer({ device_id: device.device_id, port: port.short_name })
                    }
                  >
                    接模拟对端
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="warn"
                  onClick={() => void disconnect_port(device.device_id, port.short_name)}
                >
                  拔出线缆
                </button>
              )}
              <button
                type="button"
                onClick={() =>
                  void configure_port(device.device_id, port.short_name, {
                    admin_up: !port.admin_up
                  })
                }
              >
                {port.admin_up ? 'shutdown' : 'undo shutdown'}
              </button>
            </div>
            <div className="actions">
              {[1, 10, 20, 30].map((vlan) => (
                <button
                  key={vlan}
                  type="button"
                  className={port.vlan === vlan ? 'on' : ''}
                  onClick={() =>
                    void configure_port(device.device_id, port.short_name, { vlan: vlan })
                  }
                >
                  VLAN {vlan}
                </button>
              ))}
            </div>
            <div className="actions">
              <button
                type="button"
                className="warn"
                onClick={() => void inject_fault(device.device_id, port.short_name, 'crc')}
              >
                注入 CRC
              </button>
              <button
                type="button"
                className="warn"
                onClick={() => void inject_fault(device.device_id, port.short_name, 'cable_broken')}
              >
                模拟断纤
              </button>
            </div>
          </>
        )}

        {is_wireless_client_device && (
          <div className="note">
            无线客户端：在「无线」面板选择 AP 关联，或直接观察 3D 中的关联线与漫游。
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * 无线仿真面板。
 *
 * @returns {JSX.Element} 组件。
 */
export function WirelessPanel(): JSX.Element {
  const runtime = use_store((state) => state.runtime);
  const wireless = use_store((state) => state.wireless);
  const desktop_runtimes = use_store((state) => state.desktop_runtimes);
  const experiment_error = use_store((state) => state.experiment_error);
  const associate = use_store((state) => state.associate);
  const disassociate = use_store((state) => state.disassociate);
  const refresh_wireless = use_store((state) => state.refresh_wireless);
  const configure_ap_radio = use_store((state) => state.configure_ap_radio);
  const current_experiment_role = use_store((state) => state.current_experiment_role);
  const revision = use_store((state) => state.revision);
  void revision;

  const devices = runtime ? runtime.list_devices() : [];
  const aps = devices.filter((device) => is_wireless_ap(device.manifest));
  const clients = devices.filter((device) => is_wireless_client(device.manifest));
  const associations = wireless?.associations || [];

  return (
    <div className="panel wireless-panel">
      <div className="panel-head">
        <h2>无线（Wi-Fi）仿真</h2>
        <button type="button" className="mini" onClick={() => void refresh_wireless()}>
          刷新
        </button>
      </div>
      <div className="scroll">
        <div className="empty">
          射频覆盖与速率为浏览器模型（VISUAL）。绑定双网卡笔记本后，关联会把虚拟 eth1
          接入 AP 的 LAN，上联经 AP 网口进入实验网络；RJ45 保持 eth0。
          客体识别的是以太网接口，当前数据通路不模拟真实 802.11 帧或射频损耗。
        </div>
        {experiment_error && <div className="empty">{experiment_error}</div>}
        <div className="kv">
          <span>运行时适配器</span>
          <b>{wireless?.runtime?.adapter || '未启动'}</b>
        </div>
        <div className="kv">
          <span>信道 / 频段</span>
          <b>
            {wireless?.runtime?.channel ?? '-'} / {wireless?.runtime?.band || '-'}
          </b>
        </div>
        <div className="section">接入点（AP）</div>
        {(wireless?.aps || []).map((ap) => (
          <div key={ap.device_id} className="wireless-card">
            <div>
              <b>{ap.ssid}</b>
              <em>
                {ap.device_id} · CH{ap.channel} · {ap.tx_power_dbm} dBm
              </em>
            </div>
            <div className="metrics">
              <span>覆盖 {ap.coverage_radius_m} m</span>
              <span>客户端 {ap.client_count}</span>
              <span>利用率 {(ap.channel_utilization * 100).toFixed(0)}%</span>
            </div>
            <form
              key={`${ap.device_id}:${ap.ssid}:${ap.channel}:${ap.tx_power_dbm}`}
              onSubmit={(event) => {
                event.preventDefault();
                const values = new FormData(event.currentTarget);
                void configure_ap_radio(ap.device_id, {
                  ssid: String(values.get('ssid') || ''),
                  channel: Number(values.get('channel')),
                  tx_power_dbm: Number(values.get('tx_power_dbm'))
                });
              }}
            >
              <label>SSID
                <input name="ssid" type="text" defaultValue={ap.ssid} maxLength={32} />
              </label>
              <label>信道
                <select name="channel" defaultValue={ap.channel}>
                  {[1, 6, 11, 36, 40, 44, 48].map((channel) =>
                    <option key={channel} value={channel}>{channel}</option>)}
                </select>
              </label>
              <label>功率 dBm
                <input name="tx_power_dbm" type="number" min={0} max={30}
                  defaultValue={ap.tx_power_dbm} />
              </label>
              <button type="submit" disabled={current_experiment_role === 'VIEWER'}>
                应用射频模型参数
              </button>
            </form>
          </div>
        ))}
        {aps.length === 0 && <div className="empty">尚未创建 AP 设备</div>}

        <div className="section">无线客户端与关联</div>
        {clients.map((client) => {
          const association = associations.find((item) => item.sta_device_id === client.device_id);
          const bound_runtime = desktop_runtimes.find(
            (item) => item.bound_device_id === client.device_id
          );
          const radio_port = bound_runtime?.port_bindings?.find(
            (port) => port.frontend_port_key === 'RADIO0'
          );
          return (
            <div key={client.device_id} className="wireless-card">
              <div>
                <b>{client.hostname}</b>
                <em>{association ? '关联 ' + association.ap_device_id : '未关联'}</em>
                {bound_runtime && <em>{radio_port
                  ? `虚拟 eth1 → AP LAN · ${radio_port.network_status === 'WIRED'
                    ? '已接通' : '待接通／请检查 AP 与 Host Agent'}`
                  : 'WIRELESS_NIC_MISSING：缺少独立 eth1，请绑定双网卡实例'}</em>}
              </div>
              {association ? (
                <>
                  <div className="metrics">
                    <span>
                      RSSI {association.rssi_dbm} dBm（{rssi_text(association.rssi_dbm)}）
                    </span>
                    <span>{association.phy_rate_mbps} Mbps</span>
                    <span>吞吐 {association.throughput_mbps} Mbps</span>
                    <span>重传 {association.retries}</span>
                  </div>
                  <div className="actions">
                    <button type="button" onClick={() => void disassociate(client.device_id)}>
                      断开
                    </button>
                  </div>
                </>
              ) : (
                <div className="actions">
                  {aps.map((ap) => (
                    <button
                      key={ap.device_id}
                      type="button"
                      onClick={() => void associate(client.device_id, ap.device_id)}
                    >
                      关联 {ap.manifest.wireless?.ssid_default || ap.hostname}
                    </button>
                  ))}
                  <button
                    type="button"
                    className="on"
                    onClick={() => void associate(client.device_id)}
                  >
                    自动选择最强
                  </button>
                </div>
              )}
            </div>
          );
        })}
        {clients.length === 0 && <div className="empty">尚未创建无线客户端（笔记本 / 手机）</div>}
      </div>
    </div>
  );
}

/**
 * 光链路（PON）面板：OLT 容量、ONU 光功率/测距/告警，以及改线与业务负载实验。
 *
 * @returns {JSX.Element} 组件。
 */
export function OpticalPanel(): JSX.Element {
  const runtime = use_store((state) => state.runtime);
  const optical = use_store((state) => state.optical);
  const refresh_optical = use_store((state) => state.refresh_optical);
  const set_optical_fiber = use_store((state) => state.set_optical_fiber);
  const set_optical_traffic = use_store((state) => state.set_optical_traffic);
  const revision = use_store((state) => state.revision);
  void revision;

  const devices = runtime ? runtime.list_devices() : [];
  const olts = devices.filter((device) => is_olt(device.manifest));
  const onus = devices.filter((device) => is_onu(device.manifest));
  const links = optical?.links || [];
  const alarms = optical?.alarms || [];

  /**
   * 光链路状态样式。
   *
   * @param {string} state 状态码。
   * @returns {string} CSS 类名。
   */
  const state_class = (state: string): string => {
    if (state === 'WORKING') {
      return 'badge ok';
    }
    if (state === 'MARGINAL') {
      return 'badge warn';
    }
    return 'badge bad';
  };

  return (
    <div className="panel wireless-panel">
      <div className="panel-head">
        <h2>光链路（GPON）仿真</h2>
        <button type="button" className="mini" onClick={() => void refresh_optical()}>
          刷新
        </button>
      </div>
      <div className="scroll">
        <div className="kv">
          <span>运行时适配器</span>
          <b>{optical?.runtime?.adapter || '未启动'}</b>
        </div>
        <div className="kv">
          <span>仿真进程 / C 内核</span>
          <b>
            {optical?.runtime?.process || '-'} ·{' '}
            {optical?.runtime?.c_lib ? 'C 内核' : 'Python 回落'}
          </b>
        </div>

        <div className="section">OLT（局端）</div>
        {(optical?.olts || []).map((olt) => (
          <div key={olt.node_id} className="wireless-card">
            <div>
              <b>{olt.node_id}</b>
              <em>
                PON 口 {olt.pon_ports} · ONU {olt.onu_count} · 发光 {olt.tx_power_dbm} dBm
              </em>
            </div>
            <div className="metrics">
              <span>
                下行 {olt.downstream_used_mbps}/{olt.downstream_capacity_mbps} Mbps
              </span>
              <span>
                上行 {olt.upstream_used_mbps}/{olt.upstream_capacity_mbps} Mbps
              </span>
            </div>
          </div>
        ))}
        {olts.length === 0 && (
          <div className="empty">尚未创建 OLT 设备（目录中的「通用 GPON OLT」）</div>
        )}

        <div className="section">ONU 光链路与光功率</div>
        {links.map((link) => (
          <div key={link.onu_id} className="wireless-card">
            <div>
              <b>{link.onu_id}</b>
              <em>
                上联 {link.olt_id} · {link.fiber_length_m} m · 分光 1:{link.splitter_ratio}
              </em>
            </div>
            <div className="badge-row">
              <span className={state_class(link.state)}>{link.state}</span>
              {link.alarm && <span className="badge bad">告警 {link.alarm}</span>}
              <span className="badge info">RX {link.rx_power_dbm.toFixed(2)} dBm</span>
              <span className="badge">余量 {link.power_margin_db.toFixed(2)} dB</span>
            </div>
            <div className="metrics">
              <span>插损 {link.total_loss_db.toFixed(2)} dB</span>
              <span>RTD {(link.rtd_ns / 1000).toFixed(1)} μs</span>
              <span>BER {link.ber.toExponential(0)}</span>
              <span>
                DBA {link.downstream_allocated_mbps}/{link.upstream_allocated_mbps} Mbps
              </span>
            </div>
            <div className="actions">
              {[500, 2400, 12000, 20000].map((length) => (
                <button
                  key={length}
                  type="button"
                  className={Math.round(link.fiber_length_m) === length ? 'on' : ''}
                  onClick={() => void set_optical_fiber(link.onu_id, { fiber_length_m: length })}
                >
                  {length >= 1000 ? length / 1000 + ' km' : length + ' m'}
                </button>
              ))}
            </div>
            <div className="actions">
              {[2, 8, 32, 64].map((ratio) => (
                <button
                  key={ratio}
                  type="button"
                  className={link.splitter_ratio === ratio ? 'on' : ''}
                  onClick={() => void set_optical_fiber(link.onu_id, { splitter_ratio: ratio })}
                >
                  1:{ratio}
                </button>
              ))}
            </div>
            <div className="actions">
              <button
                type="button"
                className={link.broken ? 'on warn' : 'warn'}
                onClick={() => void set_optical_fiber(link.onu_id, { broken: !link.broken })}
              >
                {link.broken ? '恢复光纤' : '模拟断纤'}
              </button>
            </div>
            <div className="actions">
              {[
                { label: '轻载 100M', down: 100, up: 40 },
                { label: '中载 400M', down: 400, up: 160 },
                { label: '重载 900M', down: 900, up: 360 }
              ].map((profile) => (
                <button
                  key={profile.label}
                  type="button"
                  className={Math.round(link.downstream_mbps) === profile.down ? 'on' : ''}
                  onClick={() =>
                    void set_optical_traffic(link.onu_id, {
                      downstream_mbps: profile.down,
                      upstream_mbps: profile.up
                    })
                  }
                >
                  {profile.label}
                </button>
              ))}
            </div>
          </div>
        ))}
        {onus.length > 0 && links.length === 0 && (
          <div className="empty">
            已创建 ONU 但尚未绑定 OLT：用光纤线缆把 ONU 的 GPON 口连到 OLT 的 PON 口即可自动纳管。
          </div>
        )}
        {onus.length === 0 && (
          <div className="empty">尚未创建 ONU 设备（目录中的「通用 GPON ONU」）</div>
        )}

        <div className="section">光功率告警</div>
        {alarms.map((alarm) => (
          <div key={alarm.onu_id + alarm.code} className="ping-result bad">
            <div>
              <b>{alarm.code}</b> · {alarm.onu_id}
            </div>
            <div className="path">{alarm.message}</div>
          </div>
        ))}
        {alarms.length === 0 && <div className="empty">当前无光功率告警</div>}
      </div>
    </div>
  );
}

/**
 * 事件流面板。
 *
 * @returns {JSX.Element} 组件。
 */
export function EventPanel(): JSX.Element {
  const events = use_store((state) => state.events);
  return (
    <div className="event-list">
      {events
        .slice()
        .reverse()
        .slice(0, 90)
        .map((event) => (
          <div key={event.event_id} className="event-line">
            <span className="t">{event_time(event)}</span>
            <span className="type">{event.event_type}</span>
            {describe_event(event)}
          </div>
        ))}
      {events.length === 0 && <div className="empty">暂无事件</div>}
    </div>
  );
}

/**
 * 顶部状态条。
 *
 * @returns {JSX.Element} 组件。
 */
export function StatusBar(): JSX.Element {
  const runtime = use_store((state) => state.runtime);
  const runtime_mode = use_store((state) => state.runtime_mode);
  const api_base = use_store((state) => state.api_base);
  const wireless = use_store((state) => state.wireless);
  const desktop_runtimes = use_store((state) => state.desktop_runtimes);
  const revision = use_store((state) => state.revision);
  void revision;

  const devices = runtime ? runtime.list_devices() : [];
  const up_ports = devices.reduce(
    (sum, device) => sum + device.ports.filter((port) => port.link_up).length,
    0
  );
  const total_ports = devices.reduce((sum, device) => sum + device.ports.length, 0);
  const throughput = devices.reduce(
    (sum, device) =>
      sum + device.ports.reduce((inner, port) => inner + (port.link_up ? port.traffic_rate : 0), 0),
    0
  );
  const temperature =
    devices.length > 0 ? Math.max(...devices.map((device) => device.environment.temperature)) : 0;

  return (
    <div className="status-bar">
      <div className="chips">
        <div className="chip">
          <b>
            {up_ports}/{total_ports}
          </b>
          UP 端口
        </div>
        <div className="chip">
          <b>{throughput.toFixed(1)}</b>
          转发 Gbps
        </div>
        <div className="chip warn">
          <b>{temperature.toFixed(1)}</b>
          最高温度 ℃
        </div>
        <div className="chip">
          <b>{devices.length}</b>
          设备
        </div>
        <div className="chip">
          <b>{(wireless?.associations || []).length}</b>
          无线关联
        </div>
        <div className={runtime_mode === 'remote' ? 'chip ok' : 'chip'}>
          <b>{runtime_mode === 'remote' ? 'Django/DRF' : '本地模拟'}</b>
          Runtime{api_base ? '（' + api_base.replace(/^https?:\/\//, '') + '）' : ''}
        </div>
        {desktop_runtimes.length > 0 && (
          <div className="chip ok">
            <b>
              {desktop_runtimes.filter((item) => item.bound_device_id).length}/
              {desktop_runtimes.length} 已绑定
            </b>
            虚拟机资源池
          </div>
        )}
      </div>
    </div>
  );
}
