/**
 * @File : web/src/cli/handlers.ts
 * @Time : 2026-10-04 10:05
 * @Author : Cetrp
 * @Description : CLI 处理器集合（契约 §4.3），厂商差异通过 CLI 档案模板表达，处理器本身与厂商无关。
 */

import { utils, DEVICE_STATE, EVENT_TYPE, PORT_STATE, SPEED_TEXT } from '../core/constants';
import { CliFormat } from './format';

/** 表示“关闭 PoE”的参数取值（各厂商措辞不同）。 */
const DISABLED_POE_STATES = ['disable', 'disabled', 'off', 'never', 'no'];

/** 无链路时 ping 的超时提示补充行（厂商可通过 text_templates 覆盖）。 */
const DEFAULT_PING_TIMEOUT = 'Request time out';

/**
 * 解析目标端口：优先命令行参数，其次当前视图上下文。
 *
 * @param {object} context 处理上下文。
 * @param {boolean} [required] 是否必须存在。
 * @returns {object|null} 端口或 null。
 */
function resolve_port(context, required) {
  const explicit = context.args ? context.args.interface : null;
  if (explicit) {
    return context.device.find_port(explicit);
  }
  if (context.session.context && context.session.context.port) {
    return context.session.context.port;
  }
  return required ? null : null;
}

/**
 * 厂商提示语读取，缺失时回退到英文默认值。
 *
 * @param {object} context 处理上下文。
 * @param {string} key 消息键。
 * @param {string} fallback 默认文本。
 * @returns {string} 提示语。
 */
function message_of(context, key, fallback) {
  const messages = (context.vendor && context.vendor.messages) || {};
  return messages[key] !== undefined ? messages[key] : fallback;
}

/**
 * 构造错误结果。
 *
 * @param {string} text 错误文本。
 * @returns {object} 处理结果。
 */
function failure(text) {
  return { success: false, lines: [text] };
}

/**
 * 记录端口配置变更事件。
 *
 * @param {object} context 处理上下文。
 * @param {object} port 端口。
 * @param {string} field 字段名。
 * @param {*} old_value 旧值。
 * @param {*} new_value 新值。
 * @returns {void}
 */
function emit_port_config(context, port, field, old_value, new_value) {
  context.emit(EVENT_TYPE.PORT_CONFIG_CHANGED, {
    device_id: context.device.device_id,
    port: port.short_name,
    field: field,
    from: old_value,
    to: new_value
  });
}

