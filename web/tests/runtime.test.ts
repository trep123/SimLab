/**
 * @File : web/tests/runtime.test.ts
 * @Time : 2026-10-05 12:50
 * @Author : Cetrp
 * @Description : 本地运行时单元测试：多设备创建、设备间连线协商、端到端 ping 转发与不可达原因。
 */

import { describe, expect, it } from 'vitest';

import { EventBus } from '../src/core/event_bus';
import { LocalRuntime } from '../src/core/local_runtime';

/**
 * 构造测试用运行时。
 *
 * @returns {LocalRuntime} 运行时实例。
 */
function make_runtime(): LocalRuntime {
  return new LocalRuntime({ bus: new EventBus({ history_limit: 400 }), experiment_id: 'exp-test' });
}

/**
 * 等待指定毫秒。
 *
 * @param {number} milliseconds 毫秒。
 * @returns {Promise<void>} 完成 Promise。
 */
function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

describe('多设备与设备间互连', () => {
  it('实验命名空间防止不同本地实验复用后端绑定 ID', async () => {
    const left = new LocalRuntime({
      bus: new EventBus({ history_limit: 20 }),
      experiment_id: 'exp-left',
      device_id_namespace: 'exp-left'
    });
    const right = new LocalRuntime({
      bus: new EventBus({ history_limit: 20 }),
      experiment_id: 'exp-right',
      device_id_namespace: 'exp-right'
    });

    const left_device = await left.create_device('generic-atx-pc');
    const right_device = await right.create_device('generic-atx-pc');

    expect(left_device.data.device_id).toBe('dev-expleft-001');
    expect(right_device.data.device_id).toBe('dev-expright-001');
    expect(left_device.data.device_id).not.toBe(right_device.data.device_id);
  });

  it('恢复实验时保留设备和线缆 ID，并继续使用递增序号', async () => {
    const runtime = make_runtime();
    const first = await runtime.create_device('huawei-s5731-s24t4x', 'SW-Saved', 'dev-017');
    const second = await runtime.create_device('h3c-msr3600-28', 'RT-Saved', 'dev-021');
    const source = runtime.get_device(String(first.data.device_id))!;
    const target = runtime.get_device(String(second.data.device_id))!;
    const cable = await runtime.connect_cable(
      { device_id: source.device_id, port: source.ports[0].short_name },
      { device_id: target.device_id, port: target.ports[0].short_name },
      'ETHERNET_COPPER',
      'cab-0042'
    );
    const next = await runtime.create_device('generic-ap-ax3000');

    expect(first.success).toBe(true);
    expect(cable.success).toBe(true);
    expect(runtime.cables_snapshot()[0].cable_id).toBe('cab-0042');
    expect(next.data.device_id).toBe('dev-022');
  });

  it('create_device 依据型号注册设备并自动排布位置', async () => {
    /* Arrange */
    const runtime = make_runtime();

    /* Act */
    const first = await runtime.create_device('huawei-s5731-s24t4x');
    const second = await runtime.create_device('h3c-msr3600-28');

    /* Assert */
    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(runtime.list_devices().length).toBe(2);
    const devices = runtime.list_devices();
    expect(devices[0].position.x).not.toBe(devices[1].position.x);
  });

  it('设备间连线：两端端口占用、协商后链路 UP，拔线后回到 DOWN', async () => {
    /* Arrange */
    const runtime = make_runtime();
    const a = await runtime.create_device('huawei-s5731-s24t4x');
    const b = await runtime.create_device('h3c-msr3600-28');
    const device_a = runtime.get_device(a.data.device_id)!;
    const device_b = runtime.get_device(b.data.device_id)!;
    await runtime.power(device_a.device_id, true);
    await runtime.power(device_b.device_id, true);
    await sleep(4200);
    expect(device_a.power_state).toBe('RUNNING');

    /* Act */
    const connect = await runtime.connect_cable(
      { device_id: device_a.device_id, port: device_a.ports[0].short_name },
      { device_id: device_b.device_id, port: device_b.ports[0].short_name }
    );
    await sleep(1200);

    /* Assert */
    expect(connect.success).toBe(true);
    expect(device_a.ports[0].link_up).toBe(true);
    expect(device_b.ports[0].link_up).toBe(true);
    expect(device_a.ports[0].peer_device_id).toBe(device_b.device_id);
    expect(runtime.cables_snapshot()[0].state).toBe('UP');

    /* Act：端口占用与自环校验 */
    const occupied = await runtime.connect_cable(
      { device_id: device_a.device_id, port: device_a.ports[0].short_name },
      { device_id: device_b.device_id, port: device_b.ports[1].short_name }
    );
    expect(occupied.error_code).toBe('PORT_OCCUPIED');

    /* Act：拔线 */
    const cable_id = runtime.cables_snapshot()[0].cable_id;
    await runtime.disconnect_cable(cable_id);

    /* Assert */
    expect(device_a.ports[0].link_up).toBe(false);
    expect(device_b.ports[0].link_up).toBe(false);
    expect(runtime.cables_snapshot().length).toBe(0);
  });

  it('端口未启用时连线不会建立链路（admin down 优先）', async () => {
    /* Arrange */
    const runtime = make_runtime();
    const a = await runtime.create_device('huawei-s5731-s24t4x');
    const b = await runtime.create_device('huawei-s5731-s24t4x');
    const device_a = runtime.get_device(a.data.device_id)!;
    const device_b = runtime.get_device(b.data.device_id)!;
    await runtime.power(device_a.device_id, true);
    await runtime.power(device_b.device_id, true);
    await sleep(4200);
    await runtime.configure_port(device_a.device_id, device_a.ports[0].short_name, {
      admin_up: false
    });

    /* Act */
    await runtime.connect_cable(
      { device_id: device_a.device_id, port: device_a.ports[0].short_name },
      { device_id: device_b.device_id, port: device_b.ports[0].short_name }
    );
    await sleep(1200);

    /* Assert */
    expect(device_a.ports[0].link_up).toBe(false);
    expect(device_b.ports[0].link_up).toBe(false);
    expect(runtime.cables_snapshot()[0].state).toBe('DOWN');
  });
});

