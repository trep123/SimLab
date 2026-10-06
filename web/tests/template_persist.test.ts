/**
 * @File : web/tests/template_persist.test.ts
 * @Time : 2026-10-07 17:10
 * @Author : Cetrp
 * @Description : 设备模板持久化回归测试：工坊保存后用户模板必须覆盖内置模板，
 *               缓存键必须变化（主场景据此重建几何），删除后回到内置模板。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clear_user_templates,
  consume_template_dirty,
  delete_user_template,
  ensure_templates_loaded,
  get_template,
  list_templates,
  save_user_template,
  template_cache_key
} from '../src/devices/registry';

import type { DeviceTemplate } from '../src/devices/template_types';

/**
 * 安装内存版 localStorage。
 *
 * @returns {Map<string, string>} 存储表。
 */
function install_storage(): Map<string, string> {
  const storage = new Map<string, string>();
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string) => (storage.has(key) ? (storage.get(key) as string) : null),
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key)
    }
  });

  return storage;
}

/**
 * 构造工坊草稿（模拟"编辑内置型号"）。
 *
 * @param {string} model_id 型号 ID。
 * @returns {DeviceTemplate} 草稿模板。
 */
function draft_of(model_id: string): DeviceTemplate {
  const source = get_template(model_id) as DeviceTemplate;
  const first_network_port = source.parts.find((part) => part.kind === 'network_port')?.part_id;

  return {
    ...source,
    parts: source.parts.map((part) =>
      part.part_id === first_network_port
        ? { ...part, params: { ...part.params, speed_bps: 100_000_000 } }
        : { ...part }
    )
  };
}

describe('设备模板持久化与主场景刷新', () => {
  beforeEach(async () => {
    install_storage();
    await ensure_templates_loaded();
    clear_user_templates();
  });

  it('工坊保存后用户模板覆盖内置模板（不再"还原"）', () => {
    /* Arrange */
    const model_id = 'huawei-s5731-s24t4x';
    const builtin = get_template(model_id) as DeviceTemplate;
    const speed_before = builtin.parts.find((part) => part.kind === 'network_port')?.params.speed_bps;

    /* Act */
    const saved = save_user_template(draft_of(model_id));

    /* Assert */
    expect(saved.origin).toBe('user');
    const now = get_template(model_id) as DeviceTemplate;
    expect(now.origin).toBe('user');
    expect(now.parts.find((part) => part.kind === 'network_port')?.params.speed_bps).toBe(100_000_000);
    expect(speed_before).not.toBe(100_000_000);
  });

  it('保存前后缓存键变化（主场景据此原地重建几何）', () => {
    /* Arrange */
    const model_id = 'huawei-s5731-s24t4x';
    const key_before = template_cache_key(model_id);

    /* Act */
    save_user_template(draft_of(model_id));
    const key_after = template_cache_key(model_id);

    /* Assert */
    expect(key_before).not.toBe(key_after);
    expect(key_after).toContain('user');
  });

  it('列表按型号去重，用户版本胜出', () => {
    /* Arrange */
    const model_id = 'generic-onu-gpon';

    /* Act */
    save_user_template(draft_of(model_id));
    const matched = list_templates().filter((item) => item.model_id === model_id);

    /* Assert */
    expect(matched.length).toBe(1);
    expect(matched[0].origin).toBe('user');
  });

  it('保存会置位变更标记（用于清空缩略图缓存）', () => {
    /* Arrange */
    consume_template_dirty();

    /* Act */
    save_user_template(draft_of('cisco-c2960x-24ts-l'));

    /* Assert */
    expect(consume_template_dirty()).toBe(true);
    expect(consume_template_dirty()).toBe(false);
  });

  it('删除用户模板后回到内置模板', () => {
    /* Arrange */
    const model_id = 'h3c-msr3600-28';
    save_user_template(draft_of(model_id));

    /* Act */
    const removed = delete_user_template(model_id);
    const restored = get_template(model_id) as DeviceTemplate;

    /* Assert */
    expect(removed).toBe(true);
    expect(restored.origin).toBe('builtin');
  });
});
