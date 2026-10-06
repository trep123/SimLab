/**
 * @File : web/src/data/spec_loader.ts
 * @Time : 2026-10-04 09:20
 * @Author : Cetrp
 * @Description : 厂商档案 / 设备 Manifest / CLI 档案的加载、校验与端口展开（契约：
 * docs/DATA_CONTRACT.md）。
 */

import { utils, SPEED_TEXT } from '../core/constants';
import { CliDefaults } from '../cli/defaults';
import type { CliProfile, DeviceManifest, VendorProfile } from './types';

/** 展开端口时允许的物理端口形态。 */
const PORT_KINDS = ['rj45', 'sfp', 'sfp_plus', 'combo', 'console', 'usb'];

/** 允许的端口速率（bps）。 */
const PORT_SPEEDS = [10000000, 100000000, 1000000000, 10000000000, 40000000000];

/**
 * 依据 Manifest 的 visual.port_layout 展开端口列表。
 *
 * 端口顺序 = 分组顺序 + 行顺序 + 行内序号升序，与真实面板从左到右、从上到下一致。
 *
 * @param {object} manifest 设备 Manifest。
 * @returns {object[]} 端口定义数组。
 */
function expand_ports(manifest) {
  const visual = manifest.visual || {};
  const layout = visual.port_layout || [];
  const overrides = manifest.port_overrides || [];
  const override_map = new Map();
  for (const override of overrides) {
    if (override && override.short_name) {
      override_map.set(override.short_name, override);
    }
  }

  const ports = [];
  const used_names = new Set();
  for (const group of layout) {
    const naming = group.naming || {};
    const name_prefix = naming.name_prefix || '';
    const short_prefix = naming.short_prefix || name_prefix;
    const alias_prefix = naming.alias_prefix || short_prefix;
    const kind = group.kind || 'rj45';
    const speed_bps = group.speed_bps || 1000000000;
    const poe = Boolean(group.poe);
    const rows = group.rows || [];
    for (const row of rows) {
      const start_index =
        row.start_index === undefined || row.start_index === null ? 1 : Number(row.start_index);
      const count = row.count === undefined || row.count === null ? 0 : Number(row.count);
      for (let offset = 0; offset < count; offset += 1) {
        const index = start_index + offset;
        const short_name = row.names?.[offset] || short_prefix + index;
        if (used_names.has(short_name)) {
          throw new Error('设备 ' + manifest.model_id + ' 端口短名重复：' + short_name);
        }
        used_names.add(short_name);
        const extra = override_map.get(short_name) || {};
        const port = Object.assign(
          {
            id: short_name,
            name: name_prefix + index,
            short_name: short_name,
            alias: alias_prefix + index,
            index: index,
            group_id: group.group_id || kind,
            kind: kind,
            type: kind === 'rj45' ? 'RJ45' : kind === 'combo' ? 'RJ45/SFP' : 'SFP+',
            protocol: 'ethernet',
            speed_bps: speed_bps,
            poe_capable: poe,
            row: row.row_index || 0
          },
          extra
        );
        ports.push(port);
      }
    }
  }
  return ports;
}

/**
 * 校验 Manifest 的必填字段与取值范围。
 *
 * @param {object} manifest 设备 Manifest。
 * @returns {string[]} 错误列表，空数组表示通过。
 */
