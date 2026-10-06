/**
 * @File : web/tests/assets.test.ts
 * @Description : 规格资产完整性回归测试，防止部署时漏掉 catalog/vendor/cli 后目录静默为空。
 */

import { describe, expect, it } from 'vitest';

import { get_registry, load_assets } from '../src/data/assets';

describe('内置规格资产', () => {
  it('加载全部设备、厂商与 CLI 档案', () => {
    const assets = load_assets();
    const registry = get_registry();

    expect(assets.catalog).toHaveLength(21);
    expect(assets.vendors).toHaveLength(5);
    expect(assets.cli).toHaveLength(5);
    expect(registry.model_count()).toBe(21);
    expect(registry.vendor_count()).toBe(5);
    expect(registry.errors()).toEqual([]);
  });

  it('拖放默认型号所需的 Manifest 与 CLI 均可查询', () => {
    const registry = get_registry();
    const manifest = registry.manifest('huawei-s5731-s24t4x');

    expect(manifest?.visual.port_layout).toHaveLength(2);
    expect(registry.cli_profile_for_vendor(manifest?.vendor_id || '')).toBeTruthy();
  });
});
