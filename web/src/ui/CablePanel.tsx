/**
 * @File : web/src/ui/CablePanel.tsx
 * @Time : 2026-10-07 09:10
 * @Author : Cetrp
 * @Description : 线缆栏：按类别列出网线/光纤/电源线/Console 线，支持拖拽到场景端口或"选中后点端口"两种接线方式。
 */

import { useEffect, useMemo, useState } from 'react';

import type { JSX } from 'react';

import { CABLE_CATALOG } from '../cables/catalog';
import { cable_thumbnail_by_id } from '../devices/thumbnailer';
import { build_cable_report_html } from '../cables/cable_labels';
import { use_store } from '../core/store';

import type { CableKind } from '../cables/catalog';

/** 类别中文名。 */
const CATEGORY_LABELS: Record<string, string> = {
  copper: '铜缆（网线）',
  fiber: '光缆（光纤跳线）',
  power: '电源与接地',
  console: '调试线'
};

/**
 * 打印线缆清单（新窗口 + 系统打印对话框；离线单文件同样可用）。
 *
 * @returns {void}
 */
export function print_cable_list(): void {
  const state = use_store.getState();
  const runtime = state.runtime;
  const records = runtime ? runtime.cables_snapshot() : [];
  const device_names = new Map<string, string>();
  if (runtime) {
    for (const device of runtime.list_devices()) {
      device_names.set(device.device_id, device.hostname || device.model_id);
    }
  }
  const experiment_name = state.runtime ? '本地模拟实验' : '未连接实验';
  const generated_at = new Date().toLocaleString('zh-CN');
  const html = build_cable_report_html({
    records: records,
    device_names: device_names,
    experiment_name: experiment_name,
    generated_at: generated_at,
    custom_labels: state.cable_labels
  });
  const report_window = window.open('', '_blank', 'width=980,height=720');
  if (!report_window) {
    console.warn('打印清单被浏览器拦截，请允许弹出窗口后重试');
    return;
  }
  report_window.document.open();
  report_window.document.write(html);
  report_window.document.close();
  report_window.focus();
  window.setTimeout(() => report_window.print(), 320);
}

/**
 * 线缆 3D 缩略图（连接器 + 一小段线材）。
 *
 * @param {object} props 属性。
 * @param {string} props.cable_id 线缆目录 ID。
 * @param {string} props.color 线缆颜色（占位块用）。
 * @returns {JSX.Element} 组件。
 */
function CableThumb({ cable_id, color }: { cable_id: string; color: string }): JSX.Element {
  const [src, set_src] = useState('');
  useEffect(() => {
    let cancelled = false;
    let attempts = 0;
    let handle = 0;
    /* 首次可能拿不到 WebGL 上下文：失败时下一帧重试，最多 6 次。 */
    const attempt = (): void => {
      if (cancelled) {
        return;
      }
      const url = cable_thumbnail_by_id(cable_id);
      if (url || attempts >= 6) {
        set_src(url);
        return;
      }
      attempts += 1;
      handle = window.setTimeout(attempt, 220);
    };
    handle = window.setTimeout(attempt, 0);

    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [cable_id]);

  return src ? (
    <img className="thumb cable-thumb" src={src} alt={cable_id} draggable={false} />
  ) : (
    <span className="cable-color" style={{ background: color }} />
  );
}

/**
 * 线缆栏。
 *
 * @returns {JSX.Element} 组件。
 */
export function CablePanel(): JSX.Element {
  const pending_cable_kind = use_store((state) => state.pending_cable_kind);
  const link_source = use_store((state) => state.link_source);
  const cancel_link = use_store((state) => state.cancel_link);
  const set_pending = use_store((state) => state.set_pending_cable_kind);
  const [collapsed, set_collapsed] = useState(false);

  /* 按类别分组，保持目录里的顺序。 */
  const groups = useMemo(() => {
    const map = new Map<string, CableKind[]>();
    for (const kind of CABLE_CATALOG) {
      const bucket = map.get(kind.category) || [];
      bucket.push(kind);
      map.set(kind.category, bucket);
    }

    return [...map.entries()];
  }, []);

  return (
    <div className="panel cable-panel">
      <div className="panel-head">
        <h2>线缆栏</h2>
        <button type="button" className="mini" onClick={() => print_cable_list()} title="打印线缆清单">
          打印清单
        </button>
        <button type="button" className="mini" onClick={() => set_collapsed(!collapsed)}>
          {collapsed ? '展开' : '收起'}
        </button>
      </div>
      {!collapsed && (
        <div className="scroll">
          {link_source && (
            <div className="link-banner">
              已选起点 {link_source.device_id} / {link_source.port}
              <button type="button" onClick={cancel_link}>
                取消
              </button>
            </div>
          )}
          <div className="hint-line">
            用法：把线缆拖到设备接口，或先点线缆再点两个端口（也可点端口开始连线后点目标端口）。
          </div>
          {groups.map(([category, kinds]) => (
            <div key={category}>
              <div className="section">{CATEGORY_LABELS[category] || category}</div>
              {kinds.map((kind) => (
                <div
                  key={kind.cable_id}
                  className={
                    pending_cable_kind === kind.cable_id
                      ? 'cable-card on with-thumb'
                      : 'cable-card with-thumb'
                  }
                  draggable
                  onDragStart={(event) => {
                    event.dataTransfer.setData('application/x-simlab-kind', 'cable_kind');
                    event.dataTransfer.setData('application/x-simlab-value', kind.cable_id);
                    event.dataTransfer.effectAllowed = 'copy';
                    set_pending(kind.cable_id);
                  }}
                  onClick={() =>
                    set_pending(pending_cable_kind === kind.cable_id ? null : kind.cable_id)
                  }
                >
                  <CableThumb cable_id={kind.cable_id} color={kind.color} />
                  <div className="card-text">
                    <b>{kind.label}</b>
                    <em>{kind.speed_text}</em>
                  </div>
                  <div className="tip">
                    <b>{kind.label}</b>
                    <em>两端连接器：{kind.connectors.join(' → ')}</em>
                    <em>速率：{kind.speed_text}</em>
                    <em>
                      最大长度：
                      {kind.max_length_m >= 1000
                        ? kind.max_length_m / 1000 + ' km'
                        : kind.max_length_m + ' m'}
                    </em>
                    <em>{kind.description}</em>
                    <em>拖到设备接口即可连线</em>
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
