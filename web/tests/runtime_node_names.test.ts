import { describe, expect, it } from 'vitest';

import { plan_runtime_node_names } from '../src/core/runtime_node_names';

describe('批量网络节点命名', () => {
  it('跳过实验中已有名称并保留用户选择的前缀大小写', () => {
    expect(plan_runtime_node_names('router1', 3, ['router1', 'router3']))
      .toEqual(['router2', 'router4', 'router5']);
    expect(plan_runtime_node_names('R1', 2, ['r1'])).toEqual(['R2', 'R3']);
  });

  it('限制数量和名称格式', () => {
    expect(() => plan_runtime_node_names('router1', 21, [])).toThrow('BATCH_COUNT_INVALID');
    expect(() => plan_runtime_node_names('1router', 1, [])).toThrow('NODE_NAME_INVALID');
  });
});
