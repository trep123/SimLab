/**
 * @File : web/src/scene/rf_layer.ts
 * @Time : 2026-10-06 17:10
 * @Author : Cetrp
 * @Description : 无线射频可视化图层：以"波束 + 扩散波前 + 信号源脉冲"表达 AP↔STA 的无线连接，
 *               不使用任何物理线缆几何；连接质量以颜色/波束宽度/波前速度体现。
 */

import * as THREE from 'three';

/** 波束最大半宽（场景单位），对应信号最弱时仍有可见扩散。 */
const BEAM_MAX_RADIUS = 0.85;

/** 波束最小半宽（场景单位），对应信号最强。 */
const BEAM_MIN_RADIUS = 0.18;



/** 空中帧飞行时长（秒）。 */
const FRAME_DURATION = 0.65;

/** RSSI 到颜色的映射（优/良/弱）。 */
export function rssi_color(rssi_dbm: number): number {
  if (rssi_dbm >= -55) {
    return 0x37e0c9;
  }
  if (rssi_dbm >= -67) {
    return 0xffb648;
  }

  return 0xff5d6c;
}

/**
 * RSSI 中文等级。
 *
 * @param {number} rssi_dbm 信号强度。
 * @returns {string} 等级文本。
 */
export function rssi_text(rssi_dbm: number): string {
  if (rssi_dbm >= -55) {
    return '优';
  }
  if (rssi_dbm >= -67) {
    return '良';
  }

  return '弱';
}

/** 单条无线关联的可视化对象。 */
interface RfAssociationVisual {
  key: string;
  /** 波束（从 AP 指向 STA 的锥形体）。 */
  beam: THREE.Mesh;
  /** 波前环。 */
  /** AP 侧射频源脉冲球。 */
  source: THREE.Mesh;
  /** STA 侧接收指示球。 */
  sink: THREE.Mesh;
  /** 空中帧粒子。 */
  frames: THREE.Mesh[];
  /** 当前信号强度。 */
  rssi_dbm: number;
  /** 波前动画进度。 */
  phase: number;
}

/**
 * 无线射频图层。
 */
export class RfLayer {
  /** 图层根组。 */
  group: THREE.Group;

  /** 关联可视化表。 */
  private associations = new Map<string, RfAssociationVisual>();

  /** 未关联的 STA（显示"正在搜索"脉冲）。 */
  private scanning = new Map<string, THREE.Mesh>();

  /**
   * 构造图层。
   */
  constructor() {
    this.group = new THREE.Group();
    this.group.name = 'rf_layer';
  }

  /**
   * 设置图层可见性。
   *
   * @param {boolean} visible 是否可见。
   * @returns {void}
   */
  set_visible(visible: boolean): void {
    this.group.visible = visible;
  }

  /**
   * 同步全部关联（增删改）。
   *
   * @param {{sta_device_id: string; ap_device_id: string; rssi_dbm: number}[]} associations 关联列表。
   * @param {Map<string, THREE.Vector3>} positions 设备位置表。
   * @param {Set<string>} waiting_sta 已上电但未关联的 STA 设备 ID。
   * @returns {void}
   */
  sync(
    associations: { sta_device_id: string; ap_device_id: string; rssi_dbm: number }[],
    positions: Map<string, THREE.Vector3>,
    waiting_sta: Set<string>
  ): void {
    const seen = new Set<string>();
    for (const item of associations) {
      const sta_position = positions.get(item.sta_device_id);
      const ap_position = positions.get(item.ap_device_id);
      if (!sta_position || !ap_position) {
        continue;
      }
      const key = item.sta_device_id + '->' + item.ap_device_id;
      seen.add(key);
      const existing = this.associations.get(key);
      if (existing) {
        existing.rssi_dbm = item.rssi_dbm;
        this._update_geometry(existing, sta_position, ap_position);
        continue;
      }
      this._create_association(key, item.rssi_dbm, sta_position, ap_position);
    }
    for (const [key, visual] of [...this.associations.entries()]) {
      if (seen.has(key)) {
        continue;
      }
      this._dispose_association(visual);
      this.associations.delete(key);
    }

    /* 未关联设备的"搜索信号"脉冲。 */
    const active_scan = new Set<string>();
    for (const device_id of waiting_sta) {
      const position = positions.get(device_id);
      if (!position) {
        continue;
      }
      active_scan.add(device_id);
      let pulse = this.scanning.get(device_id);
      if (!pulse) {
        pulse = new THREE.Mesh(
          new THREE.RingGeometry(1.1, 1.4, 40),
          new THREE.MeshBasicMaterial({
            color: 0x8ab6ff,
            transparent: true,
            opacity: 0.5,
            side: THREE.DoubleSide,
            depthWrite: false,
            blending: THREE.AdditiveBlending
          })
        );
        pulse.rotation.x = -Math.PI / 2;
        this.group.add(pulse);
        this.scanning.set(device_id, pulse);
      }
      pulse.position.set(position.x, 0.06, position.z);
    }
    for (const [device_id, pulse] of [...this.scanning.entries()]) {
      if (active_scan.has(device_id)) {
        continue;
      }
      this.group.remove(pulse);
      pulse.geometry.dispose();
      (pulse.material as THREE.Material).dispose();
      this.scanning.delete(device_id);
    }
  }

