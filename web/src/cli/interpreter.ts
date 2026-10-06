/**
 * @File : web/src/cli/interpreter.ts
 * @Time : 2026-10-04 10:40
 * @Author : Cetrp
 * @Description : 厂商 CLI 解释器：模式栈、命令匹配（含关键字缩写）、确认交互、Tab 补全与 ? 帮助。
 */

import { utils, EVENT_TYPE } from '../core/constants';
import type { CliCommand, CliMode, CliProfile, PortState, VendorProfile } from '../data/types';
import type { DeviceRuntime } from '../core/device_runtime';
import { make_id } from '../core/event_bus';
import { CliFormat } from './format';
import { CliHandlers } from './handlers';
import { SpecRegistry } from '../data/spec_loader';

/** 关键字缩写的最小长度。 */
const MIN_ABBREVIATION_LENGTH = 2;

/**
 * 将语法串解析为 token 列表，支持末尾可选段 `[...]`。
 *
 * @param {string} syntax 语法串，例如 `ping {ipv4} [count {integer}]`。
 * @returns {object} { required: [], optional: [] }
 */
function parse_syntax(syntax) {
  const required = [];
  const optional = [];
  let in_optional = false;
  for (const raw_token of String(syntax).split(/\s+/)) {
    if (!raw_token) {
      continue;
    }
    if (raw_token === '[') {
      in_optional = true;
      continue;
    }
    let token = raw_token;
    let closes_optional = false;
    if (token.startsWith('[')) {
      in_optional = true;
      token = token.slice(1);
    }
    if (token.endsWith(']')) {
      closes_optional = true;
      token = token.slice(0, -1);
    }
    if (!token) {
      if (closes_optional) {
        in_optional = false;
      }
      continue;
    }
    (in_optional ? optional : required).push(token);
    if (closes_optional) {
      in_optional = false;
    }
  }
  return { required: required, optional: optional };
}

/**
 * 生成命令的全部 token 模式：可选段可以出现在语法中间（如 `ping [-c {count}] {ipv4}`），
 * 因此按“包含/省略”对每个可选段做笛卡尔展开，保持 token 顺序。
 *
 * @param {string} syntax 语法串。
 * @returns {string[][]} 模式列表（每个模式是 token 数组）。
 */
function expand_syntax_patterns(syntax) {
  const segments = [];
  let current_optional = null;
  for (const raw_token of String(syntax).split(/\s+/)) {
    if (!raw_token) {
      continue;
    }
    if (raw_token === '[') {
      current_optional = { tokens: [], optional: true };
      segments.push(current_optional);
      continue;
    }
    let token = raw_token;
    let opens_optional = false;
    let closes_optional = false;
    if (token.startsWith('[')) {
      opens_optional = true;
      token = token.slice(1);
    }
    if (token.endsWith(']')) {
      closes_optional = true;
      token = token.slice(0, -1);
    }
    if (opens_optional) {
      current_optional = { tokens: [], optional: true };
      segments.push(current_optional);
    }
    if (token) {
      if (current_optional) {
        current_optional.tokens.push(token);
      } else {
        segments.push({ tokens: [token], optional: false });
      }
    }
    if (closes_optional) {
      current_optional = null;
    }
  }

  let patterns = [[]];
  for (const segment of segments) {
    const next = [];
    for (const pattern of patterns) {
      next.push(pattern.concat(segment.tokens));
      if (segment.optional) {
        next.push(pattern.slice());
      }
    }
    patterns = next;
  }

  const unique = [];
  const seen = new Set();
  for (const pattern of patterns) {
    if (pattern.length === 0) {
      continue;
    }
    const key = pattern.join(' ');
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(pattern);
    }
  }
  return unique;
}

/**
 * 判断占位符 token。
 *
 * @param {string} token 语法 token。
 * @returns {boolean} 是否为占位符。
 */
function is_placeholder(token) {
  return /^\{(\w+)\}$/.test(token);
}

/**
 * 提取占位符名称。
 *
 * @param {string} token 语法 token。
 * @returns {string} 参数名。
 */
function placeholder_name(token) {
  return /\{(\w+)\}/.exec(token)[1];
}

/**
 * 匹配单个字面量关键字（允许厂商缩写）。
 *
 * @param {string} pattern 语法关键字。
 * @param {string} input 用户输入 token。
 * @returns {number} 匹配得分：完全一致 3，合法缩写 2，不匹配 0。
 */
