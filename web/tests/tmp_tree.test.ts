/**
 * @File : web/tests/tmp_tree.test.ts
 * @Time : 2026-10-07 13:00
 * @Author : Cetrp
 * @Description : 临时诊断：遍历全部模板装配结果，定位子节点 undefined 导致的渲染异常。
 */

import { describe, it } from 'vitest';

import * as THREE from 'three';

import { assemble_device } from '../src/devices/assembler';
import { build_template_device } from '../src/devices/template_device';
import { list_templates, ensure_templates_loaded } from '../src/devices/registry';

describe('装配树健康检查', () => {
  it('全部模板不会产生 undefined 子节点', async () => {
    (globalThis as unknown as { window: unknown }).window = {
      localStorage: { getItem: () => null, setItem: () => undefined }
    };
    await ensure_templates_loaded();
    for (const template of list_templates()) {
      const assembled = assemble_device(template);
      let count = 0;
      assembled.group.traverse((object) => {
        count += 1;
        for (const child of object.children) {
          if (!child) {
            throw new Error(template.model_id + ' 存在 undefined 子节点');
          }
        }
      });
      const build = build_template_device(template, { scale: 1 });
      const box = new THREE.Box3().setFromObject(build.group);
      console.log(
        template.model_id.padEnd(28),
        'parts',
        String(assembled.removable_parts.length).padStart(2),
        'anchors',
        String(assembled.port_anchors.length).padStart(2),
        'nodes',
        String(count).padStart(4),
        'size',
        [box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z]
          .map((v) => v.toFixed(2))
          .join('x')
      );
    }
  });
});