function validate_manifest(manifest) {
  const errors = [];
  if (!manifest || typeof manifest !== 'object') {
    return ['Manifest 不是对象'];
  }
  const required_keys = ['model_id', 'vendor_id', 'device_type', 'display_name', 'runtime'];
  for (const key of required_keys) {
    if (!manifest[key]) {
      errors.push('缺少字段 ' + key);
    }
  }
  const layout = (manifest.visual || {}).port_layout;
  if (!Array.isArray(layout) || layout.length === 0) {
    errors.push('visual.port_layout 不能为空');
  } else {
    layout.forEach((group, group_index) => {
      if (PORT_KINDS.indexOf(group.kind) < 0) {
        errors.push('port_layout[' + group_index + '].kind 非法：' + group.kind);
      }
      if (PORT_SPEEDS.indexOf(group.speed_bps) < 0) {
        errors.push('port_layout[' + group_index + '].speed_bps 非法：' + group.speed_bps);
      }
      if (!group.naming || !group.naming.short_prefix) {
        errors.push('port_layout[' + group_index + '].naming.short_prefix 缺失');
      }
    });
  }
  if (manifest.runtime && !manifest.runtime.type) {
    errors.push('runtime.type 缺失');
  }
  return errors;
}

/**
 * 校验 CLI 档案的必填字段。
 *
 * @param {object} profile CLI 档案。
 * @returns {string[]} 错误列表。
 */
function validate_cli_profile(profile) {
  const errors = [];
  if (!profile) {
    return ['CLI 档案为空'];
  }
  if (!profile.profile_id) {
    errors.push('profile_id 缺失');
  }
  if (!profile.modes || Object.keys(profile.modes).length === 0) {
    errors.push('modes 缺失');
  }
  if (!Array.isArray(profile.commands) || profile.commands.length === 0) {
    errors.push('commands 为空');
  } else {
    const duplicated = new Set();
    for (const command of profile.commands) {
      if (!command.id || !command.syntax || !command.handler) {
        errors.push('命令缺少 id/syntax/handler：' + JSON.stringify(command).slice(0, 60));
        continue;
      }
      if (duplicated.has(command.id)) {
        errors.push('命令 id 重复：' + command.id);
      }
      duplicated.add(command.id);
      if (!Array.isArray(command.modes) || command.modes.length === 0) {
        errors.push('命令 ' + command.id + ' 未声明 modes');
      }
    }
  }
  return errors;
}

/**
 * 规格注册表：集中管理厂商档案、设备目录与 CLI 档案。
 */
class SpecRegistry {
  /** 厂商档案表。 */
  private _vendors: Map<string, VendorProfile>;

  /** 设备型号表。 */
  private _catalog: Map<string, DeviceManifest>;

  /** CLI 档案表。 */
  private _cli_profiles: Map<string, CliProfile>;

  /** 载入校验错误。 */
  private _errors: string[];

  /**
   * @param {object} [assets] 资产数据，形如 { vendors: [], catalog: [], cli: [] }。
   */
  constructor(assets) {
    this._vendors = new Map();
    this._catalog = new Map();
    this._cli_profiles = new Map();
    this._errors = [];
    if (assets) {
      this.load(assets);
    }
  }

  /**
   * 载入资产数据并完成校验。
   *
   * @param {object} assets 资产数据。
   * @returns {string[]} 校验错误列表。
   */
  load(assets) {
    const vendors = assets.vendors || [];
    const catalog = assets.catalog || [];
    const cli_profiles = assets.cli || [];

    for (const vendor of vendors) {
      if (!vendor.vendor_id) {
        this._errors.push('厂商档案缺少 vendor_id');
        continue;
      }
      const merged_vendor = CliDefaults ? CliDefaults.with_vendor_defaults(vendor) : vendor;
      this._vendors.set(vendor.vendor_id, merged_vendor);
    }
    for (const profile of cli_profiles) {
      const profile_errors = validate_cli_profile(profile);
      for (const message of profile_errors) {
        this._errors.push('CLI 档案 ' + (profile.profile_id || '?') + '：' + message);
      }
      const merged_profile = CliDefaults ? CliDefaults.with_defaults(profile) : profile;
      this._cli_profiles.set(profile.profile_id, merged_profile);
    }
    for (const manifest of catalog) {
      const manifest_errors = validate_manifest(manifest);
      for (const message of manifest_errors) {
        this._errors.push('设备 ' + (manifest.model_id || '?') + '：' + message);
      }
      if (!this._vendors.has(manifest.vendor_id)) {
        this._errors.push(
          '设备 ' + manifest.model_id + ' 引用了不存在的厂商 ' + manifest.vendor_id
        );
      }
      this._catalog.set(manifest.model_id, manifest);
    }
    return this._errors.slice();
  }