  /**
   * 播放在空中飞行的帧（上行 / 下行）。
   *
   * @param {string} sta_id STA 设备 ID。
   * @param {string} ap_id AP 设备 ID。
   * @param {string} direction 方向：`uplink`（STA→AP）或 `downlink`。
   * @returns {void}
   */
  play_frame(sta_id: string, ap_id: string, direction: string): void {
    const visual = this.associations.get(sta_id + '->' + ap_id);
    if (!visual) {
      return;
    }
    const from_sta = direction === 'uplink';
    for (const frame of visual.frames) {
      if (!frame.visible) {
        frame.visible = true;
        frame.userData.progress = 0;
        frame.userData.reverse = from_sta;
        return;
      }
    }
  }

  /**
   * 逐帧更新（波前扩散、脉冲呼吸、帧飞行）。
   *
   * @param {number} delta_seconds 时间步长。
   * @returns {void}
   */
  update(delta_seconds: number): void {
    const time = performance.now() / 1000;
    for (const visual of this.associations.values()) {
      /* 信号源与接收端脉冲（波前圆环已移除，避免出现悬浮竖立圆环）。 */
      const pulse = 1 + 0.14 * Math.sin(time * 3.1);
      visual.source.scale.setScalar(pulse);
      visual.sink.scale.setScalar(1 + 0.1 * Math.sin(time * 2.4 + 1.2));
      /* 空中帧。 */
      for (const frame of visual.frames) {
        if (!frame.visible) {
          continue;
        }
        frame.userData.progress =
          (frame.userData.progress as number) + delta_seconds / FRAME_DURATION;
        const progress = frame.userData.progress as number;
        if (progress >= 1) {
          frame.visible = false;
          continue;
        }
        const start = frame.userData.reverse
          ? (visual.beam.userData.end as THREE.Vector3)
          : (visual.beam.userData.start as THREE.Vector3);
        const end = frame.userData.reverse
          ? (visual.beam.userData.start as THREE.Vector3)
          : (visual.beam.userData.end as THREE.Vector3);
        frame.position.copy(start.clone().lerp(end, progress));
        frame.position.y += 0.45 + Math.sin(progress * Math.PI) * 0.5;
      }
    }
    /* 搜索脉冲呼吸。 */
    for (const pulse of this.scanning.values()) {
      const scale = 1 + 0.25 * Math.sin(time * 2.2);
      pulse.scale.set(scale, scale, 1);
    }
  }

  /**
   * 释放全部资源。
   *
   * @returns {void}
   */
  dispose(): void {
    for (const visual of this.associations.values()) {
      this._dispose_association(visual);
    }
    this.associations.clear();
    for (const pulse of this.scanning.values()) {
      this.group.remove(pulse);
      pulse.geometry.dispose();
      (pulse.material as THREE.Material).dispose();
    }
    this.scanning.clear();
  }

