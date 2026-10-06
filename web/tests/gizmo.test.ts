/**
 * @File : web/tests/gizmo.test.ts
 * @Time : 2026-10-07 17:30
 * @Author : Cetrp
 * @Description : 变换 Gizmo 单元测试：模式切换、手柄语义、按轴拖拽增量与提交回调。
 */

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { TransformGizmo } from '../src/editor/transform_gizmo';

/**
 * 构造沿给定方向射出的射线。
 *
 * @param {THREE.Vector3} origin 起点。
 * @param {THREE.Vector3} direction 方向。
 * @returns {THREE.Raycaster} 射线。
 */
function raycaster_from(origin: THREE.Vector3, direction: THREE.Vector3): THREE.Raycaster {
  const raycaster = new THREE.Raycaster();
  raycaster.set(origin, direction.clone().normalize());

  return raycaster;
}

describe('变换 Gizmo', () => {
  it('切换模式时只显示对应的手柄组', () => {
    /* Arrange */
    const gizmo = new TransformGizmo();

    /* Act & Assert：默认移动 */
    expect(gizmo.mode).toBe('translate');
    expect(gizmo.group.visible).toBe(true);

    /* Act：切到旋转与缩放 */
    gizmo.set_mode('rotate');
    const rotate_visible = gizmo.group.children.filter((child) => child.visible).length;
    gizmo.set_mode('none');

    /* Assert */
    expect(rotate_visible).toBe(1);
    expect(gizmo.group.visible).toBe(false);
    gizmo.dispose();
  });

  it('手柄带轴语义（X/Y/Z 与均匀缩放）', () => {
    /* Arrange */
    const gizmo = new TransformGizmo();
    gizmo.set_mode('scale');
    const handles = new Set<string>();

    /* Act */
    gizmo.group.traverse((object) => {
      const handle = gizmo.handle_of(object);
      if (handle) {
        handles.add(handle.type + ':' + handle.axis);
      }
    });

    /* Assert */
    expect(handles.has('axis:0')).toBe(true);
    expect(handles.has('axis:1')).toBe(true);
    expect(handles.has('axis:2')).toBe(true);
    expect(handles.has('uniform:1')).toBe(true);
    gizmo.dispose();
  });

  it('按轴拖拽产生平移增量并在松手时提交', () => {
    /* Arrange */
    const gizmo = new TransformGizmo();
    gizmo.set_mode('translate');
    const commits: number[] = [];
    gizmo.on_commit = (delta) => commits.push(delta.translate.x);
    /* 用垂直于 X 轴的射线打向轴线，避免"射线与轴平行"的退化情形。 */
    const handle = { type: 'axis' as const, axis: 0 };
    const start = raycaster_from(new THREE.Vector3(-2, 3, 0), new THREE.Vector3(0, -1, 0));

    /* Act */
    const begun = gizmo.begin(handle, start);
    const moved = gizmo.move(
      raycaster_from(new THREE.Vector3(1, 3, 0), new THREE.Vector3(0, -1, 0))
    );
    const committed = gizmo.end();

    /* Assert */
    expect(begun).toBe(true);
    expect(moved).not.toBeNull();
    expect(committed).not.toBeNull();
    expect(commits.length).toBe(1);
    expect((moved as { translate: THREE.Vector3 }).translate.x).toBeCloseTo(3, 3);
    gizmo.dispose();
  });

  it('缩放手柄按轴向给出倍数增量', () => {
    /* Arrange */
    const gizmo = new TransformGizmo();
    gizmo.set_mode('scale');
    const handle = { type: 'axis' as const, axis: 1 };

    /* Act */
    /* 射线垂直于 Y 轴（与轴平行的射线会退化）。 */
    gizmo.begin(
      handle,
      raycaster_from(new THREE.Vector3(2, -2, 0), new THREE.Vector3(-1, 0, 0))
    );
    const moved = gizmo.move(
      raycaster_from(new THREE.Vector3(2, 2, 0), new THREE.Vector3(-1, 0, 0))
    );

    /* Assert */
    expect(moved).not.toBeNull();
    expect((moved as { scale: THREE.Vector3 }).scale.y).toBeCloseTo(5, 3);
    gizmo.dispose();
  });

  it('屏幕尺寸恒定：距离越远缩放越大', () => {
    /* Arrange */
    const gizmo = new TransformGizmo();
    const camera = new THREE.PerspectiveCamera(45, 1, 0.001, 100);

    /* Act */
    camera.position.set(0, 0, 2);
    gizmo.place(new THREE.Vector3(0, 0, 0), camera);
    const near_scale = gizmo.group.scale.x;
    camera.position.set(0, 0, 8);
    gizmo.place(new THREE.Vector3(0, 0, 0), camera);

    /* Assert */
    expect(gizmo.group.scale.x).toBeGreaterThan(near_scale);
    gizmo.dispose();
  });
});
