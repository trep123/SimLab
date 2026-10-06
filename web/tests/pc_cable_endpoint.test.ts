import * as THREE from 'three';
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../src/scene/textures', async () => {
  const three = await import('three');
  const make_texture = () => new three.Texture();
  return {
    SceneTextures: {
      make_brushed: make_texture,
      make_brushed_rough: make_texture,
      make_pcb: make_texture,
      make_top: make_texture,
      make_side: make_texture,
      make_back: make_texture,
      make_front: make_texture
    }
  };
});

import { CableLayer } from '../src/cables/cable_layer';
import { DeviceRuntime } from '../src/core/device_runtime';
import { get_registry } from '../src/data/assets';
import { ensure_templates_loaded, get_template, save_user_template } from '../src/devices/registry';
import { desktop_port_keys } from '../src/core/desktop_ports';
import { DeviceObject } from '../src/scene/device_builder';
import { port_world_position } from '../src/scene/link_layer';

describe('PC 网线端点', () => {
  beforeAll(async () => {
    vi.stubGlobal('window', { localStorage: { getItem: () => null, setItem: () => undefined } });
    await ensure_templates_loaded();
  });

  it('预览和正式网线均使用主机背板 eth0 插座', () => {
    const registry = get_registry();
    const manifest = registry.manifest('generic-atx-pc');
    expect(manifest).toBeTruthy();
    if (!manifest) return;
    const runtime = new DeviceRuntime({
      device_id: 'pc-1',
      experiment_id: 'exp-test',
      manifest,
      vendor_profile: registry.vendor(manifest.vendor_id),
      cli_profile: registry.cli_profile_for_vendor(manifest.vendor_id)
    });
    const pc = new DeviceObject({
      manifest: runtime.manifest,
      vendor_profile: registry.vendor(manifest.vendor_id),
      runtime_device: runtime
    });
    const anchor = pc.anchor_for('eth0');
    expect(anchor).toBeTruthy();
    expect(pc.port_visuals.map((visual) => visual.definition.short_name)).toContain('eth0');
    const port = port_world_position(pc, 'eth0');
    expect(port?.distanceTo(anchor.position)).toBeLessThan(1e-5);
    const tower = pc.group.getObjectByName('pc_tower_shell')!;
    const tower_box = new THREE.Box3().setFromObject(tower);
    expect(port!.z).toBeLessThan(tower_box.min.z + 0.3);
    expect(port!.x).toBeGreaterThan(tower_box.min.x);
    expect(port!.x).toBeLessThan(tower_box.max.x);
    const keyboard = pc.group.getObjectByName('pc_keyboard');
    expect(keyboard).toBeTruthy();
    const keyboard_center = new THREE.Vector3();
    keyboard?.getWorldPosition(keyboard_center);
    expect(port?.distanceTo(keyboard_center)).toBeGreaterThan(5);

    const layer = new CableLayer();
    const kind = layer.create_preview('cat6', anchor, pc.group);
    expect(kind?.cable_id).toBe('cat6');
    const preview = layer.preview_cable();
    expect(preview?.endpoint_world('from').distanceTo(port!)).toBeLessThan(1e-5);
    expect(preview?.connector_object('from').position.distanceTo(port!)).toBeLessThan(0.4);
    layer.cancel_preview();
  });

  it('设备旋转和移动后，正式线缆仍插在主机背部接口', () => {
    const registry = get_registry();
    const manifest = registry.manifest('generic-atx-pc')!;
    const make_pc = (device_id: string) => new DeviceObject({
      manifest,
      vendor_profile: registry.vendor(manifest.vendor_id),
      runtime_device: new DeviceRuntime({
        device_id,
        experiment_id: 'exp-test',
        manifest,
        vendor_profile: registry.vendor(manifest.vendor_id),
        cli_profile: registry.cli_profile_for_vendor(manifest.vendor_id)
      })
    });
    const first = make_pc('pc-a');
    const second = make_pc('pc-b');
    first.group.position.set(5, 0, 2);
    first.group.rotation.y = Math.PI / 2;
    second.group.position.set(-5, 0, -2);
    second.group.rotation.y = Math.PI;
    const layer = new CableLayer();
    layer.sync([{
      cable_id: 'cable-a', cable_id_kind: 'cat6',
      from: { device_id: 'pc-a', port: 'eth0' },
      to: { device_id: 'pc-b', port: 'eth0' }, state: 'UP'
    }], new Map([['pc-a', first.group], ['pc-b', second.group]]), new Map([
      ['pc-a', first.port_anchors], ['pc-b', second.port_anchors]
    ]), 20);
    const cable = layer.get_cable('cable-a');
    expect(cable).toBeTruthy();
    expect(cable?.endpoint_world('from').distanceTo(port_world_position(first, 'eth0')!)).toBeLessThan(1e-5);
    expect(cable?.endpoint_world('to').distanceTo(port_world_position(second, 'eth0')!)).toBeLessThan(1e-5);
    const keyboard = first.group.getObjectByName('pc_keyboard')!;
    const keyboard_world = new THREE.Vector3();
    keyboard.getWorldPosition(keyboard_world);
    expect(cable?.endpoint_world('from').distanceTo(keyboard_world)).toBeGreaterThan(5);
  });

  it('新增 PC 网口既有背板锚点，也有稳定的虚拟网卡映射顺序', () => {
    const base = get_template('generic-atx-pc')!;
    const model_id = 'test-custom-pc-two-ports';
    save_user_template({
      ...structuredClone(base), model_id,
      parts: [...structuredClone(base.parts), {
        part_id: 'eth1', kind: 'network_port', category: 'port_module', label: '第二网口',
        params: { connector: 'rj45', short_name: 'LAN2', speed_bps: 1000000000,
          group_id: 'eth', position: [0.245, 0.03, -0.1778] },
        transform: { rotation: [0, Math.PI, 0] }
      }]
    });
    expect(desktop_port_keys(model_id)).toEqual(['eth0', 'LAN2']);
    const registry = get_registry();
    const manifest = { ...registry.manifest('generic-atx-pc')!, model_id };
    const runtime = new DeviceRuntime({
      device_id: 'pc-custom', experiment_id: 'exp-test', manifest,
      vendor_profile: registry.vendor(manifest.vendor_id),
      cli_profile: registry.cli_profile_for_vendor(manifest.vendor_id)
    });
    runtime.ports.push({ ...runtime.ports[0], short_name: 'LAN2' });
    const pc = new DeviceObject({
      manifest, vendor_profile: registry.vendor(manifest.vendor_id), runtime_device: runtime
    });
    expect(pc.anchor_for('LAN2')).toBeTruthy();
    expect(pc.port_visuals.map((visual) => visual.definition.short_name)).toContain('LAN2');
    expect(port_world_position(pc, 'LAN2')).toBeTruthy();
  });
});
