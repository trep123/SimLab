/**
 * @File : web/src/data/assets.ts
 * @Time : 2026-10-05 04:20
 * @Author : Cetrp
 * @Description : 规格资产装载：Vite 通过 import.meta.glob 内联 assets/ 下的厂商、型号与 CLI 档案。
 */

import { SpecRegistry } from './spec_loader';

import type { CliProfile, DeviceManifest, VendorProfile } from './types';

/** 资产集合。 */
export interface SimlabAssets {
  vendors: VendorProfile[];
  catalog: DeviceManifest[];
  cli: CliProfile[];
}

/* 使用 Vite 的 glob 导入，构建时静态内联，离线单文件模式同样可用。 */
const vendor_modules = import.meta.glob('@assets/vendor/*.json', {
  eager: true,
  import: 'default'
});
const catalog_modules = import.meta.glob('@assets/catalog/*.json', {
  eager: true,
  import: 'default'
});
const cli_modules = import.meta.glob('@assets/cli/*.json', { eager: true, import: 'default' });

/**
 * 装载全部规格资产。
 *
 * @returns {SimlabAssets} 资产集合（按文件名排序，保证顺序稳定）。
 */
export function load_assets(): SimlabAssets {
  const sort_by_key = <T>(entries: Record<string, unknown>, key: (item: T) => string): T[] =>
    Object.keys(entries)
      .sort()
      .map((path) => entries[path] as T)
      .sort((left, right) => key(left).localeCompare(key(right)));

  return {
    vendors: sort_by_key<VendorProfile>(vendor_modules, (item) => item.vendor_id),
    catalog: sort_by_key<DeviceManifest>(catalog_modules, (item) => item.model_id),
    cli: sort_by_key<CliProfile>(cli_modules, (item) => item.profile_id)
  };
}

/** 全局规格注册表（进程内单例）。 */
let registry_instance: SpecRegistry | null = null;

/**
 * 获取规格注册表单例。
 *
 * @returns {SpecRegistry} 注册表。
 */
export function get_registry(): SpecRegistry {
  if (!registry_instance) {
    registry_instance = new SpecRegistry(load_assets());
  }
  return registry_instance;
}
