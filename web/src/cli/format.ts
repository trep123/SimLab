/**
 * @File : web/src/cli/format.ts
 * @Time : 2026-10-04 09:50
 * @Author : Cetrp
 * @Description : CLI 回显渲染（模板、表格、配置段），厂商差异全部来自 CLI 档案数据。
 */

import { utils } from '../core/constants';

/** 块占位符集合：单独成行时展开为多行文本。 */
const BLOCK_PLACEHOLDERS = [
  'interface_brief_table',
  'interface_detail',
  'running_config',
  'current_view_config',
  'vlan_table',
  'mac_table',
  'arp_table',
  'route_table',
  'lldp_table',
  'poe_table',
  'counters_table',
  'log_entries',
  'help_text',
  'ping_result'
];

/**
 * 用上下文替换文本中的 {key} 占位符，未知占位符原样保留。
 *
 * @param {string} text 模板文本。
 * @param {object} context 上下文。
 * @returns {string} 渲染结果。
 */
function interpolate(text, context) {
  return String(text).replace(/\{(\w+)\}/g, (match, key) => {
    const value = context ? context[key] : undefined;
    if (value === undefined || value === null) {
      return match;
    }
    if (Array.isArray(value)) {
      return value.join(', ');
    }
    return String(value);
  });
}

/**
 * 处理条件行：`?flag rest` 仅在 flags[flag] 为真时输出 rest。
 *
 * @param {string} line 模板行。
 * @param {object} flags 条件标志。
 * @returns {string|null} 输出行，null 表示省略。
 */
function apply_conditional(line, flags) {
  const match_result = /^\?(\w+)\s+(.*)$/.exec(line);
  if (!match_result) {
    return line;
  }
  const flag_name = match_result[1];
  const content = match_result[2];
  return flags && flags[flag_name] ? content : null;
}

/**
 * 渲染一组输出模板行：块占位符整行展开，标量占位符内联替换。
 *
 * @param {string[]} template_lines 模板行数组。
 * @param {object} context 渲染上下文（值与键名对应）。
 * @param {object} [flags] 条件标志。
 * @returns {string[]} 输出行数组。
 */
function render_output(template_lines, context, flags) {
  const lines = [];
  for (const raw_line of template_lines || []) {
    const conditional = apply_conditional(raw_line, flags);
    if (conditional === null) {
      continue;
    }
    const block_match = /^\{(\w+)\}$/.exec(conditional.trim());
    if (block_match && BLOCK_PLACEHOLDERS.indexOf(block_match[1]) >= 0) {
      const block_value = context ? context[block_match[1]] : undefined;
      if (Array.isArray(block_value)) {
        for (const item of block_value) {
          lines.push(String(item));
        }
      } else if (typeof block_value === 'string' && block_value.length > 0) {
        lines.push(...block_value.split('\n'));
      }
      continue;
    }
    lines.push(interpolate(conditional, context));
  }
  return lines;
}

/**
 * 按厂商列定义渲染表格。
 *
 * @param {object} table_spec 表格定义（columns、header_lines、empty_text）。
 * @param {object[]} rows 行数据。
 * @returns {string[]} 表格文本行。
 */
function render_table(table_spec, rows) {
  if (!table_spec || !Array.isArray(table_spec.columns)) {
    return [];
  }
  const columns = table_spec.columns;
  const empty_text = table_spec.empty_text || '--';
  const lines = [];
  for (const header_line of table_spec.header_lines || []) {
    lines.push(header_line);
  }

  const format_cell = (value, column) => {
    const text = value === undefined || value === null || value === '' ? empty_text : String(value);
    if (column.align === 'right') {
      return utils.pad_start(text, column.width || 0);
    }
    if (column.align === 'center') {
      return utils.pad_center(text, column.width || 0);
    }
    return utils.pad_end(text, column.width || 0);
  };

  const header_cells = columns.map((column) => format_cell(column.header, column));
  lines.push(header_cells.join('').replace(/\s+$/, ''));
  for (const row of rows || []) {
    const cells = columns.map((column) => format_cell(row[column.key], column));
    lines.push(cells.join('').replace(/\s+$/, ''));
  }
  return lines;
}

/**
 * 渲染通用多行文本块。
 *
 * @param {string[]} template_lines 模板行。
 * @param {object} context 上下文。
 * @returns {string[]} 文本行。
 */
function render_block(template_lines, context) {
  return render_output(template_lines, context, {});
}

/**
 * 计算 IP 掩码长度对应的点分掩码。
 *
 * @param {number} prefix_length 掩码长度。
 * @returns {string} 点分掩码。
 */
