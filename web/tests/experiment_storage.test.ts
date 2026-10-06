import { describe, expect, it } from 'vitest';

import {
  delete_saved_experiment,
  list_saved_experiments,
  load_saved_experiment,
  save_experiment_document
} from '../src/core/experiment_storage';
import { normalize_render_settings, resolve_render_profile } from '../src/core/render_settings';

import type { SavedExperiment } from '../src/core/experiment_storage';

function memory_storage(): {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
} {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, value)
  };
}

function experiment(updated_at = '2026-10-05T04:00:00.000Z'): SavedExperiment {
  return {
    schema_version: '1.0',
    experiment_id: 'exp-test-save',
    name: '交换与路由实验',
    created_at: '2026-10-05T03:00:00.000Z',
    updated_at: updated_at,
    devices: [
      {
        device_id: 'dev-017',
        model_id: 'huawei-s5731-s24t4x',
        hostname: 'SW-Core',
        position: { x: 2, y: 0, z: -3 },
        power_on: true,
        ports: [
          {
            short_name: 'GE0/0/1',
            admin_up: true,
            vlan: 20,
            speed_mode: 'auto',
            duplex: 'full',
            poe_enabled: false,
            description: 'uplink'
          }
        ]
      }
    ],
    cables: [],
    cable_labels: { 'cab-0009': { from: '核心', to: '出口' } },
    cable_waypoints: { 'cab-0009': [[0, 1, 2]] },
    scene: {
      view: 'iso',
      display_mode: 'shell',
      flow_enabled: true,
      auto_rotate: false,
      render: {
        quality: 'medium',
        shadows_enabled: true,
        lighting_enabled: true,
        lighting_intensity: 1.15,
        exposure: 0.91
      }
    }
  };
}

describe('实验文档持久化', () => {
  it('保存后可列出并无损读取设备、走线和画面设置', () => {
    const storage = memory_storage();
    save_experiment_document(experiment(), storage);

    const summaries = list_saved_experiments(storage);
    const restored = load_saved_experiment('exp-test-save', storage);

    expect(summaries).toEqual([
      expect.objectContaining({ name: '交换与路由实验', device_count: 1, cable_count: 0 })
    ]);
    expect(restored.devices[0].device_id).toBe('dev-017');
    expect(restored.devices[0].ports[0].vlan).toBe(20);
    expect(restored.cable_waypoints['cab-0009']).toEqual([[0, 1, 2]]);
    expect(restored.scene.render.lighting_intensity).toBe(1.15);
  });

  it('同一实验再次保存会覆盖旧版本而不产生重复项', () => {
    const storage = memory_storage();
    save_experiment_document(experiment(), storage);
    const newer = experiment('2026-10-05T05:00:00.000Z');
    newer.name = '更新后的实验';
    save_experiment_document(newer, storage);

    expect(list_saved_experiments(storage)).toHaveLength(1);
    expect(load_saved_experiment('exp-test-save', storage).name).toBe('更新后的实验');
  });

  it('保存模型关联并拒绝格式错误的关联', () => {
    const storage = memory_storage();
    const document = experiment();
    document.wireless_associations = [
      { sta_device_id: 'laptop-1', ap_device_id: 'ap-1' }
    ];
    save_experiment_document(document, storage);

    expect(load_saved_experiment('exp-test-save', storage).wireless_associations).toEqual([
      { sta_device_id: 'laptop-1', ap_device_id: 'ap-1' }
    ]);
    document.wireless_associations = [{ sta_device_id: '', ap_device_id: 'ap-1' }];
    expect(() => save_experiment_document(document, storage)).toThrow('实验数据不完整');
    expect(load_saved_experiment('exp-test-save', storage).wireless_associations).toHaveLength(1);
  });

  it('删除只移除指定实验', () => {
    const storage = memory_storage();
    save_experiment_document(experiment(), storage);
    const second = experiment();
    second.experiment_id = 'exp-second';
    second.name = '第二个实验';
    save_experiment_document(second, storage);

    delete_saved_experiment('exp-test-save', storage);

    expect(list_saved_experiments(storage).map((item) => item.experiment_id)).toEqual(['exp-second']);
  });
});

describe('低配画质预算', () => {
  it('低画质限制像素比、帧率、VNC 上传并关闭环境反射', () => {
    const profile = resolve_render_profile('low');
    expect(profile.pixel_ratio).toBeLessThan(1);
    expect(profile.target_fps).toBe(30);
    expect(profile.vnc_fps).toBe(8);
    expect(profile.environment_enabled).toBe(false);
  });

  it('损坏或越界的画面设置会回到安全范围', () => {
    const settings = normalize_render_settings({
      quality: 'unknown' as 'high',
      lighting_intensity: 99,
      exposure: -3
    });
    expect(settings.quality).toBe('auto');
    expect(settings.lighting_intensity).toBe(1.8);
    expect(settings.exposure).toBe(0.45);
  });
});