describe('端到端转发仿真', () => {
  it('直连两台设备 ping 可达并给出逐跳路径', async () => {
    /* Arrange */
    const runtime = make_runtime();
    const a = await runtime.create_device('huawei-s5731-s24t4x');
    const b = await runtime.create_device('huawei-s5731-s24t4x');
    const device_a = runtime.get_device(a.data.device_id)!;
    const device_b = runtime.get_device(b.data.device_id)!;
    await runtime.power(device_a.device_id, true);
    await runtime.power(device_b.device_id, true);
    await sleep(4200);
    await runtime.connect_cable(
      { device_id: device_a.device_id, port: device_a.ports[0].short_name },
      { device_id: device_b.device_id, port: device_b.ports[0].short_name }
    );
    await sleep(1200);

    /* Act */
    const result = await runtime.ping(device_a.device_id, { device_id: device_b.device_id }, 4);

    /* Assert */
    expect(result.reachable).toBe(true);
    expect(result.path).toEqual([device_a.device_id, device_b.device_id]);
    expect(result.received).toBe(4);
    expect(result.rtt_avg_ms).toBeGreaterThan(0);
    expect(result.hops[0].out_port).toBe(device_a.ports[0].short_name);
    expect(result.hops[1].in_port).toBe(device_b.ports[0].short_name);
  });

  it('未接线时返回 NO_LINK，设备关机时返回 DEVICE_POWER_OFF', async () => {
    /* Arrange */
    const runtime = make_runtime();
    const a = await runtime.create_device('huawei-s5731-s24t4x');
    const b = await runtime.create_device('huawei-s5731-s24t4x');
    const device_a = runtime.get_device(a.data.device_id)!;
    const device_b = runtime.get_device(b.data.device_id)!;
    await runtime.power(device_a.device_id, true);
    await runtime.power(device_b.device_id, true);
    await sleep(4200);

    /* Act */
    const no_link = await runtime.ping(device_a.device_id, { device_id: device_b.device_id });

    /* Assert */
    expect(no_link.reachable).toBe(false);
    expect(no_link.unreachable_reason).toBe('NO_LINK');

    /* Act：目标关机 */
    await runtime.power(device_b.device_id, false);
    const powered_off = await runtime.ping(device_a.device_id, { device_id: device_b.device_id });

    /* Assert */
    expect(powered_off.unreachable_reason).toBe('DEVICE_POWER_OFF');
  });

  it('交换机端口 VLAN 不一致时返回 VLAN_MISMATCH', async () => {
    /* Arrange */
    const runtime = make_runtime();
    const switcher = await runtime.create_device('huawei-s5731-s24t4x');
    const left = await runtime.create_device('huawei-s5731-s24t4x');
    const right = await runtime.create_device('huawei-s5731-s24t4x');
    const switch_device = runtime.get_device(switcher.data.device_id)!;
    const left_device = runtime.get_device(left.data.device_id)!;
    const right_device = runtime.get_device(right.data.device_id)!;
    for (const device of [switch_device, left_device, right_device]) {
      await runtime.power(device.device_id, true);
    }
    await sleep(4200);
    await runtime.connect_cable(
      { device_id: left_device.device_id, port: left_device.ports[0].short_name },
      { device_id: switch_device.device_id, port: switch_device.ports[0].short_name }
    );
    await runtime.connect_cable(
      { device_id: switch_device.device_id, port: switch_device.ports[1].short_name },
      { device_id: right_device.device_id, port: right_device.ports[0].short_name }
    );
    await sleep(1200);
    await runtime.configure_port(switch_device.device_id, switch_device.ports[1].short_name, {
      vlan: 20
    });

    /* Act */
    const result = await runtime.ping(left_device.device_id, { device_id: right_device.device_id });

    /* Assert */
    expect(result.reachable).toBe(false);
    expect(result.unreachable_reason).toBe('VLAN_MISMATCH');
  });
});