function prefix_to_mask(prefix_length) {
  const length = utils.clamp(Number(prefix_length) || 0, 0, 32);
  const parts = [];
  for (let i = 0; i < 4; i += 1) {
    const bits = utils.clamp(length - i * 8, 0, 8);
    parts.push(bits === 0 ? 0 : (0xff << (8 - bits)) & 0xff);
  }
  return parts.join('.');
}

/**
 * 依据 config_render 模板生成运行配置。
 *
 * @param {object} config_render 配置模板。
 * @param {object} phrases 厂商短语。
 * @param {object} device 设备运行时。
 * @param {object} [options] 选项：{ view: 'full'|'interface'|'vlan', port, vlan_id }。
 * @returns {string[]} 配置文本行。
 */
function render_config(config_render, phrases, device, options) {
  const settings = options || {};
  const view = settings.view || 'full';
  const phrase_table = phrases || {};
  const lines = [];

  const render_phrase = (key, context) => {
    const template = phrase_table[key];
    if (!template) {
      return null;
    }
    return interpolate(template, context);
  };

  if (view === 'full') {
    for (const line of config_render.header || []) {
      lines.push(interpolate(line, device.template_context()));
    }
    for (const vlan of device.vlans.values()) {
      const vlan_context = {
        vlan: vlan.vlan_id,
        vlan_name: vlan.name,
        vlan_description: vlan.description || vlan.name
      };
      for (const line of config_render.vlan || []) {
        lines.push(interpolate(line, vlan_context));
      }
      const vlan_interface = device.vlan_interfaces.get(vlan.vlan_id);
      if (
        vlan_interface &&
        vlan_interface.ip_address &&
        Array.isArray(config_render.vlan_interface)
      ) {
        const interface_context = {
          vlan: vlan.vlan_id,
          ip: vlan_interface.ip_address,
          mask: vlan_interface.mask || prefix_to_mask(vlan_interface.prefix_length || 24),
          prefix_length: vlan_interface.prefix_length || 24
        };
        for (const line of config_render.vlan_interface) {
          lines.push(interpolate(line, interface_context));
        }
      }
    }
  }

  const target_ports = view === 'interface' && settings.port ? [settings.port] : device.ports;
  if (view !== 'vlan') {
    for (const port of target_ports) {
      const port_context = {
        interface: port.name,
        interface_short: port.short_name,
        description: port.description || '',
        vlan: port.vlan,
        vlans: port.trunk_vlans.join(' '),
        speed: port.speed,
        duplex: port.duplex,
        ip: port.ip_address || '',
        mask: port.ip_mask || ''
      };
      const flags = {
        description: Boolean(port.description),
        trunk: port.mode === 'trunk' && port.trunk_vlans.length > 0,
        ip: Boolean(port.ip_address),
        poe: Boolean(port.poe_enabled)
      };
      const mode_map = phrase_table.mode || {};
      const state_context = Object.assign({}, port_context, {
        mode_phrase: mode_map[port.mode] || '',
        vlan_phrase:
          port.mode === 'trunk'
            ? render_phrase('trunk_vlans', port_context)
            : render_phrase('access_vlan', port_context),
        trunk_phrase: render_phrase('trunk_vlans', port_context),
        ip_phrase: render_phrase('ip_address', port_context),
        poe_phrase: render_phrase('poe_on', port_context),
        shutdown_phrase: port.admin_up
          ? phrase_table.no_shutdown || 'undo shutdown'
          : phrase_table.shutdown || 'shutdown'
      });
      for (const line of config_render.interface || []) {
        const conditional = apply_conditional(line, flags);
        if (conditional === null) {
          continue;
        }
        /* 保留模板缩进：厂商配置子行以空格缩进，trim 会破坏真实回显格式。 */
        const rendered = interpolate(conditional, state_context);
        if (rendered.trim().length > 0) {
          lines.push(rendered);
        }
      }
    }
  }

  if (view === 'vlan' && settings.vlan_id) {
    const vlan = device.vlans.get(settings.vlan_id);
    if (vlan) {
      const vlan_context = {
        vlan: vlan.vlan_id,
        vlan_name: vlan.name,
        vlan_description: vlan.description || vlan.name
      };
      for (const line of config_render.vlan || []) {
        lines.push(interpolate(line, vlan_context));
      }
    }
  }

  if (view === 'full') {
    for (const line of config_render.footer || []) {
      lines.push(interpolate(line, device.template_context()));
    }
  }
  return lines;
}

export const CliFormat = {
  BLOCK_PLACEHOLDERS: BLOCK_PLACEHOLDERS,
  interpolate: interpolate,
  apply_conditional: apply_conditional,
  render_output: render_output,
  render_table: render_table,
  render_block: render_block,
  render_config: render_config,
  prefix_to_mask: prefix_to_mask
};
