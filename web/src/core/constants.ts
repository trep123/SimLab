/**
 * @File : web/src/core/constants.ts
 * @Time : 2026-10-04 09:00
 * @Author : Cetrp
 * @Description : 全局命名空间、枚举常量与基础工具函数（无 DOM 依赖，可被 Node 单元测试直接加载）。
 */

/** 平台全局命名空间。 */

/** 平台版本，与 CHANGELOG 保持一致。 */
export const PLATFORM_VERSION = '1.0.0';

/** 平台展示名。 */
export const PLATFORM_NAME = '3D 网络与计算机数字孪生仿真平台';

/** 设备统一状态机（任务书 §16）。 */
export const DEVICE_STATE = Object.freeze({
  CREATED: 'CREATED',
  ASSEMBLING: 'ASSEMBLING',
  READY_FOR_POWER: 'READY_FOR_POWER',
  POWERING_ON: 'POWERING_ON',
  BIOS: 'BIOS',
  BOOTING: 'BOOTING',
  RUNNING: 'RUNNING',
  SHUTTING_DOWN: 'SHUTTING_DOWN',
  OFF: 'OFF',
  FAULT: 'FAULT'
});

/** 端口链路状态（任务书 §12）。 */
export const PORT_STATE = Object.freeze({
  DISABLED: 'DISABLED',
  DOWN: 'DOWN',
  CONNECTING: 'CONNECTING',
  UP: 'UP',
  ERROR: 'ERROR'
});

/** 线缆类型（任务书 §13.1）。 */
export const CABLE_TYPE = Object.freeze({
  ETHERNET_COPPER: 'ETHERNET_COPPER',
  OPTICAL_FIBER: 'OPTICAL_FIBER',
  CONSOLE: 'CONSOLE',
  POWER_AC: 'POWER_AC'
});

/** 命令类型（任务书 §17）。 */
export const COMMAND_TYPE = Object.freeze({
  CREATE_DEVICE: 'CreateDevice',
  DELETE_DEVICE: 'DeleteDevice',
  MOVE_DEVICE: 'MoveDevice',
  CONNECT_CABLE: 'ConnectCable',
  DISCONNECT_CABLE: 'DisconnectCable',
  POWER_ON: 'PowerOn',
  POWER_OFF: 'PowerOff',
  RESTART: 'Restart',
  CONFIGURE_PORT: 'ConfigurePort',
  CONFIGURE_IP_ADDRESS: 'ConfigureIPAddress',
  CONSOLE_WRITE: 'ConsoleWrite',
  INJECT_FAULT: 'InjectFault',
  CLEAR_COUNTERS: 'ClearCounters',
  SAVE_CONFIG: 'SaveConfig'
});

/** 事件类型（任务书 §18）。 */
export const EVENT_TYPE = Object.freeze({
  DEVICE_CREATED: 'device.created',
  DEVICE_STATE_CHANGED: 'device.state.changed',
  DEVICE_BOOT_PROGRESS: 'device.boot.progress',
  DEVICE_CAPABILITY: 'device.capability',
  DEVICE_MOVED: 'device.moved',
  PORT_LINK_CHANGED: 'port.link.changed',
  PORT_ADMIN_CHANGED: 'port.admin.changed',
  PORT_CONFIG_CHANGED: 'port.config.changed',
  PORT_STATS_UPDATED: 'port.stats.updated',
  CABLE_CONNECTED: 'cable.connected',
  CABLE_DISCONNECTED: 'cable.disconnected',
  CONFIG_SAVED: 'device.config.saved',
  DEVICE_REBOOTED: 'device.rebooted',
  FAULT_INJECTED: 'fault.injected',
  CONSOLE_OUTPUT: 'console.output',
  CONSOLE_SESSION: 'console.session',
  COMMAND_ACCEPTED: 'command.accepted',
  COMMAND_REJECTED: 'command.rejected',
  LOG_APPENDED: 'log.appended',
  LINK_STATE_CHANGED: 'link.state.changed',
  PACKET_FORWARDED: 'packet.forwarded',
  PING_COMPLETED: 'ping.completed',
  WIRELESS_AP_UPDATED: 'wireless.ap.updated',
  WIRELESS_ASSOC_CHANGED: 'wireless.assoc.changed',
  WIRELESS_METRICS_UPDATED: 'wireless.metrics.updated',
  WIRELESS_FRAME: 'wireless.frame',
  OPTICAL_OLT_UPDATED: 'optical.olt.updated',
  OPTICAL_LINK_CHANGED: 'optical.link.changed',
  OPTICAL_METRICS_UPDATED: 'optical.metrics.updated',
  OPTICAL_ALARM: 'optical.alarm',
  DEVICE_RENAMED: 'device.renamed'
});