describe('无线与 ping 的联动', () => {
  it('STA 关联 AP 后可通过无线链路 ping 通', async () => {
    /* Arrange */
    const runtime = make_runtime();
    const ap = await runtime.create_device('generic-ap-ax3000');
    const sta = await runtime.create_device('generic-laptop-wifi6');
    const ap_device = runtime.get_device(ap.data.device_id)!;
    const sta_device = runtime.get_device(sta.data.device_id)!;
    await runtime.power(ap_device.device_id, true);
    await runtime.power(sta_device.device_id, true);
    await sleep(4200);

    /* Act */
    const association = await runtime.associate(sta_device.device_id, ap_device.device_id);
    const snapshot = await runtime.wireless_snapshot();
    const result = await runtime.ping(sta_device.device_id, { device_id: ap_device.device_id });

    /* Assert */
    expect(association.success).toBe(true);
    expect(snapshot.associations.length).toBe(1);
    expect(snapshot.associations[0].ap_device_id).toBe(ap_device.device_id);
    expect(result.reachable).toBe(true);
    expect(result.path).toEqual([sta_device.device_id, ap_device.device_id]);
  });

  it('非无线设备关联返回 WIRELESS_UNSUPPORTED', async () => {
    /* Arrange */
    const runtime = make_runtime();
    const switcher = await runtime.create_device('huawei-s5731-s24t4x');

    /* Act */
    const result = await runtime.associate(switcher.data.device_id);

    /* Assert */
    expect(result.success).toBe(false);
    expect(result.error_code).toBe('WIRELESS_UNSUPPORTED');
  });
});

