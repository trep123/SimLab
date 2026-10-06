import { useEffect, useState } from 'react';

import type { JSX } from 'react';

import { use_store } from '../core/store';
import { resolve_render_profile } from '../core/render_settings';
import {
  list_experiment_members,
  remove_experiment_member,
  set_experiment_member
} from '../core/server_api';
import type { RenderQuality } from '../core/render_settings';
import type { ExperimentMemberSummary } from '../core/server_api';

/** 实验保存、载入与新建窗口。 */
export function ExperimentManagerDialog(): JSX.Element | null {
  const open = use_store((state) => state.experiment_manager_open);
  const current_name = use_store((state) => state.experiment_name);
  const current_id = use_store((state) => state.experiment_id);
  const saved = use_store((state) => state.saved_experiments);
  const busy = use_store((state) => state.experiment_busy);
  const error = use_store((state) => state.experiment_error);
  const last_saved_at = use_store((state) => state.last_saved_at);
  const current_role = use_store((state) => state.current_experiment_role);
  const set_open = use_store((state) => state.set_experiment_manager_open);
  const save_experiment = use_store((state) => state.save_experiment);
  const new_experiment = use_store((state) => state.new_experiment);
  const load_experiment = use_store((state) => state.load_experiment);
  const delete_saved = use_store((state) => state.delete_saved_experiment);
  const [name, set_name] = useState(current_name);
  const [members, set_members] = useState<ExperimentMemberSummary[]>([]);
  const [member_name, set_member_name] = useState('');
  const [member_role, set_member_role] = useState<'EDITOR' | 'VIEWER'>('EDITOR');
  const [member_busy, set_member_busy] = useState(false);
  const [member_error, set_member_error] = useState('');

  useEffect(() => {
    if (open) {
      set_name(current_name);
    }
  }, [open, current_name]);

  useEffect(() => {
    if (!open) {
      return;
    }
    void list_experiment_members(current_id)
      .then(set_members)
      .catch((reason) => {
        set_member_error(
          `EXP_MEMBER_LIST_FAILED：${reason instanceof Error ? reason.message : '无法读取成员权限'}`
        );
      });
  }, [open, current_id]);

  if (!open) {
    return null;
  }

  return (
    <div className="platform-dialog" role="dialog" aria-modal="true" aria-label="实验管理">
      <div className="platform-dialog-window experiment-manager-window">
        <div className="platform-dialog-head">
          <div>
            <h2>实验管理</h2>
            <span>服务器保存 · 账户隔离 · OWNER/EDITOR/VIEWER 权限</span>
          </div>
          <button type="button" onClick={() => set_open(false)} aria-label="关闭实验管理">
            ×
          </button>
        </div>
        <div className="platform-dialog-body">
          <label className="platform-field">
            <span>当前实验名称</span>
            <input
              value={name}
              maxLength={80}
              onChange={(event) => set_name(event.target.value)}
              placeholder="例如：VLAN 与路由综合实验"
            />
          </label>
          <div className="experiment-current-meta">
            <span>ID：{current_id}</span>
            <span>
              {last_saved_at ? '上次保存：' + new Date(last_saved_at).toLocaleString() : '尚未保存'}
            </span>
          </div>
          <div className="platform-dialog-actions">
            <button
              type="button"
              disabled={busy || !name.trim() || current_role === 'VIEWER'}
              onClick={() => void save_experiment(name)}
            >
              {busy ? '处理中…' : '保存当前实验'}
            </button>
            <button type="button" disabled={busy} onClick={() => void new_experiment(name)}>
              新建空白实验
            </button>
          </div>
          {error && <div className="platform-error">{error}</div>}
          <div className="experiment-library-title">
            <b>已保存实验</b>
            <span>共 {saved.length} 个，保存在服务器并按账户授权</span>
          </div>
          <div className="experiment-library">
            {saved.length === 0 && <div className="experiment-empty">暂无已保存实验</div>}
            {saved.map((item) => (
              <div
                key={item.experiment_id}
                className={'experiment-card' + (item.experiment_id === current_id ? ' current' : '')}
              >
                <div>
                  <b>{item.name}</b>
                  <span>{new Date(item.updated_at).toLocaleString()}</span>
                  <small>
                    {item.device_count} 台设备 · {item.cable_count} 条线缆
                  </small>
                  <small>所有者：{item.owner} · 权限：{item.role}</small>
                </div>
                <div className="experiment-card-actions">
                  <button type="button" disabled={busy} onClick={() => void load_experiment(item.experiment_id)}>
                    载入
                  </button>
                  <button
                    type="button"
                    className="warn"
                    disabled={busy || item.role !== 'OWNER' || item.experiment_id === current_id}
                    onClick={() => void delete_saved(item.experiment_id)}
                  >
                    删除
                  </button>
                </div>
              </div>
            ))}
          </div>
          <div className="experiment-library-title">
            <b>当前实验成员</b>
            <span>{current_role === 'OWNER' ? '所有者可添加编辑者或查看者' : '仅所有者可修改权限'}</span>
          </div>
          {current_role === 'OWNER' && (
            <div className="experiment-member-form">
              <input
                value={member_name}
                placeholder="已存在的服务器用户名"
                onChange={(event) => set_member_name(event.target.value)}
              />
              <select
                value={member_role}
                onChange={(event) => set_member_role(event.target.value as 'EDITOR' | 'VIEWER')}
              >
                <option value="EDITOR">编辑者</option>
                <option value="VIEWER">查看者</option>
              </select>
              <button
                type="button"
                disabled={member_busy || !member_name.trim()}
                onClick={() => {
                  set_member_busy(true);
                  set_member_error('');
                  void set_experiment_member(current_id, member_name.trim(), member_role)
                    .then(() => list_experiment_members(current_id))
                    .then((items) => {
                      set_members(items);
                      set_member_name('');
                      void use_store.getState().refresh_experiment_library();
                    })
                    .catch((reason) => {
                      set_member_error(
                        `EXP_MEMBER_SAVE_FAILED：${reason instanceof Error ? reason.message : '成员权限保存失败'}`
                      );
                    })
                    .finally(() => set_member_busy(false));
                }}
              >
                添加/更新
              </button>
            </div>
          )}
          {member_error && <div className="platform-error">{member_error}</div>}
          <div className="experiment-members">
            {members.map((member) => (
              <div key={member.user_id}>
                <span>{member.username}</span>
                <b>{member.role}</b>
                {current_role === 'OWNER' && member.role !== 'OWNER' && (
                  <button
                    type="button"
                    disabled={member_busy}
                    onClick={() => {
                      set_member_busy(true);
                      void remove_experiment_member(current_id, member.user_id)
                        .then(() => list_experiment_members(current_id))
                        .then(set_members)
                        .catch((reason) => {
                          set_member_error(
                            `EXP_MEMBER_REMOVE_FAILED：${reason instanceof Error ? reason.message : '移除成员失败'}`
                          );
                        })
                        .finally(() => set_member_busy(false));
                    }}
                  >
                    移除
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

const QUALITY_LABELS: { value: RenderQuality; label: string; detail: string }[] = [
  { value: 'auto', label: '自动', detail: '按 CPU、内存和屏幕密度自动选择' },
  { value: 'low', label: '低', detail: '30 FPS、低像素比、关闭环境反射和阴影' },
  { value: 'medium', label: '中', detail: '45 FPS、标准像素比、1024 阴影' },
  { value: 'high', label: '高', detail: '60 FPS、1.5 倍像素比、2048 阴影' },
  { value: 'ultra', label: '极致', detail: '60 FPS、2 倍像素比、4096 阴影' }
];

/** 画质、阴影和灯光实时设置窗口。 */
export function VisualSettingsDialog(): JSX.Element | null {
  const open = use_store((state) => state.visual_settings_open);
  const settings = use_store((state) => state.render_settings);
  const set_open = use_store((state) => state.set_visual_settings_open);
  const update = use_store((state) => state.update_render_settings);
  if (!open) {
    return null;
  }
  const profile = resolve_render_profile(settings.quality);

  return (
    <div className="platform-dialog" role="dialog" aria-modal="true" aria-label="画质与光照设置">
      <div className="platform-dialog-window visual-settings-window">
        <div className="platform-dialog-head">
          <div>
            <h2>画质与光照</h2>
            <span>所有调整立即作用于三维场景，并随实验保存</span>
          </div>
          <button type="button" onClick={() => set_open(false)} aria-label="关闭画质设置">
            ×
          </button>
        </div>
        <div className="platform-dialog-body">
          <label className="platform-field">
            <span>画质档位</span>
            <select
              value={settings.quality}
              onChange={(event) => update({ quality: event.target.value as RenderQuality })}
            >
              {QUALITY_LABELS.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label} — {item.detail}
                </option>
              ))}
            </select>
          </label>
          <div className="quality-budget">
            当前预算：{profile.resolved_quality.toUpperCase()} · {profile.target_fps} FPS · 像素比上限{' '}
            {profile.pixel_ratio} · VNC {profile.vnc_fps} FPS
          </div>
          <label className="platform-switch">
            <input
              type="checkbox"
              checked={settings.shadows_enabled}
              disabled={profile.resolved_quality === 'low'}
              onChange={(event) => update({ shadows_enabled: event.target.checked })}
            />
            <span>实时阴影</span>
            <small>{profile.resolved_quality === 'low' ? '低画质自动关闭' : '增强设备落地感与空间层次'}</small>
          </label>
          <label className="platform-switch">
            <input
              type="checkbox"
              checked={settings.lighting_enabled}
              onChange={(event) => update({ lighting_enabled: event.target.checked })}
            />
            <span>摄影棚光照</span>
            <small>关闭后仅保留最低可见光</small>
          </label>
          <label className="platform-range">
            <span>光照强度</span>
            <input
              type="range"
              min="20"
              max="180"
              step="5"
              value={Math.round(settings.lighting_intensity * 100)}
              onChange={(event) => update({ lighting_intensity: Number(event.target.value) / 100 })}
            />
            <b>{Math.round(settings.lighting_intensity * 100)}%</b>
          </label>
          <label className="platform-range">
            <span>曝光</span>
            <input
              type="range"
              min="45"
              max="150"
              step="1"
              value={Math.round(settings.exposure * 100)}
              onChange={(event) => update({ exposure: Number(event.target.value) / 100 })}
            />
            <b>{settings.exposure.toFixed(2)}</b>
          </label>
          <button type="button" className="reset-visual" onClick={() => update({ quality: 'auto', shadows_enabled: true, lighting_enabled: true, lighting_intensity: 1, exposure: 0.96 })}>
            恢复自动设置
          </button>
        </div>
      </div>
    </div>
  );
}
