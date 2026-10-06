/**
 * @File : web/src/devices/registry.ts
 * @Time : 2026-10-06 14:10
 * @Author : Cetrp
 * @Description : 设备模板注册表：内置模板按型号懒加载（每个型号一个模块），
 *               用户在工作坊组装/编辑的模板以 JSON 形式保存并合并进同一注册表。
 */

import type { DeviceTemplate } from './template_types';
import { expand_port_row_modules } from './port_module_expansion';

/** 用户模板存储键。 */
const USER_TEMPLATE_STORAGE_KEY = 'simlab.device_templates.v1';

/** 内置模板模块的静态索引（Vite 构建期收集，运行时按需加载）。 */
const TEMPLATE_MODULES = import.meta.glob<{ default: DeviceTemplate }>('./templates/*.ts', {
  eager: false
});

/** 已加载的内置模板（model_id → 模板）。 */
const BUILTIN_TEMPLATES = new Map<string, DeviceTemplate>();

/** 用户模板（model_id → 模板）。 */
const USER_TEMPLATES = new Map<string, DeviceTemplate>();

/** 模板变更标记（保存用户模板后置位，供缩略图与场景刷新）。 */
let THUMBNAIL_CACHE_CLEAR = false;

/** 加载状态。 */
let loaded = false;
let loading: Promise<void> | null = null;

/** 旧版工坊误把度数写入弧度字段；读取时兼容迁移明显超出弧度范围的值。 */
function normalize_legacy_rotation_units(template: DeviceTemplate): DeviceTemplate {
  let changed = false;
  const parts = template.parts.map((part) => {
    const rotation = part.transform?.rotation;
    if (!rotation || !rotation.some((value) => Math.abs(value) > Math.PI * 2 + 0.001)) {
      return part;
    }
    changed = true;
    return {
      ...part,
      transform: {
        ...part.transform,
        rotation: rotation.map((value) => (value * Math.PI) / 180) as [number, number, number]
      }
    };
  });

  return changed ? { ...template, parts: parts } : template;
}

/**
 * 从模块路径解析型号 ID。
 *
 * @param {string} path 模块路径（形如 ./templates/huawei_s5731_s24t4x.ts）。
 * @returns {string} 型号 ID。
 */
function model_id_from_path(path: string): string {
  const file = path.split('/').pop() || '';
  return file.replace(/\.ts$/, '').replace(/_/g, '-');
}

/**
 * 加载全部内置模板模块。
 *
 * @returns {Promise<void>} 加载完成。
 */
async function load_builtin_templates(): Promise<void> {
  const entries = Object.entries(TEMPLATE_MODULES);
  await Promise.all(
    entries.map(async ([path, loader]) => {
      try {
        const module = await loader();
        const template = module.default;
        if (template && template.model_id) {
          BUILTIN_TEMPLATES.set(template.model_id, expand_port_row_modules(template));
          return;
        }
        const fallback_id = model_id_from_path(path);
        if (template) {
          BUILTIN_TEMPLATES.set(fallback_id, {
            ...expand_port_row_modules(template),
            model_id: fallback_id
          } as DeviceTemplate);
        }
      } catch (error) {
        console.warn('设备模板加载失败：' + path, error);
      }
    })
  );
}

/**
 * 确保模板已加载（幂等）。
 *
 * @returns {Promise<void>} 加载完成。
 */
export async function ensure_templates_loaded(): Promise<void> {
  if (loaded) {
    return;
  }
  if (!loading) {
    loading = load_builtin_templates().then(() => {
      load_user_templates();
      loaded = true;
    });
  }
  await loading;
}

/**
 * 从 localStorage 载入用户模板。
 *
 * @returns {void}
 */
function load_user_templates(): void {
  try {
    const raw = window.localStorage.getItem(USER_TEMPLATE_STORAGE_KEY);
    if (!raw) {
      return;
    }
    const parsed = JSON.parse(raw) as DeviceTemplate[];
    for (const template of parsed) {
      if (template && template.model_id) {
        const normalized = normalize_legacy_rotation_units(template);
        USER_TEMPLATES.set(template.model_id, {
          ...expand_port_row_modules(normalized),
          origin: 'user'
        });
      }
    }
  } catch (error) {
    console.warn('用户设备模板读取失败', error);
  }
}

/**
 * 保存用户模板到 localStorage。
 *
 * @returns {void}
 */
function persist_user_templates(): void {
  try {
    window.localStorage.setItem(
      USER_TEMPLATE_STORAGE_KEY,
      JSON.stringify([...USER_TEMPLATES.values()])
    );
  } catch (error) {
    console.warn('用户设备模板保存失败', error);
  }
}

/**
 * 取模板（内置优先，其次用户模板）。
 *
 * @param {string} model_id 型号 ID。
 * @returns {DeviceTemplate | null} 模板；不存在时为 null。
 */
export function get_template(model_id: string): DeviceTemplate | null {
  /* 用户模板（工坊保存）优先于内置模板：否则编辑内置型号后主场景会"还原"。 */
  return USER_TEMPLATES.get(model_id) || BUILTIN_TEMPLATES.get(model_id) || null;
}

/**
 * 全部模板（内置 + 用户）。
 *
 * @returns {DeviceTemplate[]} 模板列表。
 */