function match_literal(pattern, input) {
  const pattern_text = pattern.toLowerCase();
  const input_text = input.toLowerCase();
  if (pattern_text === input_text) {
    return 3;
  }
  if (input_text.length >= MIN_ABBREVIATION_LENGTH && pattern_text.startsWith(input_text)) {
    return 2;
  }
  return 0;
}

/**
 * 用给定 token 模板匹配输入 token。
 *
 * @param {string[]} pattern_tokens 语法 token 列表。
 * @param {string[]} input_tokens 输入 token 列表。
 * @returns {object|null} { captures, score } 或 null。
 */
function match_tokens(pattern_tokens, input_tokens) {
  const captures = {};
  let score = 0;
  let exact_count = 0;
  let index = 0;

  for (let i = 0; i < pattern_tokens.length; i += 1) {
    const pattern_token = pattern_tokens[i];
    const is_last = i === pattern_tokens.length - 1;
    if (is_placeholder(pattern_token)) {
      if (index >= input_tokens.length) {
        return null;
      }
      if (is_last) {
        /* 末尾占位符吃下剩余 token：锐捷 / 思科的接口名带空格（GigabitEthernet 0/1）。 */
        captures[placeholder_name(pattern_token)] = input_tokens.slice(index).join(' ');
        index = input_tokens.length;
      } else {
        captures[placeholder_name(pattern_token)] = input_tokens[index];
        index += 1;
      }
      continue;
    }
    if (index >= input_tokens.length) {
      return null;
    }
    const literal_score = match_literal(pattern_token, input_tokens[index]);
    if (literal_score === 0) {
      return null;
    }
    if (literal_score === 3) {
      exact_count += 1;
    }
    score += literal_score;
    index += 1;
  }
  if (index !== input_tokens.length) {
    return null;
  }
  return { captures: captures, score: score + exact_count * 3 };
}

/**
 * 校验并转换参数值。
 *
 * @param {object} command 命令定义。
 * @param {object} captures 捕获的原始值。
 * @param {object} device 设备运行时。
 * @returns {object} { args, error }
 */
function coerce_args(command, captures, device) {
  const args = {};
  const definitions = command.args || [];
  for (const definition of definitions) {
    const raw_value = captures[definition.name];
    if (raw_value === undefined) {
      if (definition.required === false || definition.required === undefined) {
        continue;
      }
      return { args: args, error: 'incomplete' };
    }
    switch (definition.type) {
      case 'interface': {
        const port = device.find_port(raw_value);
        if (!port) {
          return { args: args, error: 'wrong_parameter' };
        }
        args[definition.name] = port.short_name;
        break;
      }
      case 'enum': {
        const values = definition.values || [];
        const matched = values.find((value) => value.toLowerCase() === raw_value.toLowerCase());
        if (!matched) {
          return { args: args, error: 'wrong_parameter' };
        }
        args[definition.name] = matched;
        break;
      }
      case 'vlan': {
        const vlan_id = Number(raw_value);
        if (!Number.isInteger(vlan_id) || vlan_id < 1 || vlan_id > 4094) {
          return { args: args, error: 'wrong_parameter' };
        }
        args[definition.name] = vlan_id;
        break;
      }
      case 'integer': {
        if (!/^-?\d+$/.test(raw_value)) {
          return { args: args, error: 'wrong_parameter' };
        }
        args[definition.name] = Number(raw_value);
        break;
      }
      case 'ipv4': {
        if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(raw_value)) {
          return { args: args, error: 'wrong_parameter' };
        }
        args[definition.name] = raw_value;
        break;
      }
      case 'prefix': {
        if (!/^\d{1,3}(\.\d{1,3}){3}(\/\d{1,2})?$/.test(raw_value)) {
          return { args: args, error: 'wrong_parameter' };
        }
        args[definition.name] = raw_value;
        break;
      }
      case 'speed': {
        const allowed = definition.values || ['10', '100', '1000', 'auto'];
        const matched = allowed.find((value) => value.toLowerCase() === raw_value.toLowerCase());
        if (!matched) {
          return { args: args, error: 'wrong_parameter' };
        }
        args[definition.name] = matched;
        break;
      }
      default:
        args[definition.name] = raw_value;
    }
  }
  return { args: args, error: null };
}