describe('无线关联与设备电源一致性', () => {
  it('STA 关机后必须解除无线关联（不能保持"已连接"）', async () => {
    /* Arrange：AP + STA 上电并关联 */
    const runtime = make_runtime();
    const ap = await runtime.create_device('generic-ap-ax3000');
    const sta = await runtime.create_device('generic-laptop-wifi6');
    await runtime.power(ap.data.device_id, true);
    await runtime.power(sta.data.device_id, true);
    await sleep(4200);
    await runtime.associate(sta.data.device_id, ap.data.device_id);
    await sleep(400);

    /* Assert：关联已建立 */
    const before = await runtime.wireless_snapshot();
    expect(before.associations.map((item) => item.sta_device_id)).toContain(sta.data.device_id);

    /* Act：STA 关机 */
    await runtime.power(sta.data.device_id, false);
    await sleep(400);

    /* Assert：关联被解除 */
    const after = await runtime.wireless_snapshot();
    expect(after.associations.map((item) => item.sta_device_id)).not.toContain(sta.data.device_id);
  });

  it('AP 关机后其下所有 STA 必须解除关联', async () => {
    /* Arrange */
    const runtime = make_runtime();
    const ap = await runtime.create_device('generic-ap-ax3000');
    const sta_a = await runtime.create_device('generic-laptop-wifi6');
    const sta_b = await runtime.create_device('generic-phone-wifi6');
    await runtime.power(ap.data.device_id, true);
    await runtime.power(sta_a.data.device_id, true);
    await runtime.power(sta_b.data.device_id, true);
    await sleep(4200);
    await runtime.associate(sta_a.data.device_id, ap.data.device_id);
    await runtime.associate(sta_b.data.device_id, ap.data.device_id);
    await sleep(400);
    const before = await runtime.wireless_snapshot();
    expect(before.associations.length).toBeGreaterThanOrEqual(2);

    /* Act：AP 关机 */
    await runtime.power(ap.data.device_id, false);
    await sleep(400);

    /* Assert：全部解除 */
    const after = await runtime.wireless_snapshot();
    expect(after.associations.length).toBe(0);
    /* AP 侧客户端计数同样归零（面板 / 拓扑速览读的就是它） */
    const ap_view = after.aps.find((item) => item.device_id === ap.data.device_id);
    expect(ap_view ? ap_view.client_count : 0).toBe(0);
  });
});

describe('射频覆盖范围', () => {
  it('把 STA 拖出射频圈外后无线自动断连', async () => {
    /* Arrange：AP + STA 上电并关联 */
    const runtime = make_runtime();
    const ap = await runtime.create_device('generic-ap-ax3000');
    const sta = await runtime.create_device('generic-laptop-wifi6');
    await runtime.power(ap.data.device_id, true);
    await runtime.power(sta.data.device_id, true);
    await sleep(4200);
    await runtime.associate(sta.data.device_id, ap.data.device_id);
    await sleep(300);
    expect((await runtime.wireless_snapshot()).associations.length).toBe(1);

    /* Act：把 STA 移到 300 m 外（远超覆盖半径） */
    await runtime.move_device(sta.data.device_id, { x: 300, y: 0, z: 0 });
    await sleep(100);

    /* Assert：立即断开，且 AP 侧客户端计数归零 */
    const after_move = await runtime.wireless_snapshot();
    expect(after_move.associations.length).toBe(0);
    const ap_view = after_move.aps.find((item) => item.device_id === ap.data.device_id);
    expect(ap_view ? ap_view.client_count : 0).toBe(0);

    /* Act：移回范围内并重新关联 → 恢复可用 */
    await runtime.move_device(sta.data.device_id, { x: 6, y: 0, z: 0 });
    await runtime.associate(sta.data.device_id, ap.data.device_id);
    await sleep(300);

    /* Assert */
    expect((await runtime.wireless_snapshot()).associations.length).toBe(1);
  });

  it('把 AP 拖出射频圈外时其下 STA 一并掉线', async () => {
    /* Arrange */
    const runtime = make_runtime();
    const ap = await runtime.create_device('generic-ap-ax3000');
    const sta = await runtime.create_device('generic-laptop-wifi6');
    await runtime.power(ap.data.device_id, true);
    await runtime.power(sta.data.device_id, true);
    await sleep(4200);
    await runtime.associate(sta.data.device_id, ap.data.device_id);
    await sleep(300);
    expect((await runtime.wireless_snapshot()).associations.length).toBe(1);

    /* Act：把 AP 拖到 300 m 外 */
    await runtime.move_device(ap.data.device_id, { x: -300, y: 0, z: 0 });
    await sleep(100);

    /* Assert */
    expect((await runtime.wireless_snapshot()).associations.length).toBe(0);
  });
});
