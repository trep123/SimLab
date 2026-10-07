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

import { DeviceRuntime } from '../src/core/device_runtime';
import { get_registry } from '../src/data/assets';
import { assemble_device } from '../src/devices/assembler';
import { ensure_templates_loaded, get_template } from '../src/devices/registry';
import { DeviceObject } from '../src/scene/device_builder';

const models = [
  'ruijie-rg-s2910-24gt4xs',
  'ruijie-rg-s5750c-28gt4xs-h',
  'cisco-c2960x-24ts-l',
  'h3c-s5130s-28s-ei',
  'h3c-s5560x-30c-ei',
  'huawei-s5731-s24t4x',
  'huawei-s5731-s24p4x'
];

describe('交换机实物网口与连线端口一致', () => {
  beforeAll(async () => {
    vi.stubGlobal('window', { localStorage: { getItem: () => null } });
    await ensure_templates_loaded();
  });

  it.each(models)('%s 第一列上下口分别是 1/2，第二列是 3/4', (model_id) => {
    const template = get_template(model_id)!;
    const ge = assemble_device(template).port_anchors.filter((port) => port.group_id === 'ge');
    expect(ge).toHaveLength(24);
    const columns = [...new Set(ge.map((port) => port.position.x))].sort((a, b) => a - b);
    const names_at = (x: number) => ge.filter((port) => port.position.x === x)
      .sort((a, b) => b.position.y - a.position.y)
      .map((port) => port.short_name);
    const first_name = ge.find((port) => port.short_name.endsWith('/1'))!.short_name;
    const prefix = first_name.slice(0, -1);
    expect(names_at(columns[0])).toEqual([`${prefix}1`, `${prefix}2`]);
    expect(names_at(columns[1])).toEqual([`${prefix}3`, `${prefix}4`]);
    expect(new Set(ge.map((port) => port.short_name)).size).toBe(24);
  });

  it('斜视角点击第一列上下口时命中各自的真实接口', () => {
    const registry = get_registry();
    const manifest = registry.manifest(models[0])!;
    const vendor_profile = registry.vendor(manifest.vendor_id);
    const runtime = new DeviceRuntime({
      device_id: 'switch-1', experiment_id: 'exp-test', manifest,
      vendor_profile, cli_profile: registry.cli_profile_for_vendor(manifest.vendor_id)
    });
    const device = new DeviceObject({ manifest, vendor_profile, runtime_device: runtime });
    device.group.updateMatrixWorld(true);
    const meshes = device.port_visuals.flatMap((visual) => visual.pickable_meshes());
    const port_for_mesh = new Map(device.port_visuals.flatMap((visual) =>
      visual.pickable_meshes().map((mesh) => [mesh, visual.definition.short_name] as const)));

    for (const short_name of ['Gi0/1', 'Gi0/2']) {
      const target = device.anchor_for(short_name)!.position;
      const camera = target.clone().add(new THREE.Vector3(15, 0, 15));
      const ray = new THREE.Raycaster(camera, target.clone().sub(camera).normalize());
      const first_hit = ray.intersectObjects(meshes, false)[0];
      expect(first_hit, `${short_name} should be clickable`).toBeDefined();
      expect(port_for_mesh.get(first_hit.object), `${short_name} should hit its socket`).toBe(short_name);
    }
  });
});
