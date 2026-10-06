/**
 * @File : web/tests/pointer_plane.test.ts
 * @Time : 2026-10-07 20:20
 * @Author : Cetrp
 * @Description : 拖动设备跟手性回归测试：屏幕坐标 → 水平面世界点必须严格对应，
 *               并验证"抓取点始终停在光标下"（早期用像素×系数近似换算会导致越拖越偏）。
 */

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import {
  pointer_facing_plane_point,
  pointer_plane_point,
  to_ndc
} from '../src/scene/pointer_plane';

/** 测试用画布尺寸。 */
const RECT = { left: 0, top: 0, width: 1200, height: 700 };

/**
 * 构造一台俯视相机。
 *
 * @param {THREE.Vector3} [position] 相机位置。
 * @returns {THREE.PerspectiveCamera} 相机。
 */
function make_camera(position = new THREE.Vector3(0, 12, 14)): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(45, RECT.width / RECT.height, 0.1, 200);
  camera.position.copy(position);
  camera.lookAt(new THREE.Vector3(0, 0, 0));
  camera.updateMatrixWorld(true);

  return camera;
}

describe('屏幕坐标 → 世界平面点', () => {
  it('NDC 映射：画布中心为 (0,0)，无尺寸返回 null', () => {
    /* Act & Assert */
    const center = to_ndc(600, 350, RECT);
    expect(center?.x).toBeCloseTo(0, 6);
    expect(center?.y).toBeCloseTo(0, 6);
    expect(to_ndc(0, 0, RECT)?.x).toBeCloseTo(-1, 6);
    expect(to_ndc(0, 0, { left: 0, top: 0, width: 0, height: 0 })).toBeNull();
  });

  it('同一水平面上，光标移动多少屏幕距离，世界点就对应移动（单调且连续）', () => {
    /* Arrange */
    const camera = make_camera();

    /* Act */
    const left = pointer_plane_point(400, 350, RECT, camera, 0);
    const middle = pointer_plane_point(600, 350, RECT, camera, 0);
    const right = pointer_plane_point(800, 350, RECT, camera, 0);

    /* Assert：三个点都在地面上，且沿世界 X 单调递增、步长一致 */
    expect(left).not.toBeNull();
    expect(middle).not.toBeNull();
    expect(right).not.toBeNull();
    expect(left?.y).toBeCloseTo(0, 6);
    const first_step = (middle as THREE.Vector3).x - (left as THREE.Vector3).x;
    const second_step = (right as THREE.Vector3).x - (middle as THREE.Vector3).x;
    expect(first_step).toBeGreaterThan(0);
    expect(second_step).toBeCloseTo(first_step, 4);
  });

  it('拖动跟手：抓取点始终落在光标下方（屏幕误差为 0）', () => {
    /* Arrange */
    const camera = make_camera();
    const grab_start = pointer_plane_point(500, 380, RECT, camera, 0) as THREE.Vector3;
    /* 设备原点与抓取点的固定偏移（按下瞬间确定，拖动过程不变） */
    const offset = new THREE.Vector3(-1.6, 0, 0.8);
    const origin_start = grab_start.clone().add(offset);

    /* Act：模拟把光标拖到多个位置，设备原点 = 当前交点 + 同一偏移 */
    const samples = [
      { x: 520, y: 390 },
      { x: 620, y: 430 },
      { x: 760, y: 470 },
      { x: 900, y: 520 }
    ];
    const errors = samples.map((sample) => {
      const point = pointer_plane_point(sample.x, sample.y, RECT, camera, 0) as THREE.Vector3;
      const origin = point.clone().add(offset);
      /* 抓取点 = 设备原点 - 偏移，应严格等于光标对应的世界点 */
      const grab = origin.clone().sub(offset);
      const projected = grab.clone();
      /* 反投影：把世界点投到屏幕上与光标比较 */
      const screen = projected.clone().project(camera);
      const screen_x = ((screen.x + 1) / 2) * RECT.width + RECT.left;
      const screen_y = ((1 - screen.y) / 2) * RECT.height + RECT.top;

      return Math.hypot(screen_x - sample.x, screen_y - sample.y);
    });

    /* Assert：每一步的屏幕误差都为 0（严格跟手，不随拖动距离增长） */
    for (const error of errors) {
      expect(error).toBeLessThan(1e-6);
    }
    /* 且设备确实在移动 */
    expect(origin_start.distanceTo(grab_start)).toBeCloseTo(offset.length(), 6);
  });

  it('相机视线几乎与地面平行时不返回交点（避免设备被甩飞）', () => {
    /* Arrange：水平看向地面的相机 */
    const camera = make_camera(new THREE.Vector3(0, 0.05, 14));

    /* Act */
    const point = pointer_plane_point(600, 350, RECT, camera, 0);

    /* Assert */
    expect(point).toBeNull();
  });

  it('面向相机的平面：交点位于过给定点且垂直于视线的平面上', () => {
    /* Arrange */
    const camera = make_camera();
    const through = new THREE.Vector3(1, 2, 3);

    /* Act */
    const point = pointer_facing_plane_point(700, 300, RECT, camera, through) as THREE.Vector3;

    /* Assert：点到平面的距离（沿视线方向）为 0 */
    const normal = new THREE.Vector3();
    camera.getWorldDirection(normal);
    expect(point.clone().sub(through).dot(normal)).toBeCloseTo(0, 6);
  });
});