/** 设备类型到中文描述的映射。 */
export const DEVICE_TYPE_TEXT = Object.freeze({
  switch: '接入交换机',
  l3switch: '三层交换机',
  router: '路由器',
  firewall: '防火墙',
  ap: '无线接入点',
  pc: '个人计算机',
  server: '服务器',
  laptop: '无线笔记本电脑',
  phone: '无线手机',
  olt: '光线路终端（OLT）',
  onu: '光网络单元（ONU）',
  cloud: 'Cloud 桥接网络'
});

/** 事件总线与日志使用的级别。 */
export const LOG_LEVEL = Object.freeze({
  DEBUG: 'DEBUG',
  INFO: 'INFO',
  WARNING: 'WARNING',
  ERROR: 'ERROR',
  CRITICAL: 'CRITICAL'
});

/** 端口速率（bps）到显示文本。 */
export const SPEED_TEXT = Object.freeze({
  10000000: '10M',
  100000000: '100M',
  1000000000: '1000M',
  10000000000: '10G'
});

/**
 * 将数值限制在闭区间内。
 *
 * @param {number} value 输入值。
 * @param {number} min_value 下界。
 * @param {number} max_value 上界。
 * @returns {number} 限制后的值。
 */
function clamp(value, min_value, max_value) {
  return Math.min(max_value, Math.max(min_value, value));
}

/**
 * 线性插值。
 *
 * @param {number} from_value 起点。
 * @param {number} to_value 终点。
 * @param {number} ratio 插值比例。
 * @returns {number} 插值结果。
 */
function lerp(from_value, to_value, ratio) {
  return from_value + (to_value - from_value) * ratio;
}

/**
 * 生成区间内的随机浮点数。
 *
 * @param {number} min_value 下界。
 * @param {number} max_value 上界。
 * @returns {number} 随机值。
 */
function rnd(min_value, max_value) {
  return min_value + Math.random() * (max_value - min_value);
}

/**
 * 生成区间内的随机整数（含两端）。
 *
 * @param {number} min_value 下界。
 * @param {number} max_value 上界。
 * @returns {number} 随机整数。
 */
function rint(min_value, max_value) {
  return Math.floor(rnd(min_value, max_value + 1));
}

/**
 * 深拷贝纯 JSON 结构。
 *
 * @param {*} source 源数据。
 * @returns {*} 拷贝结果。
 */
function deep_clone(source) {
  return JSON.parse(JSON.stringify(source));
}

/**
 * 转义 HTML 特殊字符，防止设备名或命令回显注入页面。
 *
 * @param {string} text 原始文本。
 * @returns {string} 转义后的文本。
 */
