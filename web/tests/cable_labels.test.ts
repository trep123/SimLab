/**
 * @File : web/tests/cable_labels.test.ts
 * @Time : 2026-10-07 18:55
 * @Author : Cetrp
 * @Description : 线缆标签与打印清单测试：两端标号规则、HTML 转义、清单表格内容。
 */

import { describe, expect, it } from 'vitest';

import { build_cable_report_html, escape_html, label_map_for } from '../src/cables/cable_labels';

import type { CableRecord } from '../src/data/types';

/**
 * 构造线缆记录。
 *
 * @param {string} cable_id 线缆 ID。
 * @param {string} source_port 起点端口。
 * @param {string} target_port 终点端口。
 * @returns {CableRecord} 记录。
 */
function make_record(cable_id: string, source_port: string, target_port: string): CableRecord {
  return {
    cable_id: cable_id,
    cable_type: 'ETHERNET_COPPER',
    state: 'UP',
    length_m: 3.5,
    source: { device_id: 'dev-001', port: source_port },
    target: { device_id: 'dev-002', port: target_port }
  };
}

describe('线缆标签与清单', () => {
  it('两端标号：同一根线缆 A/B 序号一致，按顺序递增', () => {
    /* Arrange */
    const records = [
      make_record('cab-0001', 'GE0/0/1', 'GE1/0/1'),
      make_record('cab-0002', 'GE0/0/2', 'GE1/0/2'),
      make_record('cab-0010', 'GE0/0/3', 'GE1/0/3')
    ];

    /* Act */
    const labels = label_map_for(records);

    /* Assert */
    expect(labels.get('cab-0001')).toEqual({ from: 'A-01', to: 'B-01' });
    expect(labels.get('cab-0002')).toEqual({ from: 'A-02', to: 'B-02' });
    expect(labels.get('cab-0010')).toEqual({ from: 'A-03', to: 'B-03' });
  });

  it('HTML 转义：设备名里的尖括号与引号不会破坏清单结构', () => {
    /* Arrange */
    const records = [make_record('cab-0001', 'GE0/0/1', '<b>GE1</b>')];
    const names = new Map<string, string>([['dev-001', '<script>alert(1)</script>']]);

    /* Act */
    const html = build_cable_report_html({
      records: records,
      device_names: names,
      experiment_name: '实验 <A>',
      generated_at: '2026-10-07 19:00'
    });

    /* Assert */
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;b&gt;GE1&lt;/b&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('A-01');
    expect(html).toContain('B-01');
    expect(html).toContain('共 1 条');
  });

  it('清单包含两端标签、设备端口、长度与状态列', () => {
    /* Arrange */
    const records = [make_record('cab-0001', 'GE0/0/1', 'GE1/0/1')];
    const names = new Map<string, string>([
      ['dev-001', '核心交换机'],
      ['dev-002', '出口路由器']
    ]);

    /* Act */
    const html = build_cable_report_html({
      records: records,
      device_names: names,
      experiment_name: '演示实验',
      generated_at: '2026-10-07 19:00'
    });

    /* Assert */
    expect(html).toContain('核心交换机 · GE0/0/1');
    expect(html).toContain('出口路由器 · GE1/0/1');
    expect(html).toContain('3.5 m');
    expect(html).toContain('ETHERNET_COPPER');
    expect(html).toContain('<th>长度</th>');
  });

  it('自定义标签写回清单（空值回落默认编号）', () => {
    /* Arrange */
    const records = [make_record('cab-0001', 'GE0/0/1', 'GE1/0/1')];
    const names = new Map<string, string>([['dev-001', 'SW1'], ['dev-002', 'R1']]);

    /* Act */
    const html = build_cable_report_html({
      records: records,
      device_names: names,
      experiment_name: '演示',
      generated_at: '2026-10-07 19:30',
      custom_labels: { 'cab-0001': { from: 'CAB-12A', to: '' } }
    });

    /* Assert：A 端用自定义，B 端回落默认编号 */
    expect(html).toContain('CAB-12A');
    expect(html).toContain('B-01');
    expect(html).not.toContain('>A-01<');
  });

  it('空清单给出占位行', () => {
    /* Act */
    const html = build_cable_report_html({
      records: [],
      device_names: new Map<string, string>(),
      experiment_name: '空实验',
      generated_at: '2026-10-07 19:00'
    });

    /* Assert */
    expect(html).toContain('暂无已连接的线缆');
    expect(escape_html('a&b')).toBe('a&amp;b');
  });
});
