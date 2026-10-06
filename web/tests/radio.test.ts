/**
 * @File : web/tests/radio.test.ts
 * @Time : 2026-10-05 12:30
 * @Author : Cetrp
 * @Description : 无线模型单元测试：路径损耗、MCS、覆盖半径、关联、漫游与空口共享（AAA 模式）。
 */

import { describe, expect, it } from 'vitest';

import {
  LocalRadioModel,
  coverage_radius_m,
  mcs_from_snr,
  packet_error_rate,
  path_loss_db
} from '../src/core/radio_model';

describe('无线传播模型', () => {
  it('路径损耗随距离单调增加且与自由空间参考一致', () => {
    /* Arrange */
    const near = path_loss_db(1, 2437, 2.8);
    const far = path_loss_db(10, 2437, 2.8);

    /* Act & Assert */
    expect(far).toBeGreaterThan(near);
    expect(near).toBeCloseTo(20 * Math.log10(2437) - 27.55, 3);
  });

  it('SNR → MCS 表按阈值选取', () => {
    /* Act & Assert */
    expect(mcs_from_snr(-5)).toBe(0);
    expect(mcs_from_snr(10)).toBe(3);
    expect(mcs_from_snr(30)).toBe(10);
    expect(mcs_from_snr(35)).toBe(11);
    expect(mcs_from_snr(100)).toBe(11);
  });

  it('PER 随 SNR 升高而下降并落在 0.001–0.9 区间', () => {
    /* Act */
    const bad = packet_error_rate(0, 11);
    const good = packet_error_rate(40, 0);

    /* Assert */
    expect(bad).toBeGreaterThan(good);
    expect(bad).toBeLessThanOrEqual(0.9);
    expect(good).toBeGreaterThanOrEqual(0.001);
  });

  it('覆盖半径由灵敏度阈值反解', () => {
    /* Act */
    const radius = coverage_radius_m(20, 2437, 2.8, -75);
    const rssi_at_radius = 20 - path_loss_db(radius, 2437, 2.8);

    /* Assert */
    expect(radius).toBeGreaterThan(10);
    expect(rssi_at_radius).toBeCloseTo(-75, 1);
  });
});

describe('无线关联与漫游', () => {
  it('调整单台 AP 功率会改变覆盖，切换信道会断开该 AP 客户端', () => {
    const model = new LocalRadioModel();
    model.add_ap({ node_id: 'ap-1', kind: 'ap', position: { x: 0, y: 0, z: 0 } });
    model.add_sta({ node_id: 'sta-1', kind: 'sta', position: { x: 3, y: 0, z: 0 } });
    model.associate('sta-1', 'ap-1');
    const original = model.aps_snapshot()[0].coverage_radius_m;

    const disconnected = model.configure_ap('ap-1', {
      ssid: 'LAB-5G', channel: 36, tx_power_dbm: 10
    });

    expect(disconnected).toEqual(['sta-1']);
    expect(model.associations_snapshot()).toHaveLength(0);
    expect(model.aps_snapshot()[0]).toMatchObject({
      ssid: 'LAB-5G', channel: 36, tx_power_dbm: 10
    });
    expect(model.aps_snapshot()[0].coverage_radius_m).toBeLessThan(original);
  });
  it('关联后返回 RSSI/速率/吞吐，且距离越远 RSSI 越低', () => {
    /* Arrange */
    const model = new LocalRadioModel();
    model.configure({ channel: 6, exponent: 2.8, seed: 7 });
    model.add_ap({ node_id: 'ap-1', kind: 'ap', position: { x: 0, y: 0, z: 0 } });
    model.add_sta({ node_id: 'sta-1', kind: 'sta', position: { x: 3, y: 0, z: 0 } });

    /* Act */
    const association = model.associate('sta-1', 'ap-1');
    const near_rssi = association ? association.rssi_dbm : 0;
    model.set_position('sta-1', { x: 25, y: 0, z: 0 });
    const after = model.associations_snapshot()[0];

    /* Assert */
    expect(association).not.toBeNull();
    expect(association?.state).toBe('ASSOCIATED');
    expect(association?.phy_rate_mbps).toBeGreaterThan(0);
    expect(after.rssi_dbm).toBeLessThan(near_rssi);
  });

  it('自动选择信号最强的 AP', () => {
    /* Arrange */
    const model = new LocalRadioModel();
    model.configure({ channel: 6, seed: 3 });
    model.add_ap({ node_id: 'ap-far', kind: 'ap', position: { x: 40, y: 0, z: 0 } });
    model.add_ap({ node_id: 'ap-near', kind: 'ap', position: { x: 2, y: 0, z: 0 } });
    model.add_sta({ node_id: 'sta-1', kind: 'sta', position: { x: 0, y: 0, z: 0 } });

    /* Act */
    const association = model.associate('sta-1');

    /* Assert */
    expect(association?.ap_device_id).toBe('ap-near');
  });

  it('漫游：出现强于当前 AP 超过滞回的邻居并持续后自动切换', () => {
    /* Arrange */
    const model = new LocalRadioModel();
    model.configure({ channel: 6, seed: 11 });
    model.add_ap({ node_id: 'ap-a', kind: 'ap', position: { x: 0, y: 0, z: 0 } });
    model.add_ap({ node_id: 'ap-b', kind: 'ap', position: { x: 8, y: 0, z: 0 } });
    model.add_sta({ node_id: 'sta-1', kind: 'sta', position: { x: 7, y: 0, z: 0 } });
    model.associate('sta-1', 'ap-a');

    /* Act：连续推进超过漫游判定周期 */
    for (let i = 0; i < 8; i += 1) {
      model.step(0.5);
    }
    const snapshot = model.associations_snapshot()[0];

    /* Assert */
    expect(snapshot.ap_device_id).toBe('ap-b');
  });

  it('空口共享：同 AP 下 STA 越多，单站吞吐越低', () => {
    /* Arrange */
    const model = new LocalRadioModel();
    model.configure({ channel: 6, seed: 5 });
    model.add_ap({ node_id: 'ap-1', kind: 'ap', position: { x: 0, y: 0, z: 0 } });
    model.add_sta({ node_id: 'sta-1', kind: 'sta', position: { x: 2, y: 0, z: 0 } });
    model.associate('sta-1', 'ap-1');
    for (let i = 0; i < 10; i += 1) {
      model.step(0.5);
    }
    const single = model.associations_snapshot()[0].throughput_mbps;

    /* Act：再接入 5 个 STA */
    for (let index = 2; index <= 6; index += 1) {
      model.add_sta({
        node_id: 'sta-' + index,
        kind: 'sta',
        position: { x: 2 + index, y: 0, z: 0 }
      });
      model.associate('sta-' + index, 'ap-1');
    }
    for (let i = 0; i < 20; i += 1) {
      model.step(0.5);
    }
    const shared = model.associations_snapshot().find((item) => item.sta_device_id === 'sta-1');

    /* Assert */
    expect(single).toBeGreaterThan(0);
    expect(shared!.throughput_mbps).toBeLessThan(single);
  });
});

