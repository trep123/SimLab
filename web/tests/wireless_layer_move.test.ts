import * as THREE from 'three';
import { afterEach, expect, it, vi } from 'vitest';

import { WirelessLayer } from '../src/scene/wireless_layer';

afterEach(() => vi.unstubAllGlobals());

it('AP 拖动及无线状态刷新后，覆盖圈各层都跟随设备', () => {
  vi.stubGlobal('document', {
    createElement: () => ({ width: 0, height: 0, getContext: () => null })
  });
  const layer = new WirelessLayer();
  layer.update_access_point('ap-1', 20, 0.2, new THREE.Vector3(1, 0, 2));
  const visuals = layer.group.children.filter((object) =>
    object instanceof THREE.Line ||
    (object instanceof THREE.Mesh &&
      (object.geometry instanceof THREE.RingGeometry ||
       object.geometry instanceof THREE.CircleGeometry))
  );
  expect(visuals).toHaveLength(3);

  layer.move_access_point('ap-1', new THREE.Vector3(8, 0, 9));
  for (const visual of visuals) {
    expect(visual.position.x).toBe(8);
    expect(visual.position.z).toBe(9);
  }

  layer.update_access_point('ap-1', 20, 0.8, new THREE.Vector3(-3, 0, 4));
  for (const visual of visuals) {
    expect(visual.position.x).toBe(-3);
    expect(visual.position.z).toBe(4);
  }
  layer.dispose();
});