  /**
   * 校验结果。
   *
   * @returns {string[]} 错误列表。
   */
  errors() {
    return this._errors.slice();
  }

  /**
   * 查询厂商档案。
   *
   * @param {string} vendor_id 厂商 ID。
   * @returns {object|null} 厂商档案。
   */
  vendor(vendor_id) {
    return this._vendors.get(vendor_id) || null;
  }

  /**
   * 查询设备 Manifest。
   *
   * @param {string} model_id 型号 ID。
   * @returns {object|null} Manifest。
   */
  manifest(model_id) {
    return this._catalog.get(model_id) || null;
  }

  /**
   * 查询 CLI 档案。
   *
   * @param {string} profile_id CLI 档案 ID。
   * @returns {object|null} CLI 档案。
   */
  cli_profile(profile_id) {
    return this._cli_profiles.get(profile_id) || null;
  }

  /**
   * 按厂商查询对应的 CLI 档案。
   *
   * @param {string} vendor_id 厂商 ID。
   * @returns {object|null} CLI 档案。
   */
  cli_profile_for_vendor(vendor_id) {
    const vendor = this.vendor(vendor_id);
    if (!vendor || !vendor.cli_profile_id) {
      return null;
    }
    return this.cli_profile(vendor.cli_profile_id);
  }

  /**
   * 以“厂商分组”的形式返回设备目录，供界面渲染。
   *
   * @returns {object[]} [{ vendor, models: [] }]
   */
  catalog_groups() {
    const groups = new Map();
    for (const manifest of this._catalog.values()) {
      if (!groups.has(manifest.vendor_id)) {
        groups.set(manifest.vendor_id, []);
      }
      groups.get(manifest.vendor_id).push(manifest);
    }
    const result = [];
    for (const [vendor_id, models] of groups.entries()) {
      const vendor = this.vendor(vendor_id);
      models.sort((left, right) => left.model_id.localeCompare(right.model_id));
      result.push({
        vendor_id: vendor_id,
        vendor_name: vendor ? vendor.display_name : vendor_id,
        brand: vendor ? vendor.brand : {},
        models: models
      });
    }
    result.sort((left, right) => left.vendor_id.localeCompare(right.vendor_id));
    return result;
  }

  /**
   * 设备总数。
   *
   * @returns {number} 型号数量。
   */
  model_count() {
    return this._catalog.size;
  }

  /**
   * 厂商总数。
   *
   * @returns {number} 厂商数量。
   */
  vendor_count() {
    return this._vendors.size;
  }

  /**
   * 渲染厂商提示符。
   *
   * @param {object} vendor_profile 厂商档案。
   * @param {string} prompt_key 提示符键（user/config/interface/vlan/privileged）。
   * @param {object} context 上下文，包含 hostname、interface、vlan。
   * @returns {string} 提示符文本。
   */
  static render_prompt(vendor_profile, prompt_key, context) {
    const templates = (vendor_profile && vendor_profile.prompt) || {};
    const template = templates[prompt_key] || templates.user || '<{hostname}>';
    return template.replace(/\{(\w+)\}/g, (match, key) => {
      const value = context ? context[key] : undefined;
      return value === undefined || value === null ? match : String(value);
    });
  }
}

export { expand_ports, validate_manifest, validate_cli_profile, SpecRegistry };
export const spec_utils = {
  PORT_KINDS: PORT_KINDS,
  PORT_SPEEDS: PORT_SPEEDS,
  speed_text: function (speed_bps) {
    return SPEED_TEXT[speed_bps] || utils.pad_end('', 0) + String(speed_bps);
  }
};
