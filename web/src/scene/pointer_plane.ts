/**
 * @File : web/src/scene/pointer_plane.ts
 * @Time : 2026-10-07 20:10
 * @Author : Cetrp
 * @Description : 屏幕坐标 → 世界平面点的纯函数映射：拖动设备时用"指针射线与设备所在水平面求交"
 *               得到真实的跟手位置，取代早期"像素 × 相机半径系数"的近似换算
 *               （近似换算会导致拖得越远偏差越大）。
 */

import * as THREE from 'three';

/** 画布尺寸（与 DOMRect 对齐，便于无 DOM 环境测试）。 */
export interface CanvasRect {
  /** 左边界（CSS 像素）。 */
  left: number;
  /** 上边界（CSS 像素）。 */
  top: number;
  /** 宽度（CSS 像素）。 */
  width: number;
  /** 高度（CSS 像素）。 */
  height: number;
}

/**
 * 把屏幕坐标转换成归一化设备坐标（NDC）。
 *
 * @param {number} client_x 屏幕 X（CSS 像素）。
 * @param {number} client_y 屏幕 Y（CSS 像素）。
 * @param {CanvasRect} rect 画布矩形。
 * @returns {THREE.Vector2 | null} NDC 坐标；画布无尺寸时返回 null。
 */
export function to_ndc(client_x: number, client_y: number, rect: CanvasRect): THREE.Vector2 | null {
  if (rect.width <= 0 || rect.height <= 0) {
    return null;
  }

  return new THREE.Vector2(
    ((client_x - rect.left) / rect.width) * 2 - 1,
    -((client_y - rect.top) / rect.height) * 2 + 1
  );
}

/**
 * 屏幕坐标 → 水平面上的世界点（射线与 y = plane_y 平面求交）。
 *
 * @param {number} client_x 屏幕 X。
 * @param {number} client_y 屏幕 Y。
 * @param {CanvasRect} rect 画布矩形。
 * @param {THREE.Camera} camera 相机。
 * @param {number} plane_y 平面高度（世界 Y）。
 * @returns {THREE.Vector3 | null} 交点；射线与平面近乎平行或画布无尺寸时返回 null。
 */
export function pointer_plane_point(
  client_x: number,
  client_y: number,
  rect: CanvasRect,
  camera: THREE.Camera,
  plane_y: number
): THREE.Vector3 | null {
  const pointer = to_ndc(client_x, client_y, rect);
  if (!pointer) {
    return null;
  }
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(pointer, camera);
  /* 视线几乎与地面平行时求交会极端放大 → 视为无效，避免设备被"甩飞"。 */
  if (Math.abs(raycaster.ray.direction.y) < 0.08) {
    return null;
  }
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -plane_y);
  const point = new THREE.Vector3();

  return raycaster.ray.intersectPlane(plane, point) ? point : null;
}

/**
 * 屏幕坐标 → 过指定点且面向相机的平面上的世界点（拖拽 1:1 跟随鼠标）。
 *
 * @param {number} client_x 屏幕 X。
 * @param {number} client_y 屏幕 Y。
 * @param {CanvasRect} rect 画布矩形。
 * @param {THREE.Camera} camera 相机。
 * @param {THREE.Vector3} through 平面经过的点。
 * @returns {THREE.Vector3 | null} 交点。
 */
export function pointer_facing_plane_point(
  client_x: number,
  client_y: number,
  rect: CanvasRect,
  camera: THREE.Camera,
  through: THREE.Vector3
): THREE.Vector3 | null {
  const pointer = to_ndc(client_x, client_y, rect);
  if (!pointer) {
    return null;
  }
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(pointer, camera);
  const normal = new THREE.Vector3();
  camera.getWorldDirection(normal);
  const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, through);
  const point = new THREE.Vector3();

  return raycaster.ray.intersectPlane(plane, point) ? point : null;
}