export function list_templates(): DeviceTemplate[] {
  const merged = new Map<string, DeviceTemplate>();
  for (const template of BUILTIN_TEMPLATES.values()) {
    merged.set(template.model_id, template);
  }
  for (const template of USER_TEMPLATES.values()) {
    merged.set(template.model_id, template);
  }

  return [...merged.values()];
}

/**
 * 模板缓存键：型号 + 版本，用于主场景判断"模板是否被工坊改过"。
 *
 * @param {string} model_id 型号 ID。
 * @returns {string} 缓存键（模板不存在时为空串）。
 */
export function template_cache_key(model_id: string): string {
  const template = get_template(model_id);

  return template
    ? template.model_id + '@' + (template.origin || 'builtin') + ':' + (template.version || 1)
    : '';
}

/**
 * 判断某型号是否为用户模板（工坊产出或编辑过的内置模板）。
 *
 * @param {string} model_id 型号 ID。
 * @returns {boolean} 是否为用户模板。
 */
export function is_user_template(model_id: string): boolean {
  return USER_TEMPLATES.has(model_id);
}

/**
 * 用户模板列表。
 *
 * @returns {DeviceTemplate[]} 用户模板。
 */
export function list_user_templates(): DeviceTemplate[] {
  return [...USER_TEMPLATES.values()];
}

/**
 * 按厂商分组列出模板（设备栏展示用）。
 *
 * @returns {{vendor_id: string; templates: DeviceTemplate[]}[]} 分组结果。
 */
export function templates_by_vendor(): { vendor_id: string; templates: DeviceTemplate[] }[] {
  const groups = new Map<string, DeviceTemplate[]>();
  for (const template of list_templates()) {
    const bucket = groups.get(template.vendor_id) || [];
    bucket.push(template);
    groups.set(template.vendor_id, bucket);
  }

  return [...groups.entries()].map(([vendor_id, templates]) => ({
    vendor_id: vendor_id,
    templates: templates
  }));
}

/**
 * 保存用户模板（新增或覆盖）。
 *
 * @param {DeviceTemplate} template 模板。
 * @returns {DeviceTemplate} 保存后的模板（版本号已递增）。
 */
export function save_user_template(template: DeviceTemplate): DeviceTemplate {
  const normalized = expand_port_row_modules(normalize_legacy_rotation_units(template));
  const existing = USER_TEMPLATES.get(normalized.model_id);
  const next: DeviceTemplate = {
    ...normalized,
    origin: 'user',
    version: (existing ? existing.version : template.version || 1) + (existing ? 1 : 0)
  };
  USER_TEMPLATES.set(next.model_id, next);
  persist_user_templates();
  /* 外观已变：清空缩略图缓存，设备栏下次渲染会画新图。 */
  THUMBNAIL_CACHE_CLEAR = true;

  return next;
}

/**
 * 取出并清除"模板已变更"标记（设备栏据此重绘缩略图）。
 *
 * @returns {boolean} 是否有模板变更。
 */
export function consume_template_dirty(): boolean {
  const dirty = THUMBNAIL_CACHE_CLEAR;
  THUMBNAIL_CACHE_CLEAR = false;

  return dirty;
}

/**
 * 删除用户模板。
 *
 * @param {string} model_id 型号 ID。
 * @returns {boolean} 是否删除成功（内置模板不可删除）。
 */
export function delete_user_template(model_id: string): boolean {
  if (!USER_TEMPLATES.has(model_id)) {
    return false;
  }
  USER_TEMPLATES.delete(model_id);
  persist_user_templates();

  return true;
}

/**
 * 基于现有模板复制一份新模板（"以某型号为原型新建"）。
 *
 * @param {string} source_model_id 源型号 ID。
 * @param {string} new_model_id 新型号 ID。
 * @param {string} display_name 新显示名。
 * @returns {DeviceTemplate | null} 新模板；源模板不存在时为 null。
 */
export function clone_template(
  source_model_id: string,
  new_model_id: string,
  display_name: string
): DeviceTemplate | null {
  const source = get_template(source_model_id);
  if (!source) {
    return null;
  }

  return {
    ...source,
    model_id: new_model_id,
    display_name: display_name,
    parts: source.parts.map((part) => ({
      ...part,
      params: { ...part.params },
      transform: part.transform ? { ...part.transform } : undefined
    })),
    ports: source.ports.map((port) => ({ ...port })),
    leds: source.leds.map((led) => ({ ...led })),
    origin: 'user',
    version: 1,
    description: '基于 ' + source.model_id + ' 复制'
  };
}

/**
 * 导出全部用户模板为 JSON 文本。
 *
 * @returns {string} JSON 文本。
 */
export function export_user_templates(): string {
  return JSON.stringify(list_user_templates(), null, 2);
}

/**
 * 导入用户模板 JSON。
 *
 * @param {string} json JSON 文本。
 * @returns {number} 导入数量。
 */
export function import_user_templates(json: string): number {
  const parsed = JSON.parse(json) as DeviceTemplate[];
  let count = 0;
  for (const template of parsed) {
    if (template && template.model_id) {
      USER_TEMPLATES.set(template.model_id, {
        ...normalize_legacy_rotation_units(template),
        origin: 'user'
      });
      count += 1;
    }
  }
  persist_user_templates();

  return count;
}

/** 测试辅助：清空用户模板。 */
export function clear_user_templates(): void {
  USER_TEMPLATES.clear();
  persist_user_templates();
}