/** 处理器实现表。 */
const HANDLERS = {
  /**
   * 查看系统版本。
   *
   * @param {object} context 处理上下文。
   * @returns {object} 处理结果。
   */
  show_version: function (context) {
    const device = context.device;
    device.refresh_mac_table();
    return {
      blocks: {},
      context: {
        bootrom_version: '1.0.0',
        pcb_version: 'VER.B',
        board_type: device.manifest.board_type || 'MainBoard',
        mpu_type: device.product_name,
        slot_count: 1
      }
    };
  },

  /**
   * 端口概览表。
   *
   * @param {object} context 处理上下文。
   * @returns {object} 处理结果。
   */
  show_interface_brief: function (context) {
    const device = context.device;
    device.refresh_mac_table();
    let rows = device.port_rows();
    const port =
      context.args && context.args.interface ? device.find_port(context.args.interface) : null;
    if (port) {
      rows = rows.filter((row) => row.short_name === port.short_name);
    }
    const table_spec = (context.profile.tables || {}).interface_brief_table;
    return { blocks: { interface_brief_table: CliFormat.render_table(table_spec, rows) } };
  },

  /**
   * 单端口详情。
   *
   * @param {object} context 处理上下文。
   * @returns {object} 处理结果。
   */
  show_interface_detail: function (context) {
    const port = resolve_port(context, true);
    if (!port) {
      return failure(message_of(context, 'wrong_parameter', 'Error: Wrong parameter found.'));
    }
    const device = context.device;
    const text = device.port_text(port);
    device.refresh_mac_table();
    const rows = [
      { key_text: 'Interface', value_text: port.name },
      {
        key_text: 'Current state',
        value_text: (text.phy_text + ' / ' + text.protocol_text).trim()
      },
      { key_text: 'Description', value_text: port.description || '--' },
      { key_text: 'Link speed', value_text: text.speed_text },
      { key_text: 'Duplex', value_text: text.duplex_text },
      { key_text: 'Port mode', value_text: port.mode },
      { key_text: 'PVID', value_text: String(port.vlan) },
      { key_text: 'Trunk VLANs', value_text: port.trunk_vlans.join(' ') || '--' },
      { key_text: 'PoE', value_text: text.poe_text },
      { key_text: 'PoE power', value_text: port.poe_watts.toFixed(1) + ' W' },
      { key_text: 'MAC learning', value_text: String(port.mac_count) },
      { key_text: 'Input packets', value_text: String(port.rx_pkts) },
      { key_text: 'Output packets', value_text: String(port.tx_pkts) },
      { key_text: 'CRC errors', value_text: String(port.crc_errors) },
      {
        key_text: 'Last change',
        value_text: utils.format_datetime(new Date(port.last_change_at))
      }
    ];
    const table_spec = (context.profile.tables || {}).interface_detail;
    return { blocks: { interface_detail: CliFormat.render_table(table_spec, rows) } };
  },

  /**
   * 查看当前生效配置。
   *
   * @param {object} context 处理上下文。
   * @returns {object} 处理结果。
   */
  show_running_config: function (context) {
    const device = context.device;
    const config_render = context.profile.config_render || {};
    const phrases = context.profile.phrases || {};
    return {
      blocks: {
        running_config: CliFormat.render_config(config_render, phrases, device, { view: 'full' })
      }
    };
  },

  /**
   * 查看当前视图配置。
   *
   * @param {object} context 处理上下文。
   * @returns {object} 处理结果。
   */
  show_current_view: function (context) {
    const device = context.device;
    const session = context.session;
    const config_render = context.profile.config_render || {};
    const phrases = context.profile.phrases || {};
    let options: Record<string, unknown> = { view: 'full' };
    if (session.mode === 'interface' && session.context.port) {
      options = { view: 'interface', port: session.context.port };
    } else if (session.mode === 'vlan' && session.context.vlan_id) {
      options = { view: 'vlan', vlan_id: session.context.vlan_id };
    }
    return {
      blocks: {
        current_view_config: CliFormat.render_config(config_render, phrases, device, options)
      }
    };
  },

  /**
   * VLAN 表。
   *
   * @param {object} context 处理上下文。
   * @returns {object} 处理结果。
   */
  show_vlan: function (context) {
    const table_spec = (context.profile.tables || {}).vlan_table;
    return {
      blocks: { vlan_table: CliFormat.render_table(table_spec, context.device.vlan_rows()) }
    };
  },

  /**
   * MAC 地址表。
   *
   * @param {object} context 处理上下文。
   * @returns {object} 处理结果。
   */
  show_mac_table: function (context) {
    const table_spec = (context.profile.tables || {}).mac_table;
    return {
      blocks: { mac_table: CliFormat.render_table(table_spec, context.device.mac_rows()) }
    };
  },

  /**
   * ARP 表。
   *
   * @param {object} context 处理上下文。
   * @returns {object} 处理结果。
   */
  show_arp: function (context) {
    const table_spec = (context.profile.tables || {}).arp_table;
    return {
      blocks: { arp_table: CliFormat.render_table(table_spec, context.device.arp_rows()) }
    };
  },

  /**
   * 路由表。
   *
   * @param {object} context 处理上下文。
   * @returns {object} 处理结果。
   */
  show_route: function (context) {
    const table_spec = (context.profile.tables || {}).route_table;
    return {
      blocks: { route_table: CliFormat.render_table(table_spec, context.device.route_rows()) }
    };
  },

  /**
   * LLDP 邻居表。
   *
   * @param {object} context 处理上下文。
   * @returns {object} 处理结果。
   */
  show_lldp_neighbor: function (context) {
    const table_spec = (context.profile.tables || {}).lldp_table;
    return {
      blocks: { lldp_table: CliFormat.render_table(table_spec, context.device.lldp_rows()) }
    };
  },

  /**
   * PoE 状态表。
   *
   * @param {object} context 处理上下文。
   * @returns {object} 处理结果。
   */
  show_poe: function (context) {
    const table_spec = (context.profile.tables || {}).poe_table;
    return {
      blocks: { poe_table: CliFormat.render_table(table_spec, context.device.poe_rows()) }
    };
  },

  /**
   * 端口计数表。
   *
   * @param {object} context 处理上下文。
   * @returns {object} 处理结果。
   */
  show_counters: function (context) {
    const device = context.device;
    let rows = device.counter_rows();
    const port =
      context.args && context.args.interface ? device.find_port(context.args.interface) : null;
    if (port) {
      rows = rows.filter((row) => row.short_name === port.short_name);
    }
    const table_spec = (context.profile.tables || {}).counters_table;
    return { blocks: { counters_table: CliFormat.render_table(table_spec, rows) } };
  },

  /**
   * 日志缓冲。
   *
   * @param {object} context 处理上下文。
   * @returns {object} 处理结果。
   */
  show_log: function (context) {
    const entries = context.device.log_buffer.slice(-40).map((record) => record.text);
    return { blocks: { log_entries: entries } };
  },

  /**
   * 温度 / 风扇 / 电源状态。
   *
   * @param {object} context 处理上下文。
   * @returns {object} 处理结果。
   */
  show_environment: function (context) {
    const environment = context.device.environment;
    return {
      context: {
        temperature: environment.temperature.toFixed(1),
        fan_status: environment.fan_status,
        power_status: environment.power_status
      }
    };
  },

  /**
   * 进入配置模式。
   *
   * @param {object} context 处理上下文。
   * @returns {object} 处理结果。
   */
  enter_config: function (context) {
    context.device.push_log('Enter system view');
    return { lines: [], transition: { mode: 'config', clear_port: true } };
  },

  /**
   * 退回上一级视图。
   *
   * @param {object} context 处理上下文。
   * @returns {object} 处理结果。
   */
  exit_mode: function (context) {
    const session = context.session;
    const previous_mode = session.pop_mode();
    if (previous_mode) {
      return {
        lines: [],
        transition: {
          mode: previous_mode,
          clear_port: true,
          skip_push: true,
          authoritative: true
        }
      };
    }
    if (session.mode === 'privileged') {
      return { lines: [], transition: { mode: 'user', skip_push: true, authoritative: true } };
    }
    return {
      lines: [message_of(context, 'logout_hint', 'Please use the return command to log out.')]
    };
  },

  /**
   * 直接回到根视图。
   *
   * @param {object} context 处理上下文。
   * @returns {object} 处理结果。
   */
  return_root: function (context) {
    return {
      lines: [],
      transition: { mode: context.session.root_mode || 'user', clear_port: true }
    };
  },

  /**
   * 修改设备名。
   *
   * @param {object} context 处理上下文。
   * @returns {object} 处理结果。
   */
  set_hostname: function (context) {
    const device = context.device;
    const old_name = device.hostname;
    device.hostname = context.args.hostname;
    device.config_dirty = true;
    device.push_log('Hostname changed from ' + old_name + ' to ' + device.hostname);
    context.emit(EVENT_TYPE.PORT_CONFIG_CHANGED, {
      device_id: device.device_id,
      port: null,
      field: 'hostname',
      from: old_name,
      to: device.hostname
    });
    return { lines: ['Info: The host name is changed successfully.'] };
  },

  /**
   * 进入接口视图。
   *
   * @param {object} context 处理上下文。
   * @returns {object} 处理结果。
   */
  enter_interface: function (context) {
    const port = context.device.find_port(context.args.interface);
    if (!port) {
      return failure(
        message_of(context, 'interface_not_found', 'Error: The interface does not exist.')
      );
    }
    return { lines: [], transition: { mode: 'interface', port: port } };
  },

  /**
   * 进入 VLAN 视图。
   *
   * @param {object} context 处理上下文。
   * @returns {object} 处理结果。
   */
  enter_vlan: function (context) {
    const device = context.device;
    const vlan_id = Number(context.args.vlan);
    if (!device.vlans.has(vlan_id)) {
      device.vlans.set(vlan_id, {
        vlan_id: vlan_id,
        name: 'VLAN ' + String(vlan_id).padStart(3, '0'),
        description: '',
        ports: []
      });
      device.config_dirty = true;
    }
    return { lines: [], transition: { mode: 'vlan', vlan_id: vlan_id } };
  },

  /**
   * 关闭端口。
   *
   * @param {object} context 处理上下文。
   * @returns {object} 处理结果。
   */
  set_shutdown: function (context) {
    const port = resolve_port(context, true);
    if (!port) {
      return failure(message_of(context, 'wrong_parameter', 'Error: Wrong parameter found.'));
    }
    port.admin_up = false;
    port.state = PORT_STATE.DISABLED;
    port.last_change_at = Date.now();
    context.device.config_dirty = true;
    context.device.push_log('Interface ' + port.name + ' is administratively down');
    context.emit(EVENT_TYPE.PORT_ADMIN_CHANGED, {
      device_id: context.device.device_id,
      port: port.short_name,
      admin_up: false
    });
    return { lines: [] };
  },

  /**
   * 打开端口。
   *
   * @param {object} context 处理上下文。
   * @returns {object} 处理结果。
   */
  set_no_shutdown: function (context) {
    const port = resolve_port(context, true);
    if (!port) {
      return failure(message_of(context, 'wrong_parameter', 'Error: Wrong parameter found.'));
    }
    port.admin_up = true;
    port.last_change_at = Date.now();
    context.device.config_dirty = true;
    context.device.push_log('Interface ' + port.name + ' is administratively up');
    context.emit(EVENT_TYPE.PORT_ADMIN_CHANGED, {
      device_id: context.device.device_id,
      port: port.short_name,
      admin_up: true
    });
    return { lines: [] };
  },

  /**
   * 设置端口速率。
   *
   * @param {object} context 处理上下文。
   * @returns {object} 处理结果。
   */
  set_speed: function (context) {
    const port = resolve_port(context, true);
    if (!port) {
      return failure(message_of(context, 'wrong_parameter', 'Error: Wrong parameter found.'));
    }
    if (context.device.is_optical(port) && context.args.speed !== 'auto') {
      return failure(message_of(context, 'wrong_parameter', 'Error: Wrong parameter found.'));
    }
    const old_speed = port.speed_mode;
    port.speed_mode = context.args.speed;
    if (context.args.speed === 'auto') {
      port.speed = context.device.is_optical(port) ? '10G' : SPEED_TEXT[port.speed_bps] || '1000M';
    } else if (context.args.speed === '1000') {
      port.speed = '1000M';
    } else if (context.args.speed === '100') {
      port.speed = '100M';
    } else if (context.args.speed === '10') {
      port.speed = '10M';
    }
    port.last_change_at = Date.now();
    context.device.config_dirty = true;
    emit_port_config(context, port, 'speed', old_speed, port.speed_mode);
    return { lines: [] };
  },

  /**
   * 设置双工模式。
   *
   * @param {object} context 处理上下文。
   * @returns {object} 处理结果。
   */
  set_duplex: function (context) {
    const port = resolve_port(context, true);
    if (!port) {
      return failure(message_of(context, 'wrong_parameter', 'Error: Wrong parameter found.'));
    }
    const old_duplex = port.duplex;
    port.duplex = context.args.duplex;
    context.device.config_dirty = true;
    emit_port_config(context, port, 'duplex', old_duplex, port.duplex);
    return { lines: [] };
  },

  /**
   * 设置端口链路类型。
   *
   * @param {object} context 处理上下文。
   * @returns {object} 处理结果。
   */
  set_port_mode: function (context) {
    const port = resolve_port(context, true);
    if (!port) {
      return failure(message_of(context, 'wrong_parameter', 'Error: Wrong parameter found.'));
    }
    const old_mode = port.mode;
    port.mode = String(context.args.mode).toLowerCase();
    if (port.mode === 'trunk' && port.trunk_vlans.length === 0) {
      port.trunk_vlans = [port.vlan];
    }
    context.device.config_dirty = true;
    emit_port_config(context, port, 'mode', old_mode, port.mode);
    return { lines: [] };
  },

  /**
   * 设置端口 VLAN。
   *
   * @param {object} context 处理上下文。
   * @returns {object} 处理结果。
   */
  set_port_vlan: function (context) {
    const port = resolve_port(context, true);
    if (!port) {
      return failure(message_of(context, 'wrong_parameter', 'Error: Wrong parameter found.'));
    }
    const device = context.device;
    const vlan_id = Number(context.args.vlan);
    const old_vlan = port.vlan;
    port.vlan = vlan_id;
    if (!device.vlans.has(vlan_id)) {
      device.vlans.set(vlan_id, {
        vlan_id: vlan_id,
        name: 'VLAN ' + String(vlan_id).padStart(3, '0'),
        description: '',
        ports: []
      });
    }
    if (port.mode === 'trunk') {
      if (port.trunk_vlans.indexOf(vlan_id) < 0) {
        port.trunk_vlans.push(vlan_id);
      }
    } else {
      port.trunk_vlans = [];
    }
    device.config_dirty = true;
    emit_port_config(context, port, 'vlan', old_vlan, vlan_id);
    return { lines: [] };
  },

  /**
   * 设置端口描述。
   *
   * @param {object} context 处理上下文。
   * @returns {object} 处理结果。
   */
  set_port_description: function (context) {
    const port = resolve_port(context, true);
    if (!port) {
      return failure(message_of(context, 'wrong_parameter', 'Error: Wrong parameter found.'));
    }
    const old_description = port.description;
    port.description = context.args.description;
    context.device.config_dirty = true;
    emit_port_config(context, port, 'description', old_description, port.description);
    return { lines: [] };
  },

  /**
   * 开关端口 PoE。
   *
   * @param {object} context 处理上下文。
   * @returns {object} 处理结果。
   */
  set_port_poe: function (context) {
    const port = resolve_port(context, true);
    if (!port) {
      return failure(message_of(context, 'wrong_parameter', 'Error: Wrong parameter found.'));
    }
    if (!port.poe_capable) {
      return failure(
        message_of(context, 'wrong_parameter', 'Error: The interface does not support PoE.')
      );
    }
    /* 厂商命令风格不同：华为/H3C 用 `undo poe enable`，思科用 `power inline never`，
         state 参数未必出现在语法里，因此需要结合命令字面量推断方向。 */
    const syntax_text = String((context.command && context.command.syntax) || '')
      .trim()
      .toLowerCase();
    const is_negative_command = /^(undo|no)\s/.test(syntax_text);
    const state_value =
      context.args.state === undefined ? null : String(context.args.state).toLowerCase();
    const enable =
      state_value === null ? !is_negative_command : DISABLED_POE_STATES.indexOf(state_value) < 0;
    port.poe_enabled = enable;
    port.poe_watts = enable
      ? port.poe_watts > 0
        ? port.poe_watts
        : Number(utils.rnd(3.2, 15.4).toFixed(1))
      : 0;
    context.device.config_dirty = true;
    emit_port_config(context, port, 'poe', !enable, enable);
    const lines = enable
      ? [message_of(context, 'poe_enabled', 'Info: PoE is enabled on the interface.')]
      : [];
    return { lines: lines };
  },

  /**
   * 配置三层接口 IP。
   *
   * @param {object} context 处理上下文。
   * @returns {object} 处理结果。
   */
  set_ip_address: function (context) {
    const device = context.device;
    const prefix = String(context.args.prefix);
    const parts = prefix.split('/');
    const ip_address = parts[0];
    const prefix_length = parts.length > 1 ? Number(parts[1]) : 24;
    const mask = context.args.mask || CliFormat.prefix_to_mask(prefix_length);

    if (context.session.mode === 'interface' && context.session.context.port) {
      const port = context.session.context.port;
      port.ip_address = ip_address;
      port.ip_mask = mask;
      device.config_dirty = true;
      emit_port_config(context, port, 'ip_address', null, ip_address + ' ' + mask);
      return { lines: [] };
    }

    const vlan_id =
      context.session.mode === 'vlan'
        ? Number(context.session.context.vlan_id)
        : Number(context.args.interface ? String(context.args.interface).replace(/\D+/g, '') : 1);
    device.vlan_interfaces.set(vlan_id, {
      vlan_id: vlan_id,
      ip_address: ip_address,
      mask: mask,
      prefix_length: prefix_length
    });
    if (!device.vlans.has(vlan_id)) {
      device.vlans.set(vlan_id, {
        vlan_id: vlan_id,
        name: 'VLAN ' + String(vlan_id).padStart(3, '0'),
        description: '',
        ports: []
      });
    }
    device.config_dirty = true;
    device.push_log('Vlanif' + vlan_id + ' ip address ' + ip_address + ' ' + mask);
    context.emit(EVENT_TYPE.PORT_CONFIG_CHANGED, {
      device_id: device.device_id,
      port: null,
      field: 'ip_address',
      from: null,
      to: ip_address
    });
    return { lines: [] };
  },

  /**
   * 清空端口计数。
   *
   * @param {object} context 处理上下文。
   * @returns {object} 处理结果。
   */
  clear_counters: function (context) {
    const device = context.device;
    const port =
      context.args && context.args.interface ? device.find_port(context.args.interface) : null;
    if (port) {
      port.rx_pkts = 0;
      port.tx_pkts = 0;
      port.rx_bytes = 0;
      port.tx_bytes = 0;
      port.in_errors = 0;
      port.out_errors = 0;
      port.crc_errors = 0;
    } else {
      device.reset_counters();
    }
    context.emit(EVENT_TYPE.PORT_STATS_UPDATED, {
      device_id: device.device_id,
      port: port ? port.short_name : null,
      cleared: true
    });
    return {
      lines: [
        message_of(
          context,
          'counter_cleared',
          'Info: The counters of the specified interface are cleared.'
        )
      ]
    };
  },

  /**
   * 连通性测试。
   *
   * @param {object} context 处理上下文。
   * @returns {object} 处理结果。
   */
  ping: function (context) {
    const device = context.device;
    const target_ip = context.args.ipv4;
    const count = Number(context.args.count || 5);
    const templates = (context.profile.text_templates || {}).ping_result || [];
    const reply_template =
      templates.find((line) => line.indexOf('{seq}') >= 0) ||
      '    Reply from {ip}: bytes=56 Sequence={seq} ttl={ttl} time={rtt} ms';
    const head_template = templates[0] || 'PING {ip}: 56 data bytes, press CTRL_C to break';

    const has_link = device.ports.some((port) => device.is_link_up(port));
    const reachable = has_link && device.power_state === DEVICE_STATE.RUNNING;
    const lines = [CliFormat.interpolate(head_template, { ip: target_ip })];
    let received = 0;
    for (let sequence = 1; sequence <= count; sequence += 1) {
      if (reachable && sequence !== 3) {
        received += 1;
        const rtt = Number(utils.rnd(0.4, 6.5).toFixed(1));
        lines.push(
          CliFormat.interpolate(reply_template, {
            ip: target_ip,
            seq: sequence,
            ttl: 255,
            rtt: rtt,
            bytes: 56
          })
        );
      } else {
        lines.push(DEFAULT_PING_TIMEOUT);
      }
    }
    const lost = count - received;
    const loss = Math.round((lost / count) * 100);
    const summary_templates = (context.profile.text_templates || {}).ping_summary || [
      '  --- {ip} ping statistics ---',
      '  {sent} packet(s) transmitted',
      '  {received} packet(s) received',
      '  {loss}% packet loss'
    ];
    const summary = summary_templates.map((line) =>
      CliFormat.interpolate(line, {
        ip: target_ip,
        sent: count,
        received: received,
        loss: loss
      })
    );
    const blocks = lines.concat(summary);
    context.emit(EVENT_TYPE.PORT_STATS_UPDATED, {
      device_id: device.device_id,
      port: null,
      ping_target: target_ip,
      received: received
    });
    return { blocks: { ping_result: blocks }, lines: blocks };
  },

  /**
   * 保存配置。
   *
   * @param {object} context 处理上下文。
   * @returns {object} 处理结果。
   */
  save_config: function (context) {
    const device = context.device;
    device.config_saved = true;
    device.config_dirty = false;
    context.emit(EVENT_TYPE.CONFIG_SAVED, { device_id: device.device_id });
    return {
      lines: [
        message_of(
          context,
          'config_saved',
          'Info: The current configuration is saved to the device successfully.'
        )
      ]
    };
  },

  /**
   * 重启设备。
   *
   * @param {object} context 处理上下文。
   * @returns {object} 处理结果。
   */
  reboot: function (context) {
    const device = context.device;
    context.emit(EVENT_TYPE.DEVICE_REBOOTED, { device_id: device.device_id });
    return {
      lines: [
        message_of(context, 'reboot_started', 'Info: The system is now starting to reboot...')
      ]
    };
  },

  /**
   * 恢复出厂配置。
   *
   * @param {object} context 处理上下文。
   * @returns {object} 处理结果。
   */
  factory_reset: function (context) {
    const device = context.device;
    device.hostname = device._default_hostname(device.manifest);
    device.vlans.clear();
    device._default_vlan();
    device.vlan_interfaces.clear();
    for (const port of device.ports) {
      port.vlan = 1;
      port.mode = 'access';
      port.trunk_vlans = [];
      port.description = '';
      port.admin_up = true;
      port.poe_enabled = false;
      port.poe_watts = 0;
    }
    device.config_saved = true;
    device.config_dirty = false;
    device.push_log('Saved configuration is cleared, the device will start with factory defaults');
    context.emit(EVENT_TYPE.CONFIG_SAVED, { device_id: device.device_id, factory_reset: true });
    return { lines: ['Info: The configuration file is cleared successfully.'] };
  },

  /**
   * `?` 帮助。
   *
   * @param {object} context 处理上下文。
   * @returns {object} 处理结果。
   */
  show_help: function (context) {
    const commands = context.profile.commands || [];
    const lines = [];
    for (const command of commands) {
      if (command.hidden || command.modes.indexOf(context.session.mode) < 0) {
        continue;
      }
      lines.push('  ' + utils.pad_end(command.syntax, 44) + command.help);
    }
    lines.sort();
    return { blocks: { help_text: lines } };
  }
};

/**
 * 查询处理器实现。
 *
 * @param {string} name 处理器名。
 * @returns {Function|null} 处理器函数。
 */
function get_handler(name) {
  return Object.prototype.hasOwnProperty.call(HANDLERS, name) ? HANDLERS[name] : null;
}

export const CliHandlers = {
  HANDLERS: HANDLERS,
  get_handler: get_handler,
  resolve_port: resolve_port,
  message_of: message_of,
  failure: failure
};
