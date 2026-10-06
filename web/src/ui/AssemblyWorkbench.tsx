/**
 * @File : web/src/ui/AssemblyWorkbench.tsx
 * @Time : 2026-10-06 19:20
 * @Author : Cetrp
 * @Description : 设备工坊界面：左侧部件库（按类别）、中间独立三维组装台、右侧参数表单与模板元信息，
 *               装配完成的设备保存后即出现在设备栏，可在主场景拖拽、连线、开关机与调试。
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import type { JSX } from 'react';

import { use_store } from '../core/store';
import { AssemblyScene } from '../editor/assembly_scene';
import { get_part_definition, PART_CATEGORY_LABELS, parts_by_category } from '../devices/parts';

import type { DeviceTemplate, PartCategory, PartSpec } from '../devices/template_types';

/** 设备类型选项。 */
const DEVICE_TYPES = [
  { value: 'switch', label: '交换机' },
  { value: 'l3switch', label: '三层交换机' },
  { value: 'router', label: '路由器' },
  { value: 'firewall', label: '防火墙' },
  { value: 'ap', label: '无线 AP' },
  { value: 'laptop', label: '笔记本' },
  { value: 'phone', label: '手机' },
  { value: 'pc', label: '台式机' },
  { value: 'server', label: '服务器' },
  { value: 'olt', label: 'OLT' },
  { value: 'onu', label: 'ONU' }
];

/**
 * 设备工坊。
 *
 * @returns {JSX.Element | null} 组件；未打开时返回 null。
 */
