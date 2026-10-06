/**
 * @File : web/tests/optical.test.ts
 * @Time : 2026-10-05 14:30
 * @Author : Cetrp
 * @Description : 光链路模型单元测试：光纤衰减、分光器插损、接收光功率、状态判定、测距与 DBA 分配。
 */

import { describe, expect, it } from 'vitest';

import {
  LocalOpticalModel,
  ber_from_margin,
  fiber_loss_db,
  rtd_ns,
  splitter_loss_db,
  state_from_rx
} from '../src/core/optical_model';

describe('光功率模型', () => {
  it('光纤衰减随长度线性增长且与波长相关', () => {
    /* Act & Assert */
    expect(fiber_loss_db(1000, 1490)).toBeCloseTo(0.22, 3);
    expect(fiber_loss_db(10000, 1490)).toBeCloseTo(2.2, 3);
    expect(fiber_loss_db(10000, 1310)).toBeGreaterThan(fiber_loss_db(10000, 1490));
  });

  it('分光器插损按分光比查表', () => {
    /* Act & Assert */
    expect(splitter_loss_db(2)).toBeCloseTo(3.5, 6);
    expect(splitter_loss_db(8)).toBeCloseTo(10.5, 6);
    expect(splitter_loss_db(64)).toBeCloseTo(20.0, 6);
  });

  it('状态判定覆盖 WORKING / MARGINAL / LOF / LOS / DYING_GASP / OVERLOAD', () => {
    /* Act & Assert */
    expect(state_from_rx(-20, -28, -8, -30)).toBe('WORKING');
    expect(state_from_rx(-26, -28, -8, -30)).toBe('MARGINAL');
    expect(state_from_rx(-29, -28, -8, -30)).toBe('LOF');
    expect(state_from_rx(-31, -28, -8, -30)).toBe('LOS');
    expect(state_from_rx(-34, -28, -8, -30)).toBe('DYING_GASP');
    expect(state_from_rx(-5, -28, -8, -30)).toBe('OVERLOAD');
  });

  it('测距 RTD 与距离成正比（G.652 群折射率 1.468）', () => {
    /* Act */
    const one_km = rtd_ns(1000);
    const ten_km = rtd_ns(10000);

    /* Assert */
    expect(ten_km).toBeCloseTo(one_km * 10, 3);
    expect(one_km).toBeCloseTo(9793.4, 0);
  });

  it('误码率随余量分档', () => {
    /* Act & Assert */
    expect(ber_from_margin(20)).toBe(1e-12);
    expect(ber_from_margin(4)).toBe(1e-9);
    expect(ber_from_margin(1)).toBe(1e-6);
    expect(ber_from_margin(-2)).toBe(1e-3);
  });
});

describe('光链路模型', () => {
  it('正常场景：OLT +3 dBm、1:8、2.4 km 应为 WORKING 且余量 > 15 dB', () => {
    /* Arrange */
    const model = new LocalOpticalModel();
    model.configure({ olt_tx_power_dbm: 3, wavelength_down_nm: 1490 });
    model.add_olt({ node_id: 'olt-1', pon_ports: 2, tx_power_dbm: 3 });
    model.add_onu({
      node_id: 'onu-1',
      olt_id: 'olt-1',
      fiber_length_m: 2400,
      splitter_ratio: 8,
      connectors: 2,
      splices: 1
    });

    /* Act */
    const link = model.snapshot().links[0];

    /* Assert */
    expect(link.state).toBe('WORKING');
    expect(link.rx_power_dbm).toBeGreaterThan(-28);
    expect(link.power_margin_db).toBeGreaterThan(15);
    expect(link.alarm).toBeNull();
    expect(link.rtd_ns).toBeGreaterThan(20000);
  });

  it('故障场景：1:64 + 20 km 光功率劣化，断纤触发 LOS 告警', () => {
    /* Arrange */
    const model = new LocalOpticalModel();
    model.add_olt({ node_id: 'olt-1', tx_power_dbm: 3 });
    model.add_onu({ node_id: 'onu-1', olt_id: 'olt-1', fiber_length_m: 2400, splitter_ratio: 8 });

    /* Act */
    model.set_fiber('onu-1', {
      fiber_length_m: 20000,
      splitter_ratio: 64,
      connectors: 4,
      splices: 2
    });
    const snapshot = model.snapshot();
    const link = snapshot.links[0];

    /* Assert */
    expect(link.rx_power_dbm).toBeLessThan(-20);
    expect(['WORKING', 'MARGINAL', 'LOF', 'LOS', 'DYING_GASP']).toContain(link.state);

    /* Act：模拟断纤 */
    model.set_fiber('onu-1', { broken: true });
    const broken = model.snapshot();

    /* Assert */
    expect(broken.links[0].rx_power_dbm).toBe(-40);
    expect(broken.links[0].state).toBe('DYING_GASP');
    expect(broken.links[0].alarm).toBe('LOS');
    expect(broken.alarms.length).toBe(1);
  });

  it('DBA：单 ONU 按需求分配，超上限被截断', () => {
    /* Arrange */
    const model = new LocalOpticalModel();
    model.add_olt({ node_id: 'olt-1' });
    model.add_onu({ node_id: 'onu-1', olt_id: 'olt-1' });

    /* Act：需求 400 Mbps */
    model.set_traffic('onu-1', { downstream_mbps: 400, upstream_mbps: 160 });
    const normal = model.snapshot().links[0];

    /* Assert */
    expect(normal.downstream_allocated_mbps).toBeCloseTo(400, 1);
    expect(normal.upstream_allocated_mbps).toBeCloseTo(160, 1);

    /* Act：需求 4000 Mbps（超过单 ONU 上限 1024） */
    model.set_traffic('onu-1', { downstream_mbps: 4000, upstream_mbps: 4000 });
    const capped = model.snapshot().links[0];

    /* Assert */
    expect(capped.downstream_allocated_mbps).toBeLessThanOrEqual(1024);
  });

  it('DBA：多 ONU 竞争时总和不超过 OLT 容量，负载低者按需求满足', () => {
    /* Arrange */
    const model = new LocalOpticalModel();
    model.add_olt({ node_id: 'olt-1' });
    for (let index = 1; index <= 3; index += 1) {
      model.add_onu({ node_id: 'onu-' + index, olt_id: 'olt-1' });
      model.set_traffic('onu-' + index, { downstream_mbps: 900, upstream_mbps: 300 });
    }

    /* Act */
    const snapshot = model.snapshot();
    const olt = snapshot.olts[0];
    const total_down = snapshot.links.reduce(
      (sum, link) => sum + link.downstream_allocated_mbps,
      0
    );

    /* Assert */
    expect(total_down).toBeLessThanOrEqual(olt.downstream_capacity_mbps + 0.01);
    expect(snapshot.links.every((link) => link.downstream_allocated_mbps > 0)).toBe(true);
  });

  it('移除 OLT 会级联移除其 ONU 链路', () => {
    /* Arrange */
    const model = new LocalOpticalModel();
    model.add_olt({ node_id: 'olt-1' });
    model.add_onu({ node_id: 'onu-1', olt_id: 'olt-1' });
    model.add_onu({ node_id: 'onu-2', olt_id: 'olt-1' });
    expect(model.snapshot().links.length).toBe(2);

    /* Act */
    model.remove_node('olt-1');

    /* Assert */
    expect(model.snapshot().links.length).toBe(0);
    expect(model.snapshot().olts.length).toBe(0);
  });
});