describe('射频覆盖范围与自动断连', () => {
  it('STA 移出覆盖半径后关联自动断开', () => {
    /* Arrange：AP 与 STA 相距 8 m 且已关联 */
    const radio = new LocalRadioModel();
    radio.add_ap({ node_id: 'ap-1', kind: 'ap', position: { x: 0, y: 0, z: 0 }, tx_power_dbm: 20 });
    radio.add_sta({ node_id: 'sta-1', kind: 'sta', position: { x: 8, y: 0, z: 0 } });
    const association = radio.associate('sta-1', 'ap-1');
    expect(association).not.toBeNull();
    expect(radio.associations_snapshot().length).toBe(1);

    /* Act：把 STA 移到 400 m 外（远超覆盖半径） */
    radio.set_position('sta-1', { x: 400, y: 0, z: 0 });
    const result = radio.step(0.5);

    /* Assert：关联被断开且给出原因 */
    expect(radio.associations_snapshot().length).toBe(0);
    expect(result.drops.length).toBe(1);
    expect(result.drops[0].sta_id).toBe('sta-1');
    expect(result.drops[0].reason).toBe('OUT_OF_RANGE');
    expect(result.drops[0].rssi_dbm).toBeLessThan(radio.sensitivity_dbm);
  });

  it('覆盖范围内的正常移动不会断连', () => {
    /* Arrange */
    const radio = new LocalRadioModel();
    radio.add_ap({ node_id: 'ap-1', kind: 'ap', position: { x: 0, y: 0, z: 0 }, tx_power_dbm: 20 });
    radio.add_sta({ node_id: 'sta-1', kind: 'sta', position: { x: 6, y: 0, z: 0 } });
    radio.associate('sta-1', 'ap-1');

    /* Act：在覆盖范围内移动 */
    radio.set_position('sta-1', { x: 14, y: 0, z: 0 });
    const result = radio.step(0.5);

    /* Assert */
    expect(radio.associations_snapshot().length).toBe(1);
    expect(result.drops.length).toBe(0);
  });

  it('check_out_of_range 立即判定（用于拖动设备时即时断开）', () => {
    /* Arrange */
    const radio = new LocalRadioModel();
    radio.add_ap({ node_id: 'ap-1', kind: 'ap', position: { x: 0, y: 0, z: 0 }, tx_power_dbm: 20 });
    radio.add_sta({ node_id: 'sta-1', kind: 'sta', position: { x: 5, y: 0, z: 0 } });
    radio.associate('sta-1', 'ap-1');

    /* Act：把 AP 拖走 */
    radio.set_position('ap-1', { x: 500, y: 0, z: 0 });
    const dropped = radio.check_out_of_range('ap-1');

    /* Assert */
    expect(dropped.length).toBe(1);
    expect(dropped[0].reason).toBe('OUT_OF_RANGE');
    expect(radio.associations_snapshot().length).toBe(0);
  });
});