/**
 * 在厂商命令表中查找匹配的命令。
 *
 * @param {object} profile CLI 档案。
 * @param {string} mode 当前模式。
 * @param {string[]} input_tokens 输入 token。
 * @param {object} device 设备运行时。
 * @returns {object} { command, args, error }
 */
function find_command(profile, mode, input_tokens, device) {
  const candidates = [];
  let prefix_hit = null;
  let mode_mismatch = false;

  for (const command of profile.commands || []) {
    if (command.hidden && !command.matchable) {
      continue;
    }
    const patterns = expand_syntax_patterns(command.syntax);
    for (const alias of command.aliases || []) {
      patterns.push(...expand_syntax_patterns(alias));
    }

    for (const pattern of patterns) {
      const matched = match_tokens(pattern, input_tokens);
      if (!matched) {
        if (pattern.length > input_tokens.length) {
          const head = pattern.slice(0, input_tokens.length);
          const head_matched = match_tokens(head, input_tokens);
          if (head_matched && pattern.length > input_tokens.length) {
            prefix_hit = prefix_hit || command;
          }
        }
        continue;
      }
      if ((command.modes || []).indexOf(mode) < 0) {
        mode_mismatch = true;
        continue;
      }
      const coerced = coerce_args(command, matched.captures, device);
      if (coerced.error) {
        if (coerced.error === 'wrong_parameter') {
          candidates.push({ command: command, args: null, error: 'wrong_parameter', score: 0 });
        }
        continue;
      }
      candidates.push({
        command: command,
        args: coerced.args,
        error: null,
        score: matched.score + pattern.length
      });
    }
  }

  if (candidates.length > 0) {
    candidates.sort((left, right) => right.score - left.score);
    const best = candidates[0];
    if (best.error === 'wrong_parameter') {
      return { command: best.command, args: null, error: 'wrong_parameter' };
    }
    const tied = candidates.filter(
      (item) => item.score === best.score && item.command.id !== best.command.id
    );
    if (tied.length > 0 && tied[0].command.id !== best.command.id) {
      return { command: best.command, args: null, error: 'ambiguous' };
    }
    return { command: best.command, args: best.args, error: null };
  }
  if (prefix_hit) {
    return { command: prefix_hit, args: null, error: 'incomplete' };
  }
  return { command: null, args: null, error: mode_mismatch ? 'unknown' : 'unknown' };
}

/**
 * 命令行会话：保存模式栈、上下文、历史与待确认操作。
 */
class CliSession {
  /** 设备运行时。 */
  device: DeviceRuntime;

  /** CLI 档案。 */
  profile: CliProfile;

  /** 厂商档案。 */
  vendor: VendorProfile;

  /** 事件回调。 */
  emit: (event_type: string, data: Record<string, unknown>) => void;

  /** 会话 ID。 */
  session_id: string;

  /** 根视图（锐捷 / 思科为特权模式）。 */
  root_mode: string;

  /** 当前模式。 */
  mode: string;

  /** 模式栈。 */
  mode_stack: string[];

  /** 视图上下文（当前接口 / VLAN）。 */
  context: { port: PortState | null; vlan_id: number | null };

  /** 历史命令。 */
  history: string[];

  /** 历史游标。 */
  history_index: number;

  /** 待确认操作。 */
  pending: { command: CliCommand; args: Record<string, unknown> } | null;

  /** 待提交的状态变更。 */
  state_changes: Record<string, unknown>[];

  /** 会话是否已关闭。 */
  closed: boolean;

  /**
   * @param {object} options 构造参数。
   * @param {object} options.device 设备运行时。
   * @param {object} options.profile CLI 档案。
   * @param {object} options.vendor 厂商档案。
   * @param {Function} [options.emit] 事件回调 (event_type, data)。
   */
  constructor(options) {
    this.device = options.device;
    this.profile = options.profile;
    this.vendor = options.vendor;
    this.emit = options.emit || function () {};
    this.session_id = options.session_id || make_id('console');
    /* 锐捷 / 思科存在特权模式，"return"/"end" 回到特权模式；
         但会话始终从用户视图开始（Cisco 风格必须先 enable）。 */
    this.root_mode = this.profile.modes.privileged ? 'privileged' : 'user';
    this.mode = this.profile.modes.user ? 'user' : this.root_mode;
    this.mode_stack = [];
    this.context = { port: null, vlan_id: null };
    this.history = [];
    this.history_index = 0;
    this.pending = null;
    this.state_changes = [];
    this.closed = false;
  }

