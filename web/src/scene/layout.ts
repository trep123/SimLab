/**
 * @File : web/src/scene/layout.ts
 * @Time : 2026-10-04 12:10
 * @Author : Cetrp
 * @Description : 设备面板布局计算：把 Manifest 的 port_layout 转换为三维坐标与面板绘制参数。
 */

import { utils } from '../core/constants';
import { expand_ports } from '../data/spec_loader';

/** 机架式设备在场景中的显示宽度（场景单位）。 */
const RACK_DISPLAY_WIDTH = 8.84;

/** 桌面式设备在场景中的显示宽度（场景单位）。 */
const DESKTOP_DISPLAY_WIDTH = 3.6;

/** 机架式判定阈值（米）。 */
const RACK_WIDTH_THRESHOLD = 3.0;

/** 端口最小与最大间距（场景单位）。 */
const MIN_PORT_PITCH = 0.3;
const MAX_PORT_PITCH = 0.58;

/**
 * 计算设备显示尺寸与端口坐标。
 *
 * Manifest 中的机箱尺寸单位为米；场景按“机架式 / 桌面式”分别归一化到固定显示宽度。
 *
 * @param {object} manifest 设备 Manifest。
 * @returns {object} 布局结果。
 */
function compute_layout(manifest) {
  const chassis = (manifest.visual && manifest.visual.chassis) || {};
  const real_width = chassis.width || 4.42;
  const real_height = chassis.height || 0.44;
  const real_depth = chassis.depth || 2.2;
  const is_rack = real_width >= RACK_WIDTH_THRESHOLD;
  /* 桌面型设备（AP / 笔记本 / 手机）按“最大外形尺寸”归一化：
       否则手机这类窄长机箱会被宽度归一化放大成巨板。 */
  const desktop_reference = Math.max(real_width, real_depth, real_height * 2.2);
  const scale = is_rack
    ? RACK_DISPLAY_WIDTH / real_width
    : DESKTOP_DISPLAY_WIDTH / desktop_reference;
  const width = real_width * scale;
  const height = real_height * scale;
  const depth = real_depth * scale;

  const layout_groups = (manifest.visual && manifest.visual.port_layout) || [];
  const expanded_ports = expand_ports(manifest);

  /* 左侧保留区：电源键 / 系统 LED / Console（机架式设备）。 */
  const left_reserved = is_rack ? 1.55 : 0.55;
  const right_margin = is_rack ? 0.35 : 0.3;
  const available_width = width - left_reserved - right_margin;

  const rows_total = layout_groups.reduce((sum, group) => sum + (group.rows || []).length, 0) || 1;
  const columns_total =
    layout_groups.reduce(
      (sum, group) =>
        sum + (group.rows || []).reduce((inner, row) => Math.max(inner, row.count || 0), 0),
      0
    ) || 1;
  const pitch = utils.clamp(available_width / columns_total, MIN_PORT_PITCH, MAX_PORT_PITCH);

  const row_pitch = rows_total > 1 ? Math.min(height * 0.62, 0.52) : 0;
  const row_y = (row_index) => ((rows_total - 1) / 2 - row_index) * row_pitch;

  const ports = [];
  const groups = [];
  let cursor_x = -width / 2 + left_reserved;
  let global_row_index = 0;

  for (const group of layout_groups) {
    const group_rows = group.rows || [];
    const group_columns = group_rows.reduce((inner, row) => Math.max(inner, row.count || 0), 0);
    const group_width = group_columns * pitch;
    const group_ports = [];
    group_rows.forEach((row, row_index) => {
      const y = row_y(global_row_index + row_index);
      const row_ports = [];
      for (let offset = 0; offset < (row.count || 0); offset += 1) {
        /* 端口允许从 0 开始（如 PC eth0、路由器 GE0/0/0）；仅缺省时从 1 开始。 */
        const index = (row.start_index ?? 1) + offset;
        const short_name = ((group.naming || {}).short_prefix || '') + index;
        const port_definition = expanded_ports.find((item) => item.short_name === short_name);
        if (!port_definition) {
          continue;
        }
        const x =
          cursor_x +
          group_width / 2 -
          (group_columns * pitch) / 2 +
          (offset + 0.5) * pitch +
          ((group_columns - (row.count || 0)) * pitch) / 2;
        const entry = {
          port: port_definition,
          x: x,
          y: y,
          group_id: group.group_id,
          kind: group.kind
        };
        ports.push(entry);
        row_ports.push(entry);
      }
      group_ports.push({ y: y, ports: row_ports });
    });
    groups.push({
      group: group,
      x_start: cursor_x,
      x_end: cursor_x + group_width,
      width: group_width,
      columns: group_columns,
      rows: group_ports
    });
    cursor_x += group_width + pitch * 0.45;
    global_row_index += group_rows.length;
  }

  return {
    is_rack: is_rack,
    scale: scale,
    width: width,
    height: height,
    depth: depth,
    front_z: depth / 2,
    pitch: pitch,
    row_pitch: row_pitch,
    left_reserved: left_reserved,
    available_width: available_width,
    ports: ports,
    groups: groups,
    row_count: rows_total,
    column_count: columns_total,
    /* 面板绘制（贴图）使用的归一化坐标转换。 */
    to_panel_x: function (x) {
      return (x + width / 2) / width;
    },
    to_panel_y: function (y) {
      return (height / 2 - y) / height;
    }
  };
}

export const DeviceLayout = {
  compute_layout: compute_layout,
  RACK_DISPLAY_WIDTH: RACK_DISPLAY_WIDTH,
  DESKTOP_DISPLAY_WIDTH: DESKTOP_DISPLAY_WIDTH
};
