/**
 * @File : web/src/cables/cable_labels.ts
 * @Time : 2026-10-07 18:40
 * @Author : Cetrp
 * @Description : 线缆标签：两端贴标（A-01 ↔ B-01 形式）的三维贴纸，以及可打印的线缆清单。
 *
 *               标签编号规则：按线缆在快照里的顺序，起点端为 A-<序号>，终点端为 B-<序号>，
 *               同一根线缆两端序号一致，便于对号入座。
 */

import * as THREE from 'three';

import type { CableRecord } from '../data/types';

/** 仅需要线缆 ID 的最小记录形态（图层记录同样适用）。 */
export interface LabelRecord {
  /** 线缆 ID。 */
  cable_id: string;
}

/** 标签贴图缓存（文本 → 贴图）。 */
const LABEL_TEXTURE_CACHE = new Map<string, THREE.Texture>();

/** 标签尺寸（场景单位）。 */
const LABEL_WIDTH = 0.44;

/** 标签高度（场景单位）。 */
const LABEL_HEIGHT = 0.2;

/** 标签底底色（浅色聚酯标签纸）。 */
const LABEL_BACKGROUND = '#f2f4f0';

/** 标签文字颜色。 */
const LABEL_TEXT_COLOR = '#1b1f24';

/**
 * 生成标签贴图。
 *
 * @param {string} text 标签文本（如 A-01）。
 * @returns {THREE.Texture} 贴图。
 */
export function label_texture(text: string): THREE.Texture {
  const cached = LABEL_TEXTURE_CACHE.get(text);
  if (cached) {
    return cached;
  }
  /* 无 DOM 环境（单元测试/SSR）返回空贴图，几何与逻辑仍可用。 */
  if (typeof document === 'undefined') {
    return new THREE.Texture();
  }
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 116;
  const context = canvas.getContext('2d');
  const result = new THREE.CanvasTexture(canvas);
  result.colorSpace = THREE.SRGBColorSpace;
  if (context) {
    /* 标签纸 + 圆角 + 边框。 */
    context.fillStyle = LABEL_BACKGROUND;
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.strokeStyle = '#9aa4ae';
    context.lineWidth = 8;
    context.strokeRect(4, 4, canvas.width - 8, canvas.height - 8);
    /* 左侧色带（区分 A/B 端）。 */
    context.fillStyle = text.startsWith('A') ? '#2f6fd0' : '#37c98b';
    context.fillRect(12, 12, 26, canvas.height - 24);
    context.fillStyle = LABEL_TEXT_COLOR;
    context.font = 'bold 58px system-ui, sans-serif';
    context.textBaseline = 'middle';
    context.fillText(text, 52, canvas.height / 2 + 2);
  }
  LABEL_TEXTURE_CACHE.set(text, result);

  return result;
}

/**
 * 创建一端的三维标签（始终面向相机的 Sprite，任何角度都能读）。
 *
 * @param {string} text 标签文本。
 * @returns {THREE.Sprite} 标签对象。
 */
export function create_end_label(text: string): THREE.Sprite {
  const material = new THREE.SpriteMaterial({
    map: label_texture(text),
    transparent: true,
    depthTest: true,
    depthWrite: false,
    toneMapped: false
  });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(LABEL_WIDTH, LABEL_HEIGHT, 1);
  sprite.name = 'cable_label';
  sprite.userData.label_text = text;

  return sprite;
}

/**
 * 计算线缆标签编号。
 *
 * @param {CableRecord[]} records 线缆记录（需按展示顺序）。
 * @returns {Map<string, { from: string; to: string }>} cable_id → 两端标签。
 */
export function label_map_for(records: LabelRecord[]): Map<string, { from: string; to: string }> {
  const map = new Map<string, { from: string; to: string }>();
  records.forEach((record, index) => {
    const sequence = String(index + 1).padStart(2, '0');
    map.set(record.cable_id, { from: 'A-' + sequence, to: 'B-' + sequence });
  });

  return map;
}