  /**
   * 创建一条关联的射频可视化。
   *
   * @param {string} key 关联键。
   * @param {number} rssi_dbm 信号强度。
   * @param {THREE.Vector3} sta_position STA 位置。
   * @param {THREE.Vector3} ap_position AP 位置。
   * @returns {void}
   * @private
   */
  private _create_association(
    key: string,
    rssi_dbm: number,
    sta_position: THREE.Vector3,
    ap_position: THREE.Vector3
  ): void {
    const color = rssi_color(rssi_dbm);
    const beam = new THREE.Mesh(
      new THREE.ConeGeometry(1, 1, 22, 1, true),
      new THREE.MeshBasicMaterial({
        color: color,
        transparent: true,
        opacity: 0.07,
        side: THREE.DoubleSide,
        depthWrite: false,
        blending: THREE.AdditiveBlending
      })
    );
    this.group.add(beam);
    const source = new THREE.Mesh(
      new THREE.SphereGeometry(0.26, 18, 14),
      new THREE.MeshBasicMaterial({
        color: color,
        transparent: true,
        opacity: 0.75,
        blending: THREE.AdditiveBlending,
        depthWrite: false
      })
    );
    this.group.add(source);
    const sink = new THREE.Mesh(
      new THREE.SphereGeometry(0.18, 16, 12),
      new THREE.MeshBasicMaterial({
        color: color,
        transparent: true,
        opacity: 0.7,
        blending: THREE.AdditiveBlending,
        depthWrite: false
      })
    );
    this.group.add(sink);
    const frames: THREE.Mesh[] = [];
    for (let index = 0; index < 3; index += 1) {
      const frame = new THREE.Mesh(
        new THREE.BoxGeometry(0.16, 0.16, 0.16),
        new THREE.MeshBasicMaterial({
          color: 0xffffff,
          transparent: true,
          opacity: 0.9,
          blending: THREE.AdditiveBlending,
          depthWrite: false
        })
      );
      frame.visible = false;
      frame.userData.progress = 0;
      this.group.add(frame);
      frames.push(frame);
    }
    const visual: RfAssociationVisual = {
      key: key,
      beam: beam,
      source: source,
      sink: sink,
      frames: frames,
      rssi_dbm: rssi_dbm,
      phase: 0
    };
    this._update_geometry(visual, sta_position, ap_position);
    this.associations.set(key, visual);
  }

  /**
   * 依据两端位置更新波束几何与朝向。
   *
   * @param {RfAssociationVisual} visual 关联可视化。
   * @param {THREE.Vector3} sta_position STA 位置。
   * @param {THREE.Vector3} ap_position AP 位置。
   * @returns {void}
   * @private
   */
  private _update_geometry(
    visual: RfAssociationVisual,
    sta_position: THREE.Vector3,
    ap_position: THREE.Vector3
  ): void {
    const color = rssi_color(visual.rssi_dbm);
    const strength = Math.min(1, Math.max(0, (visual.rssi_dbm + 90) / 55));
    const radius = BEAM_MAX_RADIUS - (BEAM_MAX_RADIUS - BEAM_MIN_RADIUS) * strength;
    const start = ap_position.clone().add(new THREE.Vector3(0, ap_position.y > 0 ? 1.2 : 0.9, 0));
    const end = sta_position.clone().add(new THREE.Vector3(0, 0.55, 0));
    const distance = start.distanceTo(end);
    visual.beam.userData.start = start;
    visual.beam.userData.end = end;
    visual.beam.geometry.dispose();
    visual.beam.geometry = new THREE.ConeGeometry(radius, Math.max(0.2, distance), 24, 1, true);
    visual.beam.position.copy(start.clone().lerp(end, 0.5));
    visual.beam.lookAt(end);
    visual.beam.rotateX(Math.PI / 2);
    const beam_material = visual.beam.material as THREE.MeshBasicMaterial;
    beam_material.color.setHex(color);
    beam_material.opacity = 0.05 + 0.07 * strength;

    for (const mesh of [visual.source, visual.sink]) {
      (mesh.material as THREE.MeshBasicMaterial).color.setHex(color);
      mesh.position.copy(mesh === visual.source ? start : end);
    }
    for (const frame of visual.frames) {
      const material = frame.material as THREE.MeshBasicMaterial;
      material.color.setHex(color);
      material.opacity = 0.85;
    }
  }

  /**
   * 释放一条关联的资源。
   *
   * @param {RfAssociationVisual} visual 关联可视化。
   * @returns {void}
   * @private
   */
  private _dispose_association(visual: RfAssociationVisual): void {
    for (const mesh of [
      visual.beam,

      visual.source,
      visual.sink,
      ...visual.frames
    ]) {
      this.group.remove(mesh);
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
  }
}