function escape_html(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 计算字符串显示宽度（中日韩字符按 2 列计算）。
 *
 * @param {string} text 输入文本。
 * @returns {number} 列宽。
 */
function display_width(text) {
  let width = 0;
  for (const char of String(text)) {
    const code_point = char.codePointAt(0);
    const is_wide =
      (code_point >= 0x1100 && code_point <= 0x115f) ||
      (code_point >= 0x2e80 && code_point <= 0xa4cf) ||
      (code_point >= 0xac00 && code_point <= 0xd7a3) ||
      (code_point >= 0xf900 && code_point <= 0xfaff) ||
      (code_point >= 0xfe30 && code_point <= 0xfe6f) ||
      (code_point >= 0xff00 && code_point <= 0xff60) ||
      (code_point >= 0xffe0 && code_point <= 0xffe6);
    width += is_wide ? 2 : 1;
  }
  return width;
}

/**
 * 按显示宽度左侧补齐空格。
 *
 * @param {string} text 输入文本。
 * @param {number} width 目标宽度。
 * @returns {string} 补齐后的文本。
 */
function pad_end(text, width) {
  const padding = width - display_width(text);
  return padding > 0 ? String(text) + ' '.repeat(padding) : String(text);
}

/**
 * 按显示宽度右侧补齐空格。
 *
 * @param {string} text 输入文本。
 * @param {number} width 目标宽度。
 * @returns {string} 补齐后的文本。
 */
function pad_start(text, width) {
  const padding = width - display_width(text);
  return padding > 0 ? ' '.repeat(padding) + String(text) : String(text);
}

/**
 * 按显示宽度居中补齐空格。
 *
 * @param {string} text 输入文本。
 * @param {number} width 目标宽度。
 * @returns {string} 补齐后的文本。
 */
function pad_center(text, width) {
  const padding = width - display_width(text);
  if (padding <= 0) {
    return String(text);
  }
  const left = Math.floor(padding / 2);
  return ' '.repeat(left) + String(text) + ' '.repeat(padding - left);
}

/**
 * 格式化运行时长，输出形如 3 weeks, 2 days, 4 hours, 12 minutes。
 *
 * @param {number} seconds 秒数。
 * @returns {string} 运行时长文本。
 */
function format_uptime(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const weeks = Math.floor(total / 604800);
  const days = Math.floor((total % 604800) / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const parts = [];
  if (weeks > 0) {
    parts.push(weeks + ' week' + (weeks > 1 ? 's' : ''));
  }
  if (days > 0) {
    parts.push(days + ' day' + (days > 1 ? 's' : ''));
  }
  if (hours > 0) {
    parts.push(hours + ' hour' + (hours > 1 ? 's' : ''));
  }
  parts.push(minutes + ' minute' + (minutes === 1 ? '' : 's'));
  return parts.join(', ');
}

/**
 * 以 24 小时制格式化时间。
 *
 * @param {Date} date_value 时间对象。
 * @returns {string} 形如 2026-10-04 09:30:00。
 */
function format_datetime(date_value) {
  const date = date_value || new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return (
    date.getFullYear() +
    '-' +
    pad(date.getMonth() + 1) +
    '-' +
    pad(date.getDate()) +
    ' ' +
    pad(date.getHours()) +
    ':' +
    pad(date.getMinutes()) +
    ':' +
    pad(date.getSeconds())
  );
}

/**
 * 以 12 位十六进制生成确定性伪随机数（同一 seed 结果一致，便于测试）。
 *
 * @param {string} seed 种子文本。
 * @returns {number} 0~1 之间的数。
 */
function seeded_random(seed) {
  let hash_value = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    hash_value ^= seed.charCodeAt(i);
    hash_value = Math.imul(hash_value, 16777619);
  }
  return ((hash_value >>> 0) % 100000) / 100000;
}

/**
 * 生成可播种的伪随机数发生器（mulberry32），用于可复现的仿真与测试。
 *
 * @param {number} seed 种子。
 * @returns {() => number} 返回 0–1 随机数的函数。
 */
function seeded_random_source(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return function next_random(): number {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export const utils = {
  clamp: clamp,
  lerp: lerp,
  rnd: rnd,
  rint: rint,
  deep_clone: deep_clone,
  escape_html: escape_html,
  display_width: display_width,
  pad_end: pad_end,
  pad_start: pad_start,
  pad_center: pad_center,
  format_uptime: format_uptime,
  format_datetime: format_datetime,
  seeded_random: seeded_random,
  seeded_random_source: seeded_random_source
};