  /**
   * 当前提示符。
   *
   * @returns {string} 提示符文本。
   */
  prompt() {
    const mode_spec: CliMode = (this.profile.modes[this.mode] || { prompt_key: 'user' }) as CliMode;
    const prompt_key = mode_spec.prompt_key || 'user';
    const context = {
      hostname: this.device.hostname,
      interface: this.context.port ? this.context.port.name : '',
      vlan: this.context.vlan_id || ''
    };
    const base_prompt = SpecRegistry.render_prompt(this.vendor, prompt_key, context);
    return (
      base_prompt +
      (this.mode === 'config' || this.mode === 'interface' || this.mode === 'vlan'
        ? this.profile.prompt_suffix || ''
        : '')
    );
  }

  /**
   * 读取提示语。
   *
   * @param {string} key 消息键。
   * @param {string} fallback 默认文本。
   * @returns {string} 提示语。
   */
  message(key, fallback = '') {
    const messages = this.vendor.messages || {};
    return messages[key] !== undefined ? messages[key] : fallback;
  }

  /**
   * 执行一行输入。
   *
   * @param {string} raw_line 用户输入。
   * @returns {object} { lines, prompt, mode, state_changes }
   */
  write(raw_line) {
    const line = String(raw_line === undefined || raw_line === null ? '' : raw_line);
    const trimmed = line.trim();
    const lines = [];

    if (trimmed.length === 0) {
      return this._result(lines);
    }

    if (this.pending) {
      return this._handle_confirm(trimmed);
    }

    this.history.push(trimmed);
    this.history_index = this.history.length;

    if (trimmed === '?' || trimmed.endsWith(' ?')) {
      return this._run_help(trimmed);
    }

    const input_tokens = trimmed.split(/\s+/);
    const match_result = find_command(this.profile, this.mode, input_tokens, this.device);

    if (!match_result.command || match_result.error) {
      const error_key =
        match_result.error === 'wrong_parameter'
          ? 'wrong_parameter'
          : match_result.error === 'incomplete'
            ? 'incomplete_command'
            : match_result.error === 'ambiguous'
              ? 'ambiguous_command'
              : 'unknown_command';
      const fallback =
        match_result.error === 'wrong_parameter'
          ? "Error: Wrong parameter found at '^' position."
          : "Error: Unrecognized command found at '^' position.";
      return this._result([this.message(error_key, fallback)]);
    }

    const command = match_result.command;
    if (command.confirm) {
      const confirm_key =
        command.confirm === 'reboot'
          ? 'reboot_confirm'
          : command.confirm === 'factory_reset'
            ? 'factory_reset_confirm'
            : 'save_confirm';
      const fallback = 'Are you sure to continue? [Y/N]:';
      this.pending = { command: command, args: match_result.args };
      return this._result([this.message(confirm_key, fallback)]);
    }

    return this._execute(command, match_result.args);
  }

  /**
   * 处理 Y/N 确认。
   *
   * @param {string} answer 用户输入。
   * @returns {object} 执行结果。
   * @private
   */
  _handle_confirm(answer) {
    const pending = this.pending;
    this.pending = null;
    const words = this.vendor.confirm_words || { yes: ['y', 'yes'], no: ['n', 'no'] };
    const normalized = answer.toLowerCase();
    if ((words.yes || ['y']).indexOf(normalized) >= 0) {
      return this._execute(pending.command, pending.args);
    }
    if ((words.no || ['n']).indexOf(normalized) >= 0) {
      return this._result([this.message('operation_aborted', 'Info: The operation is aborted.')]);
    }
    return this._result([
      this.message('unknown_command', "Error: Unrecognized command found at '^' position.")
    ]);
  }