export function AssemblyWorkbench(): JSX.Element | null {
  const open = use_store((state) => state.workshop_open);
  const template = use_store((state) => state.workshop_template);
  const selected_part_id = use_store((state) => state.workshop_part_id);
  const explode = use_store((state) => state.workshop_explode);
  const select_part = use_store((state) => state.select_workshop_part);
  const update_part = use_store((state) => state.update_workshop_part);
  const add_part = use_store((state) => state.add_workshop_part);
  const remove_part = use_store((state) => state.remove_workshop_part);
  const move_part = use_store((state) => state.move_workshop_part);
  const update_meta = use_store((state) => state.update_workshop_meta);
  const set_explode = use_store((state) => state.set_workshop_explode);
  const gizmo_mode = use_store((state) => state.workshop_gizmo);
  const set_gizmo = use_store((state) => state.set_workshop_gizmo);
  const snap_mm = use_store((state) => state.workshop_snap_mm);
  const set_snap = use_store((state) => state.set_workshop_snap);
  const display_mode = use_store((state) => state.workshop_display);
  const set_display = use_store((state) => state.set_workshop_display);
  const grid_visible = use_store((state) => state.workshop_grid);
  const set_grid = use_store((state) => state.set_workshop_grid);
  const history_depth = use_store((state) => state.workshop_history.length);
  const future_depth = use_store((state) => state.workshop_future.length);
  const undo_workshop = use_store((state) => state.undo_workshop);
  const redo_workshop = use_store((state) => state.redo_workshop);
  const update_transform = use_store((state) => state.update_workshop_transform);
  const reset_transform = use_store((state) => state.reset_workshop_transform);
  const duplicate_part = use_store((state) => state.duplicate_workshop_part);
  const save_workshop = use_store((state) => state.save_workshop);
  const close_workshop = use_store((state) => state.close_workshop);
  const create_device = use_store((state) => state.create_device);

  const host_ref = useRef<HTMLDivElement | null>(null);
  const scene_ref = useRef<AssemblyScene | null>(null);
  const [category, set_category] = useState<PartCategory>('chassis');
  const [saved_hint, set_saved_hint] = useState('');
  const [auto_rotate, set_auto_rotate] = useState(true);

  const selected_part: PartSpec | null = useMemo(() => {
    if (!template || !selected_part_id) {
      return null;
    }
    return template.parts.find((part) => part.part_id === selected_part_id) || null;
  }, [template, selected_part_id]);

  /* 打开工坊时创建三维工作台，关闭时释放。 */
  useEffect(() => {
    if (!open || !host_ref.current) {
      return;
    }
    const scene = new AssemblyScene(host_ref.current, {
      on_part_selected: (part_id) => use_store.getState().select_workshop_part(part_id),
      on_transform_commit: (part_id, transform) => {
        use_store.getState().update_workshop_transform(part_id, transform);
        set_saved_hint('已应用变换：' + part_id);
      }
    });
    scene_ref.current = scene;
    scene.set_auto_rotate(true);
    const on_resize = (): void => scene.resize();
    window.addEventListener('resize', on_resize);

    return () => {
      window.removeEventListener('resize', on_resize);
      scene.dispose();
      scene_ref.current = null;
    };
  }, [open]);

  /* 模板或几何参数变化时重建装配结果：去抖 + 保留选中（编辑参数时表单不消失）。 */
  useEffect(() => {
    const scene = scene_ref.current;
    if (!scene || !template) {
      return;
    }
    const handle = window.setTimeout(() => {
      const state = use_store.getState();
      scene.load_template(template, { preserve_selection: true });
      if (state.workshop_part_id) {
        scene.select_part(state.workshop_part_id);
      }
      scene.set_explode(state.workshop_explode);
    }, 90);

    return () => window.clearTimeout(handle);
  }, [template, open]);

  useEffect(() => {
    scene_ref.current?.set_auto_rotate(auto_rotate);
  }, [auto_rotate]);

  useEffect(() => {
    if (!selected_part_id) {
      return;
    }
    scene_ref.current?.select_part(selected_part_id);
    scene_ref.current?.highlight_part(selected_part_id);
  }, [selected_part_id]);

  useEffect(() => {
    scene_ref.current?.set_explode(explode);
  }, [explode]);

  useEffect(() => {
    scene_ref.current?.set_gizmo_mode(gizmo_mode);
  }, [gizmo_mode, selected_part_id, open]);

  useEffect(() => {
    scene_ref.current?.set_snap_step(snap_mm / 1000);
  }, [snap_mm]);

  useEffect(() => {
    scene_ref.current?.set_display_mode(display_mode);
  }, [display_mode, template, open]);

  useEffect(() => {
    scene_ref.current?.set_grid_visible(grid_visible);
  }, [grid_visible, open]);

  /* 3ds Max 风格快捷键：W/E/R 切模式、Q 关闭、Ctrl+Z/Y 撤销重做、Delete 删除、Ctrl+D 复制。 */
  useEffect(() => {
    if (!open) {
      return;
    }
    const on_key = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      const tag = target ? target.tagName : '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
        return;
      }
      const state = use_store.getState();
      const key = event.key.toLowerCase();
      if ((event.ctrlKey || event.metaKey) && key === 'z') {
        event.preventDefault();
        state.undo_workshop();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && (key === 'y' || (key === 'z' && event.shiftKey))) {
        event.preventDefault();
        state.redo_workshop();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && key === 'd') {
        event.preventDefault();
        if (state.workshop_part_id) {
          state.duplicate_workshop_part(state.workshop_part_id);
        }
        return;
      }
      if (key === 'w') {
        state.set_workshop_gizmo('translate');
      } else if (key === 'e') {
        state.set_workshop_gizmo('rotate');
      } else if (key === 'r') {
        state.set_workshop_gizmo('scale');
      } else if (key === 'q') {
        state.set_workshop_gizmo('none');
      } else if (event.key === 'Delete' && state.workshop_part_id) {
        state.remove_workshop_part(state.workshop_part_id);
      }
    };
    window.addEventListener('keydown', on_key);

    return () => window.removeEventListener('keydown', on_key);
  }, [open]);

  if (!open || !template) {
    return null;
  }

  const definition = selected_part ? get_part_definition(selected_part.kind) : null;
  const merged_params =
    selected_part && definition ? { ...definition.defaults, ...selected_part.params } : {};

  /**
   * 渲染参数输入控件（按 schema 决定类型）。
   *
   * @param {string} key 参数名。
   * @returns {JSX.Element} 控件。
   */
  const render_field = (key: string): JSX.Element => {
    const meta = (definition && definition.schema && definition.schema[key]) || { label: key };
    const value = merged_params[key];
    if (meta.kind === 'boolean' || typeof value === 'boolean') {
      return (
        <label key={key} className="field checkbox">
          <input
            type="checkbox"
            checked={Boolean(value)}
            onChange={(event) =>
              update_part(selected_part!.part_id, { [key]: event.target.checked })
            }
          />
          <span>{meta.label}</span>
        </label>
      );
    }
    if (meta.kind === 'color' || (typeof value === 'string' && value.startsWith('#'))) {
      return (
        <label key={key} className="field">
          <span>{meta.label}</span>
          <input
            type="color"
            value={String(value || '#888888')}
            onChange={(event) => update_part(selected_part!.part_id, { [key]: event.target.value })}
          />
        </label>
      );
    }
    if (typeof value === 'number' || meta.min !== undefined) {
      return (
        <label key={key} className="field">
          <span>
            {meta.label}
            {meta.min !== undefined && (
              <em>
                {meta.min} – {meta.max}
              </em>
            )}
          </span>
          <input
            type="number"
            value={Number(value ?? 0)}
            min={meta.min}
            max={meta.max}
            step={meta.step || 0.001}
            onChange={(event) =>
              update_part(selected_part!.part_id, { [key]: Number(event.target.value) })
            }
          />
        </label>
      );
    }
    if (Array.isArray(value)) {
      return (
        <label key={key} className="field">
          <span>{meta.label}</span>
          <input
            type="text"
            value={(value as (number | string)[]).join(', ')}
            onChange={(event) => {
              const parts = event.target.value
                .split(',')
                .map((item) => item.trim())
                .filter((item) => item.length > 0);
              const numeric = parts.every((item) => !Number.isNaN(Number(item)));
              update_part(selected_part!.part_id, {
                [key]: numeric ? parts.map((item) => Number(item)) : parts
              });
            }}
          />
        </label>
      );
    }
    if (key === 'connector') {
      return (
        <label key={key} className="field">
          <span>{meta.label}</span>
          <select
            value={String(value || 'rj45')}
            onChange={(event) => update_part(selected_part!.part_id, { [key]: event.target.value })}
          >
            {[
              'rj45',
              'sfp',
              'sfp_plus',
              'gpon',
              'console_rj45',
              'usb',
              'power_iec_c14',
              'power_dc_barrel',
              'power_dc_terminal',
              'antenna_sma'
            ].map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
      );
    }

    return (
      <label key={key} className="field">
        <span>{meta.label}</span>
        <input
          type="text"
          value={String(value ?? '')}
          onChange={(event) => update_part(selected_part!.part_id, { [key]: event.target.value })}
        />
      </label>
    );
  };

  return (
    <div className="workshop">
      <div className="workshop-head">
        <div>
          <h2>设备工坊</h2>
          <span>
            {template.display_name} · {template.model_id} · 部件 {template.parts.length} 个
          </span>
        </div>
        <div className="workshop-toolbar">
          <span className="toolbar-label">变换</span>
          <button
            type="button"
            className={gizmo_mode === 'translate' ? 'chip on' : 'chip'}
            onClick={() => set_gizmo('translate')}
            title="移动（快捷键 W）"
          >
            移动 W
          </button>
          <button
            type="button"
            className={gizmo_mode === 'rotate' ? 'chip on' : 'chip'}
            onClick={() => set_gizmo('rotate')}
            title="旋转（快捷键 E）"
          >
            旋转 E
          </button>
          <button
            type="button"
            className={gizmo_mode === 'scale' ? 'chip on' : 'chip'}
            onClick={() => set_gizmo('scale')}
            title="缩放（快捷键 R）"
          >
            缩放 R
          </button>
          <button
            type="button"
            className={gizmo_mode === 'none' ? 'chip on' : 'chip'}
            onClick={() => set_gizmo('none')}
            title="关闭 Gizmo（快捷键 Q）"
          >
            关闭 Q
          </button>
          <span className="toolbar-label">吸附</span>
          <select
            className="toolbar-select"
            value={snap_mm}
            onChange={(event) => set_snap(Number(event.target.value))}
          >
            <option value={0}>关闭</option>
            <option value={1}>1 mm</option>
            <option value={5}>5 mm</option>
            <option value={10}>10 mm</option>
            <option value={25.4}>1 英寸</option>
          </select>
          <span className="toolbar-label">显示</span>
          <select
            className="toolbar-select"
            value={display_mode}
            onChange={(event) =>
              set_display(event.target.value as 'shaded' | 'wireframe' | 'edged')
            }
          >
            <option value="shaded">实体</option>
            <option value="edged">实体 + 边线</option>
            <option value="wireframe">线框</option>
          </select>
          <label className="toolbar-check">
            <input
              type="checkbox"
              checked={grid_visible}
              onChange={(event) => set_grid(event.target.checked)}
            />
            <span>网格</span>
          </label>
          <button
            type="button"
            className="chip"
            disabled={history_depth === 0}
            onClick={() => undo_workshop()}
            title="撤销（Ctrl+Z）"
          >
            撤销 {history_depth > 0 ? '(' + history_depth + ')' : ''}
          </button>
          <button
            type="button"
            className="chip"
            disabled={future_depth === 0}
            onClick={() => redo_workshop()}
            title="重做（Ctrl+Y）"
          >
            重做 {future_depth > 0 ? '(' + future_depth + ')' : ''}
          </button>
        </div>
        <div className="workshop-actions">
          <button
            type="button"
            className={auto_rotate ? 'on' : ''}
            onClick={() => set_auto_rotate(!auto_rotate)}
          >
            自动旋转
          </button>
          <label className="slider">
            爆炸
            <input
              type="range"
              min={0}
              max={1}
              step={0.02}
              value={explode}
              onChange={(event) => set_explode(Number(event.target.value))}
            />
          </label>
          <button
            type="button"
            className="on"
            onClick={() => {
              const saved = save_workshop();
              set_saved_hint(saved ? '已保存到设备栏：' + saved.display_name : '保存失败');
              window.setTimeout(() => set_saved_hint(''), 3200);
            }}
          >
            保存到设备栏
          </button>
          <button
            type="button"
            onClick={() => {
              const saved = save_workshop();
              close_workshop();
              if (saved) {
                void create_device(saved.model_id);
              }
            }}
          >
            保存并放入实验台
          </button>
          <button type="button" className="warn" onClick={close_workshop}>
            关闭
          </button>
        </div>
      </div>
      {saved_hint && <div className="workshop-hint">{saved_hint}</div>}
      <div className="workshop-body">
        <div className="workshop-palette">
          <div className="palette-categories">
            {PART_CATEGORY_LABELS.map((item) => (
              <button
                key={item.category}
                type="button"
                className={category === item.category ? 'chip on' : 'chip'}
                onClick={() => set_category(item.category)}
              >
                {item.label}
              </button>
            ))}
          </div>
          <div className="scroll">
            {parts_by_category(category).map((item) => (
              <button
                key={item.kind}
                type="button"
                className="catalog-card"
                onClick={() => add_part(item.kind)}
              >
                <b>{item.label}</b>
                <span>{item.kind}</span>
                <em>{Object.keys(item.defaults).slice(0, 4).join(' · ')}</em>
              </button>
            ))}
          </div>
        </div>
        <div className="workshop-stage" ref={host_ref} />
        <div className="workshop-inspector">
          <div className="section">设备信息</div>
          <label className="field">
            <span>显示名</span>
            <input
              type="text"
              value={template.display_name}
              onChange={(event) => update_meta({ display_name: event.target.value })}
            />
          </label>
          <label className="field">
            <span>型号 ID</span>
            <input
              type="text"
              value={template.model_id}
              onChange={(event) => update_meta({ model_id: event.target.value })}
            />
          </label>
          <label className="field">
            <span>设备类型</span>
            <select
              value={template.device_type}
              onChange={(event) => update_meta({ device_type: event.target.value })}
            >
              {DEVICE_TYPES.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>机箱尺寸（宽/高/深，米）</span>
            <input
              type="text"
              value={[
                template.dimensions.width,
                template.dimensions.height,
                template.dimensions.depth
              ].join(', ')}
              onChange={(event) => {
                const parts = event.target.value
                  .split(',')
                  .map((item) => Number(item.trim()))
                  .filter((item) => !Number.isNaN(item));
                if (parts.length === 3) {
                  update_meta({
                    dimensions: {
                      width: parts[0],
                      height: parts[1],
                      depth: parts[2],
                      u_height: template.dimensions.u_height
                    }
                  });
                }
              }}
            />
          </label>
          <label className="field checkbox">
            <input
              type="checkbox"
              checked={template.rack_mountable}
              onChange={(event) => update_meta({ rack_mountable: event.target.checked })}
            />
            <span>机架式安装</span>
          </label>

          <div className="section">部件装配顺序</div>
          <div className="part-list">
            {template.parts.map((part, index) => (
              <div
                key={part.part_id}
                className={part.part_id === selected_part_id ? 'part-row on' : 'part-row'}
                onClick={() => select_part(part.part_id)}
              >
                <b>
                  {index + 1}. {part.label || part.kind}
                </b>
                <em>{part.kind}</em>
                <div className="part-row-actions">
                  <button
                    type="button"
                    className="mini"
                    onClick={(event) => {
                      event.stopPropagation();
                      move_part(part.part_id, -1);
                    }}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="mini"
                    onClick={(event) => {
                      event.stopPropagation();
                      move_part(part.part_id, 1);
                    }}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    className="mini warn"
                    onClick={(event) => {
                      event.stopPropagation();
                      remove_part(part.part_id);
                    }}
                  >
                    ✕
                  </button>
                </div>
              </div>
            ))}
          </div>

          {selected_part && (
            <>
              <div className="section">
                {'变换：' + (selected_part.label || selected_part.kind)}
              </div>
              {(['position', 'rotation', 'scale'] as const).map((group) => {
                const spec_transform = selected_part.transform || {};
                const zero: [number, number, number] = [0, 0, 0];
                const one: [number, number, number] = [1, 1, 1];
                const defaults = group === 'scale' ? one : zero;
                const values = spec_transform[group] || defaults;
                const divisor = group === 'position' ? 1 / 1000 : 1;
                const unit = group === 'position' ? ' m' : group === 'rotation' ? ' °' : ' ×';
                const labels = { position: '位置（毫米）', rotation: '旋转（度）', scale: '缩放（倍）' };
                const label = labels[group];
                return (
                  <div className="field transform-row" key={group}>
                    <span>{label}</span>
                    <div className="transform-inputs">
                      {[0, 1, 2].map((axis) => (
                        <input
                          key={axis}
                          type="number"
                          step={group === 'scale' ? 0.05 : 1}
                          value={Number(
                            (group === 'rotation'
                              ? (values[axis] * 180) / Math.PI
                              : values[axis] / divisor
                            ).toFixed(3)
                          )}
                          onChange={(event) => {
                            const raw = Number(event.target.value);
                            if (Number.isNaN(raw)) {
                              return;
                            }
                            const next: [number, number, number] = [...values];
                            next[axis] =
                              group === 'rotation' ? (raw * Math.PI) / 180 : raw * divisor;
                            const merged = {
                              position: (spec_transform.position || zero) as [
                                number,
                                number,
                                number
                              ],
                              rotation: (spec_transform.rotation || zero) as [
                                number,
                                number,
                                number
                              ],
                              scale: (spec_transform.scale || one) as [number, number, number]
                            };
                            merged[group] = next;
                            update_transform(selected_part.part_id, merged);
                          }}
                          title={['X', 'Y', 'Z'][axis] + unit}
                        />
                      ))}
                    </div>
                  </div>
                );
              })}
              <div className="transform-actions">
                <button
                  type="button"
                  className="mini"
                  onClick={() => reset_transform(selected_part.part_id)}
                >
                  复位变换
                </button>
                <button
                  type="button"
                  className="mini"
                  onClick={() => duplicate_part(selected_part.part_id)}
                >
                  复制部件
                </button>
                <button
                  type="button"
                  className="mini warn"
                  onClick={() => remove_part(selected_part.part_id)}
                >
                  删除部件
                </button>
              </div>
            </>
          )}

          <div className="section">
            {selected_part
              ? '部件参数：' + (selected_part.label || selected_part.kind)
              : '未选中部件'}
          </div>
          {selected_part && definition && (
            <div className="field-list">
              {Object.keys(merged_params).map((key) => render_field(key))}
            </div>
          )}
          {selected_part && !definition && (
            <div className="note">该部件未注册（kind={selected_part.kind}），装配时会被跳过。</div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * 从设备栏拖拽设备到主场景时的载荷（供 HTML5 拖放读取）。
 *
 * @param {DeviceTemplate} template 设备模板。
 * @returns {string} JSON 载荷。
 */
export function template_drag_payload(template: DeviceTemplate): string {
  return JSON.stringify({ kind: 'device_template', model_id: template.model_id });
}
