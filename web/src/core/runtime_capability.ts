/**
 * @File : web/src/core/runtime_capability.ts
 * @Time : 2026-10-07 16:20
 * @Author : Cetrp
 * @Description : 设备运行时能力判定：区分"真实虚拟化（QEMU/KVM）"与"模拟运行时"，
 *               供右键菜单、控制台与检视面板标注 CLI 类型（真实 / 模拟）。
 */

import type { DeviceManifest } from '../data/types';

/** 运行时引擎类别。 */
export type RuntimeEngine = 'qemu' | 'ovs' | 'ns3' | 'custom' | 'simulated';

/** 运行时能力描述。 */
export interface RuntimeCapability {
  /** 引擎类别。 */
  engine: RuntimeEngine;
  /** 中文引擎名（QEMU 虚拟机 / 模拟运行时…）。 */
  engine_label: string;
  /** 命令行类型：真实（虚拟机或外部真实实现）或模拟。 */
  console_kind: 'real' | 'simulated';
  /** 命令行类型中文说明。 */
  console_label: string;
  /** 是否可冷快照。 */
  snapshot: boolean;
  /** 虚拟化镜像（若有）。 */
  image?: string;
  /** 备注（来自资产）。 */
  notes?: string;
}

/** 引擎中文名。 */
const ENGINE_LABELS: Record<RuntimeEngine, string> = {
  qemu: 'QEMU 虚拟机',
  ovs: 'OVS 真实转发',
  ns3: 'ns-3 网络仿真',
  custom: '外部实现进程',
  simulated: '内置模拟运行时'
};

/**
 * 判定设备的运行时能力。
 *
 * 判定依据是资产里的 `runtime.type`（不按设备外观猜测）：
 * `qemu/kvm/container` → 真实虚拟化；`ovs/ns3/custom` → 外部真实实现；其余为模拟运行时。
 *
 * @param {DeviceManifest} manifest 设备 Manifest。
 * @returns {RuntimeCapability} 能力描述。
 */
export function runtime_capability(manifest: DeviceManifest): RuntimeCapability {
  const runtime = (manifest.runtime || {}) as {
    type?: string;
    capabilities?: string[];
    virtualization?: { engine?: string; image?: string; notes?: string };
  };
  const raw = String(runtime.type || 'simulated') as RuntimeEngine;
  const engine: RuntimeEngine = raw in ENGINE_LABELS ? raw : 'simulated';
  const is_real = engine !== 'simulated';
  const virtual = runtime.virtualization || {};

  return {
    engine: engine,
    engine_label: virtual.engine === 'kvm' ? 'KVM 虚拟机' : ENGINE_LABELS[engine],
    console_kind: is_real ? 'real' : 'simulated',
    console_label: is_real ? '真实 CLI（' + ENGINE_LABELS[engine] + '）' : '模拟 CLI（内置引擎）',
    snapshot: Boolean(runtime.capabilities && runtime.capabilities.indexOf('cold_snapshot') >= 0),
    image: virtual.image,
    notes: virtual.notes
  };
}

/**
 * 设备是否为真实虚拟化设备（可直接打开真实 CLI）。
 *
 * @param {DeviceManifest} manifest 设备 Manifest。
 * @returns {boolean} 是否真实虚拟化。
 */
export function is_virtualized(manifest: DeviceManifest): boolean {
  return runtime_capability(manifest).console_kind === 'real';
}