  /**
   * 执行 `?` 帮助。
   *
   * @param {string} trimmed 输入行。
   * @returns {object} 执行结果。
   * @private
   */
  _run_help(trimmed) {
    const tokens = trimmed.replace(/\s*\?$/, '').trim();
    if (!tokens) {
      const help_handler = CliHandlers.get_handler('show_help');
      const help_result = help_handler(this._handler_context({}, null, []));
      return this._result(help_result.blocks.help_text || []);
    }
    const input_tokens = tokens.split(/\s+/);
    const suggestions = [];
    for (const command of this.profile.commands || []) {
      if ((command.modes || []).indexOf(this.mode) < 0) {
        continue;
      }
      const syntax_tokens = parse_syntax(command.syntax).required;
      if (syntax_tokens.length < input_tokens.length) {
        continue;
      }
      let matched = true;
      for (let i = 0; i < input_tokens.length; i += 1) {
        const pattern_token = syntax_tokens[i];
        if (is_placeholder(pattern_token)) {
          continue;
        }
        if (match_literal(pattern_token, input_tokens[i]) === 0) {
          matched = false;
          break;
        }
      }
      if (matched) {
        const next_token = syntax_tokens[input_tokens.length];
        const hint = next_token
          ? is_placeholder(next_token)
            ? '<' + placeholder_name(next_token) + '>'
            : next_token
          : '(执行)';
        suggestions.push('  ' + utils.pad_end(hint, 26) + command.help);
      }
    }
    if (suggestions.length === 0) {
      return this._result([
        this.message('unknown_command', "Error: Unrecognized command found at '^' position.")
      ]);
    }
    suggestions.sort();
    return this._result(suggestions);
  }

  /**
   * 执行命令并返回回显。
   *
   * @param {object} command 命令定义。
   * @param {object} args 参数。
   * @returns {object} 执行结果。
   * @private
   */
  _execute(command, args) {
    const handler = CliHandlers.get_handler(command.handler);
    if (!handler) {
      return this._result(['Error: Command handler not implemented: ' + command.handler]);
    }
    const state_changes = [];
    const context = this._handler_context(args || {}, command, state_changes);
    const result = handler(context) || {};

    if (result.success === false) {
      return this._result(result.lines || [], state_changes);
    }
    const handler_transition = result.transition || null;
    if (handler_transition && handler_transition.authoritative) {
      /* 出栈类命令（quit/exit/return/end）自行决定目标模式，不再叠加 next_mode。 */
      this._apply_transition(handler_transition);
    } else {
      const target_mode =
        command.next_mode || (handler_transition ? handler_transition.mode : null);
      if (target_mode) {
        this._apply_transition(Object.assign({}, handler_transition, { mode: target_mode }));
      } else if (handler_transition) {
        this._apply_transition(handler_transition);
      }
    }

    let lines = result.lines;
    if (!lines) {
      const render_context = Object.assign(
        this.device.template_context(),
        result.context || {},
        result.blocks || {},
        {
          interface: this.context.port ? this.context.port.name : '',
          interface_short: this.context.port ? this.context.port.short_name : '',
          vlan: this.context.vlan_id || ''
        }
      );
      lines = CliFormat.render_output(command.output || [], render_context, result.flags || {});
    }
    this.emit(EVENT_TYPE.CONSOLE_OUTPUT, {
      device_id: this.device.device_id,
      session_id: this.session_id,
      command: command.id,
      handler: command.handler
    });
    return this._result(lines, state_changes);
  }

  /**
   * 构造处理器上下文。
   *
   * @param {object} args 参数。
   * @param {object} command 命令。
   * @param {object[]} state_changes 状态变更收集器。
   * @returns {object} 处理器上下文。
   * @private
   */
  _handler_context(args = {}, command = null, state_changes = []) {
    return {
      device: this.device,
      session: this,
      profile: this.profile,
      vendor: this.vendor,
      args: args,
      command: command,
      state_changes: state_changes,
      emit: this.emit
    };
  }

  /**
   * 应用模式切换。
   *
   * @param {object} transition 切换描述。
   * @returns {void}
   * @private
   */
  _apply_transition(transition) {
    if (transition.mode && transition.mode !== this.mode) {
      if (!transition.skip_push) {
        this.mode_stack.push(this.mode);
      }
      this.mode = transition.mode;
    }
    if (transition.clear_port) {
      this.context.port = null;
    }
    if (transition.port) {
      this.context.port = this.device.find_port(transition.port.short_name);
    }
    if (transition.vlan_id) {
      this.context.vlan_id = transition.vlan_id;
    }
  }