/**
 * HTML 转义（设备名/端口名可能含用户输入）。
 *
 * @param {string} value 原始文本。
 * @returns {string} 转义后的文本。
 */
export function escape_html(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 生成线缆清单 HTML（可打印）。
 *
 * @param {object} options 选项。
 * @param {CableRecord[]} options.records 线缆记录。
 * @param {Map<string, string>} options.device_names 设备 ID → 显示名。
 * @param {string} options.experiment_name 实验名。
 * @param {string} options.generated_at 生成时间文本。
 * @returns {string} 完整 HTML 文档。
 */
export function build_cable_report_html(options: {
  records: CableRecord[];
  device_names: Map<string, string>;
  experiment_name: string;
  generated_at: string;
  /** 用户自定义标签（优先于默认 A-nn / B-nn）。 */
  custom_labels?: Record<string, { from: string; to: string }>;
}): string {
  const labels = label_map_for(options.records);
  for (const [cable_id, custom] of Object.entries(options.custom_labels || {})) {
    const base = labels.get(cable_id);
    if (!base) {
      continue;
    }
    labels.set(cable_id, {
      from: custom.from ? custom.from : base.from,
      to: custom.to ? custom.to : base.to
    });
  }
  const rows = options.records
    .map((record, index) => {
      const label = labels.get(record.cable_id) || { from: '-', to: '-' };
      const source_name =
        options.device_names.get(record.source.device_id) || record.source.device_id;
      const target_name = record.target
        ? options.device_names.get(record.target.device_id) || record.target.device_id
        : '—（单端）';
      const target_port = record.target ? record.target.port : '—';
      const length = record.length_m === undefined ? '—' : record.length_m + ' m';
      return [
        '<tr>',
        '<td>' + (index + 1) + '</td>',
        '<td class="tag">' + escape_html(label.from) + '</td>',
        '<td class="tag">' + escape_html(label.to) + '</td>',
        '<td>' + escape_html(record.cable_type || '—') + '</td>',
        '<td>' + escape_html(source_name) + ' · ' + escape_html(record.source.port) + '</td>',
        '<td>' + escape_html(target_name) + ' · ' + escape_html(target_port) + '</td>',
        '<td>' + escape_html(length) + '</td>',
        '<td>' + escape_html(record.state || '—') + '</td>',
        '</tr>'
      ].join('');
    })
    .join('');

  return [
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">',
    '<title>线缆清单 · ' + escape_html(options.experiment_name) + '</title>',
    '<style>',
    'body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;margin:24px;color:#101418}',
    'h1{font-size:18px;margin:0 0 4px}',
    '.meta{color:#5a6672;font-size:12px;margin-bottom:14px}',
    'table{border-collapse:collapse;width:100%;font-size:12px}',
    'th,td{border:1px solid #c6ced6;padding:6px 8px;text-align:left;vertical-align:top}',
    'th{background:#eef2f6}',
    '.tag{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-weight:700}',
    'tr:nth-child(even) td{background:#fafcfd}',
    '@media print{body{margin:10mm}h1{font-size:16px}}',
    '</style></head><body>',
    '<h1>线缆清单</h1>',
    '<div class="meta">实验：' + escape_html(options.experiment_name) +
      ' · 共 ' + options.records.length + ' 条 · 生成时间：' +
      escape_html(options.generated_at) + '</div>',
    '<table><thead><tr>',
    '<th>#</th><th>A 端标签</th><th>B 端标签</th><th>线缆类型</th>',
    '<th>起点（设备 · 端口）</th><th>终点（设备 · 端口）</th><th>长度</th><th>状态</th>',
    '</tr></thead><tbody>',
    rows || '<tr><td colspan="8">暂无已连接的线缆</td></tr>',
    '</tbody></table>',
    '<p class="meta">标签对应三维场景中两端的贴纸编号；打印后按标签对号入座即可完成布线。</p>',
    '</body></html>'
  ].join('');
}