  /**
   * 弹出上一级模式（quit / exit 使用）。
   *
   * @returns {string|null} 上一级模式，栈空时返回 null。
   */
  pop_mode() {
    return this.mode_stack.length > 0 ? this.mode_stack.pop() : null;
  }

  /**
   * 清空模式栈（return / end 使用）。
   *
   * @returns {void}
   */
  clear_mode_stack() {
    this.mode_stack.length = 0;
    this.context.port = null;
    this.context.vlan_id = null;
  }

  /**
   * 组装返回结构。
   *
   * @param {string[]} lines 回显行。
   * @param {object[]} [state_changes] 状态变更。
   * @returns {object} 执行结果。
   * @private
   */
  _result(lines, state_changes = null) {
    const changes = state_changes || this.state_changes;
    this.state_changes = [];
    return {
      lines: lines || [],
      prompt: this.prompt(),
      mode: this.mode,
      state_changes: changes
    };
  }

  /**
   * Tab 补全候选。
   *
   * @param {string} partial 已输入内容。
   * @returns {string[]} 候选命令前缀列表。
   */
  complete(partial = ''): string[] {
    const text = String(partial || '');
    const trailing_space = /\s$/.test(text);
    const tokens = text.trim().length === 0 ? [] : text.trim().split(/\s+/);
    const candidates = new Set<string>();
    for (const command of this.profile.commands || []) {
      if ((command.modes || []).indexOf(this.mode) < 0 || command.hidden) {
        continue;
      }
      const syntax_tokens = parse_syntax(command.syntax).required;
      const current_tokens = trailing_space ? tokens.concat(['']) : tokens;
      if (current_tokens.length > syntax_tokens.length) {
        continue;
      }
      let matched = true;
      for (let i = 0; i < current_tokens.length - 1; i += 1) {
        const pattern_token = syntax_tokens[i];
        if (is_placeholder(pattern_token)) {
          continue;
        }
        if (match_literal(pattern_token, current_tokens[i]) === 0) {
          matched = false;
          break;
        }
      }
      if (!matched) {
        continue;
      }
      const last_index = Math.max(0, current_tokens.length - 1);
      const pattern_token = syntax_tokens[last_index];
      if (!pattern_token) {
        continue;
      }
      /* 补全结果使用命令的规范拼写（canonical），与真机和后端 complete 接口一致。 */
      const canonical_head = syntax_tokens.slice(0, Math.max(0, current_tokens.length - 1));
      if (is_placeholder(pattern_token)) {
        const definition = (command.args || []).find(
          (item) => item.name === placeholder_name(pattern_token)
        );
        if (definition && definition.type === 'interface') {
          const head_text = canonical_head.join(' ');
          for (const port of this.device.ports) {
            if (
              port.name
                .toLowerCase()
                .startsWith(current_tokens[current_tokens.length - 1].toLowerCase())
            ) {
              candidates.add((head_text ? head_text + ' ' : '') + port.name);
            }
          }
        }
        continue;
      }
      const prefix = current_tokens.length > 0 ? current_tokens[current_tokens.length - 1] : '';
      if (pattern_token.toLowerCase().startsWith(prefix.toLowerCase())) {
        const head_text = canonical_head.join(' ');
        candidates.add((head_text ? head_text + ' ' : '') + pattern_token);
      }
    }
    const result: string[] = Array.from(candidates).sort();
    if (result.length === 1) {
      return [result[0] + ' '];
    }
    return result;
  }

  /**
   * 上下键历史导航。
   *
   * @param {number} direction -1 表示上一条，1 表示下一条。
   * @returns {string} 历史命令。
   */
  history_step(direction) {
    if (this.history.length === 0) {
      return '';
    }
    this.history_index = utils.clamp(this.history_index + direction, 0, this.history.length);
    if (this.history_index === this.history.length) {
      return '';
    }
    return this.history[this.history_index];
  }

  /**
   * 会话是否处于交互确认状态。
   *
   * @returns {boolean} 是否等待确认。
   */
  is_confirming() {
    return Boolean(this.pending);
  }
}

export { CliSession };
export const cli_interpreter = {
  parse_syntax: parse_syntax,
  expand_syntax_patterns: expand_syntax_patterns,
  match_literal: match_literal,
  match_tokens: match_tokens,
  coerce_args: coerce_args,
  find_command: find_command,
  MIN_ABBREVIATION_LENGTH: MIN_ABBREVIATION_LENGTH
};
