/**
 * @File : web/src/core/radio_model.ts
 * @Time : 2026-10-05 04:35
 * @Author : Cetrp
 * @Description : 浏览器内无线信道模型（与 docs/WIRELESS_RUNTIME_CONTRACT.md §5 同公式）：
 *               离线模式下由它代替外部仿真进程，保证 Wi-Fi 效果在无后端时同样可见。
 */

import { utils } from './constants';

import type { WirelessAccessPoint, WirelessAssociation, WirelessSnapshot } from '../data/types';

/** 2.4GHz 20MHz 长保护间隔的 SNR→MCS 门槛（dB）。 */
const MCS_SNR_THRESHOLDS_DB = [-2, 2, 5, 9, 11, 15, 18, 20, 25, 27, 29, 31];

/** 与 MCS 对应的 PHY 速率（Mbps）。 */
const MCS_RATES_MBPS = [6.5, 13, 19.5, 26, 39, 52, 58.5, 65, 78, 104, 117, 130, 144.4];

/** 默认噪声底（dBm）。 */
const DEFAULT_NOISE_FLOOR_DBM = -95;

/** 默认室内路径损耗指数。 */
const DEFAULT_PATH_LOSS_EXPONENT = 2.8;

/** 默认发射功率（dBm）。 */
const DEFAULT_TX_POWER_DBM = 20;

/** 默认接收灵敏度（dBm），用于计算覆盖半径。 */
const DEFAULT_SENSITIVITY_DBM = -75;

/** 漫游滞回（dB）与漫游判定周期（秒）。 */
const ROAMING_HYSTERESIS_DB = 6;
const ROAMING_PERIOD_SECONDS = 2;

/** 最大重传次数。 */
const MAX_RETRIES = 7;

/** 障碍物（墙）记录。 */
export interface RadioWall {
  x: number;
  z: number;
  attenuation_db: number;
}

/** 无线节点（AP 或 STA）。 */
export interface RadioNode {
  node_id: string;
  kind: 'ap' | 'sta';
  position: { x: number; y: number; z: number };
  ssid?: string;
  channel?: number;
  tx_power_dbm?: number;
  hostname?: string;
}

/** 每台 AP 独立的浏览器模型参数。 */
export interface ApRadioSettings {
  ssid: string;
  channel: number;
  tx_power_dbm: number;
}

function channel_frequency_mhz(channel: number): number {
  return channel <= 13 ? 2407 + channel * 5 : 5000 + channel * 5;
}

/** 因超出覆盖范围而掉线的关联。 */
export interface RadioDrop {
  /** 掉线的 STA。 */
  sta_id: string;
  /** 原关联的 AP。 */
  ap_id: string;
  /** 掉线时的接收电平（dBm）。 */
  rssi_dbm: number;
  /** 掉线原因（目前只有超出覆盖范围）。 */
  reason: 'OUT_OF_RANGE';
}

/** 一次 step 的输出。 */
export interface RadioStepResult {
  associations: WirelessAssociation[];
  /** 本次因超出覆盖范围被断开的关联。 */
  drops: RadioDrop[];
  frames: {
    sta_id: string;
    ap_id: string;
    direction: 'uplink' | 'downlink';
    size_bytes: number;
    mcs: number;
  }[];
  channel_utilization: number;
}

/**
 * 对数距离路径损耗（自由空间参考 + 距离指数）。
 *
 * @param {number} distance_m 距离（米）。
 * @param {number} freq_mhz 频率（MHz）。
 * @param {number} exponent 路径损耗指数。
 * @returns {number} 路径损耗（dB）。
 */
export function path_loss_db(distance_m: number, freq_mhz: number, exponent: number): number {
  const safe_distance = Math.max(0.5, distance_m);
  const reference_loss = 20 * Math.log10(freq_mhz) - 27.55;
  return reference_loss + 10 * exponent * Math.log10(safe_distance);
}

/**
 * 由 SNR 选择 MCS 索引。
 *
 * @param {number} snr_db 信噪比。
 * @returns {number} MCS（0–11）。
 */
export function mcs_from_snr(snr_db: number): number {
  let index = 0;
  for (let i = 0; i < MCS_SNR_THRESHOLDS_DB.length; i += 1) {
    if (snr_db >= MCS_SNR_THRESHOLDS_DB[i]) {
      index = i;
    }
  }
  return index;
}

/**
 * 帧错误率（随 SNR 指数下降）。
 *
 * @param {number} snr_db 信噪比。
 * @param {number} mcs MCS 索引。
 * @returns {number} PER（0.001–0.9）。
 */
export function packet_error_rate(snr_db: number, mcs: number): number {
  const threshold = MCS_SNR_THRESHOLDS_DB[utils.clamp(mcs, 0, MCS_SNR_THRESHOLDS_DB.length - 1)];
  const value = Math.exp(-(snr_db - threshold) / 4);
  return utils.clamp(value, 0.001, 0.9);
}

/**
 * 覆盖半径：使 RSSI ≥ 灵敏度的最大距离。
 *
 * @param {number} tx_power_dbm 发射功率。
 * @param {number} freq_mhz 频率。
 * @param {number} exponent 路径损耗指数。
 * @param {number} sensitivity_dbm 接收灵敏度。
 * @returns {number} 覆盖半径（米）。
 */
export function coverage_radius_m(
  tx_power_dbm: number,
  freq_mhz: number,
  exponent: number,
  sensitivity_dbm: number
): number {
  const reference_loss = 20 * Math.log10(freq_mhz) - 27.55;
  const allowed_loss = tx_power_dbm - sensitivity_dbm - reference_loss;
  return Math.pow(10, allowed_loss / (10 * exponent));
}

/**
 * 浏览器内无线模型：AP/STA 注册、关联、速率自适应、空口共享与漫游。
 */
export class LocalRadioModel {
  /** 节点表。 */
  private nodes = new Map<string, RadioNode>();

  /** AP 表（node_id → 节点）。 */
  private aps = new Map<string, RadioNode>();

  /** 关联表（sta_id → ap_id）。 */
  private associations = new Map<string, string>();

  /** 信道。 */
  private channel = 6;

  /** 频段（MHz，用于路径损耗）。 */
  private freq_mhz = 2437;

  /** 噪声底。 */
  private noise_floor_dbm = DEFAULT_NOISE_FLOOR_DBM;

  /** 路径损耗指数。 */
  private exponent = DEFAULT_PATH_LOSS_EXPONENT;

  /** 接收灵敏度（dBm）：低于该电平视为脱网。 */
  sensitivity_dbm = DEFAULT_SENSITIVITY_DBM;

  /** 障碍物。 */
  private walls: RadioWall[] = [];

  /** 关联统计（重传、吞吐）。 */
  private stats = new Map<
    string,
    { retries: number; throughput_mbps: number; airtime: number; state: string }
  >();

  /** 漫游候选计时。 */
  private roaming_timer = new Map<string, number>();

  /** 随机源（可播种，保证测试可重复）。 */
  private random = Math.random;

  /**
   * 设置信道与障碍物。
   *
   * @param {object} options 配置。
   * @returns {void}
   */
  configure(options: {
    channel?: number;
    band?: string;
    noise_floor_dbm?: number;
    exponent?: number;
    walls?: RadioWall[];
    seed?: number;
  }): void {
    if (options.channel !== undefined) {
      this.channel = options.channel;
      this.freq_mhz =
        options.channel <= 13 ? 2407 + options.channel * 5 : 5000 + options.channel * 5;
      /* 切换信道会重置全部关联。 */
      this.associations.clear();
      this.stats.clear();
    }
    if (options.noise_floor_dbm !== undefined) {
      this.noise_floor_dbm = options.noise_floor_dbm;
    }
    if (options.exponent !== undefined) {
      this.exponent = options.exponent;
    }
    if (options.walls) {
      this.walls = options.walls;
    }
    if (options.seed !== undefined) {
      this.random = utils.seeded_random_source(options.seed);
    }
  }

  /**
   * 注册 AP。
   *
   * @param {RadioNode} node AP 节点。
   * @returns {void}
   */
  add_ap(node: RadioNode): void {
    const record: RadioNode = {
      ...node,
      kind: 'ap',
      channel: node.channel === undefined ? this.channel : node.channel,
      tx_power_dbm: node.tx_power_dbm === undefined ? DEFAULT_TX_POWER_DBM : node.tx_power_dbm,
      ssid: node.ssid || 'SIMLAB-WLAN'
    };
    this.nodes.set(node.node_id, record);
    this.aps.set(node.node_id, record);
  }

  /** 更新 AP 参数；信道切换会断开该 AP 的旧关联。 */
  configure_ap(node_id: string, settings: ApRadioSettings): string[] {
    const ap = this.aps.get(node_id);
    if (!ap) return [];
    const disconnected: string[] = [];
    if (ap.channel !== settings.channel) {
      for (const [sta_id, ap_id] of this.associations.entries()) {
        if (ap_id === node_id) {
          this.disassociate(sta_id);
          disconnected.push(sta_id);
        }
      }
    }
    ap.ssid = settings.ssid;
    ap.channel = settings.channel;
    ap.tx_power_dbm = settings.tx_power_dbm;
    for (const drop of this.check_out_of_range(node_id)) disconnected.push(drop.sta_id);
    return disconnected;
  }

  /**
   * 注册 STA。
   *
   * @param {RadioNode} node STA 节点。
   * @returns {void}
   */
  add_sta(node: RadioNode): void {
    this.nodes.set(node.node_id, { ...node, kind: 'sta' });
  }

  /**
   * 移除节点。
   *
   * @param {string} node_id 节点 ID。
   * @returns {void}
   */
  remove_node(node_id: string): void {
    this.nodes.delete(node_id);
    this.aps.delete(node_id);
    this.associations.delete(node_id);
    this.stats.delete(node_id);
  }

  /**
   * 更新节点位置。
   *
   * @param {string} node_id 节点 ID。
   * @param {object} position 位置。
   * @returns {void}
   */
  set_position(node_id: string, position: { x: number; y: number; z: number }): void {
    const node = this.nodes.get(node_id);
    if (node) {
      node.position = { ...position };
    }
  }

  /**
   * 节点是否存在。
   *
   * @param {string} node_id 节点 ID。
   * @returns {boolean} 是否存在。
   */
  has_node(node_id: string): boolean {
    return this.nodes.has(node_id);
  }

  /**
   * 计算 STA 到 AP 的 RSSI。
   *
   * @param {string} sta_id STA。
   * @param {string} ap_id AP。
   * @returns {number} RSSI（dBm）。
   */
  rssi(sta_id: string, ap_id: string): number {
    const sta = this.nodes.get(sta_id);
    const ap = this.aps.get(ap_id);
    if (!sta || !ap) {
      return -120;
    }
    const distance = Math.hypot(
      sta.position.x - ap.position.x,
      sta.position.y - ap.position.y,
      sta.position.z - ap.position.z
    );
    const wall_loss = this._wall_loss(sta.position, ap.position);
    const loss = path_loss_db(
      distance, channel_frequency_mhz(ap.channel ?? this.channel), this.exponent
    ) + wall_loss;
    return (ap.tx_power_dbm ?? DEFAULT_TX_POWER_DBM) - loss;
  }

  /**
   * 计算 STA 到 AP 的距离。
   *
   * @param {string} sta_id STA。
   * @param {string} ap_id AP。
   * @returns {number} 距离（米）。
   */
  distance(sta_id: string, ap_id: string): number {
    const sta = this.nodes.get(sta_id);
    const ap = this.aps.get(ap_id);
    if (!sta || !ap) {
      return Number.NaN;
    }
    return Math.hypot(
      sta.position.x - ap.position.x,
      sta.position.y - ap.position.y,
      sta.position.z - ap.position.z
    );
  }

  /**
   * 计算连接两点之间的墙体衰减。
   *
   * @param {object} from 起点。
   * @param {object} to 终点。
   * @returns {number} 衰减（dB）。
   * @private
   */
  private _wall_loss(from: { x: number; z: number }, to: { x: number; z: number }): number {
    let loss = 0;
    for (const wall of this.walls) {
      const crosses =
        (wall.x - from.x) * (wall.x - to.x) <= 0 && (wall.z - from.z) * (wall.z - to.z) <= 0;
      if (crosses) {
        loss += wall.attenuation_db;
      }
    }
    return loss;
  }

  /**
   * 关联（ap_id 省略时自动选择最强 AP）。
   *
   * @param {string} sta_id STA。
   * @param {string} [ap_id] AP。
   * @returns {WirelessAssociation | null} 关联记录。
   */
  associate(sta_id: string, ap_id?: string): WirelessAssociation | null {
    const sta = this.nodes.get(sta_id);
    if (!sta || sta.kind !== 'sta') {
      return null;
    }
    let target = ap_id;
    if (!target) {
      target = this.best_ap(sta_id);
      if (!target) {
        return null;
      }
    }
    if (!this.aps.has(target)) {
      return null;
    }
    this.associations.set(sta_id, target);
    this.stats.set(sta_id, { retries: 0, throughput_mbps: 0, airtime: 0, state: 'ASSOCIATED' });
    this.roaming_timer.set(sta_id, 0);
    return this._association_record(sta_id);
  }

  /**
   * 解除关联。
   *
   * @param {string} sta_id STA。
   * @returns {void}
   */
  disassociate(sta_id: string): void {
    this.associations.delete(sta_id);
    this.stats.delete(sta_id);
    this.roaming_timer.delete(sta_id);
  }

  /**
   * 立即检查并断开超出覆盖范围的关联（拖动设备时调用，无需等到下一次 step）。
   *
   * @param {string} node_id 发生移动的节点（STA 或 AP）；AP 移动时其下所有 STA 一并判定。
   * @returns {RadioDrop[]} 被断开的关联。
   */
  check_out_of_range(node_id: string): RadioDrop[] {
    const drops: RadioDrop[] = [];
    for (const [sta_id, ap_id] of [...this.associations.entries()]) {
      if (sta_id !== node_id && ap_id !== node_id) {
        continue;
      }
      const level = this.rssi(sta_id, ap_id);
      if (Number.isFinite(level) && level >= this.sensitivity_dbm) {
        continue;
      }
      this.disassociate(sta_id);
      drops.push({
        sta_id: sta_id,
        ap_id: ap_id,
        rssi_dbm: Number.isFinite(level) ? Number(level.toFixed(2)) : Number.NEGATIVE_INFINITY,
        reason: 'OUT_OF_RANGE'
      });
    }

    return drops;
  }

  /**
   * 选择信号最强的 AP。
   *
   * @param {string} sta_id STA。
   * @returns {string | null} AP ID。
   */
  best_ap(sta_id: string): string | null {
    let best: string | null = null;
    let best_rssi = -Infinity;
    for (const ap_id of this.aps.keys()) {
      const value = this.rssi(sta_id, ap_id);
      if (value > best_rssi) {
        best_rssi = value;
        best = ap_id;
      }
    }
    return best;
  }

  /**
   * 构造关联记录。
   *
   * @param {string} sta_id STA。
   * @returns {WirelessAssociation | null} 记录。
   * @private
   */
  private _association_record(sta_id: string): WirelessAssociation | null {
    const ap_id = this.associations.get(sta_id);
    if (!ap_id) {
      return null;
    }
    const stats = this.stats.get(sta_id) || {
      retries: 0,
      throughput_mbps: 0,
      airtime: 0,
      state: 'IDLE'
    };
    const rssi = this.rssi(sta_id, ap_id);
    const snr = rssi - this.noise_floor_dbm;
    const mcs = mcs_from_snr(snr);
    return {
      sta_device_id: sta_id,
      ap_device_id: ap_id,
      state: stats.state,
      rssi_dbm: Number(rssi.toFixed(1)),
      snr_db: Number(snr.toFixed(1)),
      phy_rate_mbps: MCS_RATES_MBPS[mcs],
      mcs: mcs,
      retries: stats.retries,
      throughput_mbps: Number(stats.throughput_mbps.toFixed(1)),
      distance_m: Number(this.distance(sta_id, ap_id).toFixed(2))
    };
  }

  /**
   * 推进仿真：吞吐、重传、漫游与空中帧。
   *
   * @param {number} dt 时间步长（秒）。
   * @returns {RadioStepResult} 本步结果。
   */
  step(dt: number): RadioStepResult {
    const frames: RadioStepResult['frames'] = [];
    const drops: RadioDrop[] = [];
    for (const sta_id of [...this.associations.keys()]) {
      const ap_id = this.associations.get(sta_id);
      if (!ap_id) {
        continue;
      }
      /* 移出覆盖范围 → 立即脱网（真机表现为"信号丢失，连接断开"）。 */
      const level = this.rssi(sta_id, ap_id);
      if (!Number.isFinite(level) || level < this.sensitivity_dbm) {
        this.disassociate(sta_id);
        drops.push({
          sta_id: sta_id,
          ap_id: ap_id,
          rssi_dbm: Number.isFinite(level) ? Number(level.toFixed(2)) : Number.NEGATIVE_INFINITY,
          reason: 'OUT_OF_RANGE'
        });
        continue;
      }
      const record = this._association_record(sta_id);
      if (!record) {
        continue;
      }
      const per = packet_error_rate(record.snr_db, record.mcs || 0);
      const stats = this.stats.get(sta_id)!;

      /* 空口竞争：同 AP 下的 STA 数越多，单站 airtime 越少。 */
      const peers = [...this.associations.values()].filter((item) => item === ap_id).length || 1;
      const airtime_share = utils.clamp(1 / peers, 0.05, 1);
      const throughput = record.phy_rate_mbps * (1 - per) * airtime_share * 0.85;
      stats.throughput_mbps = utils.lerp(stats.throughput_mbps, throughput, Math.min(1, dt));
      stats.airtime = airtime_share;
      stats.retries += Math.round(this.random() * per * 8);
      if (per > 0.6 && stats.retries > MAX_RETRIES * 3) {
        stats.state = 'FAILED';
      } else if (stats.state !== 'ROAMING') {
        stats.state = 'ASSOCIATED';
      }

      /* 空中帧：按吞吐折算，保证 3D 动画有稳定输入。 */
      const frames_per_step = utils.clamp(Math.round(throughput * dt * 0.6), 0, 12);
      for (let i = 0; i < frames_per_step; i += 1) {
        frames.push({
          sta_id: sta_id,
          ap_id: ap_id,
          direction: this.random() < 0.5 ? 'uplink' : 'downlink',
          size_bytes: Math.round(64 + this.random() * 1400),
          mcs: record.mcs || 0
        });
      }

      /* 漫游判定：存在强于当前 AP 超过滞回的邻居且持续一段时间。 */
      const best = this.best_ap(sta_id);
      if (
        best &&
        best !== ap_id &&
        this.rssi(sta_id, best) > record.rssi_dbm + ROAMING_HYSTERESIS_DB
      ) {
        const elapsed = (this.roaming_timer.get(sta_id) || 0) + dt;
        this.roaming_timer.set(sta_id, elapsed);
        if (elapsed >= ROAMING_PERIOD_SECONDS) {
          this.associations.set(sta_id, best);
          stats.state = 'ROAMING';
          this.roaming_timer.set(sta_id, 0);
        }
      } else {
        this.roaming_timer.set(sta_id, 0);
      }
    }

    /* 仿真时间推进后，漫游状态回归 ASSOCIATED（下一次 step 生效）。 */
    for (const [sta_id, stats] of this.stats.entries()) {
      if (stats.state === 'ROAMING' && this.roaming_timer.get(sta_id) === 0) {
        const record = this._association_record(sta_id);
        if (record && record.rssi_dbm > this.noise_floor_dbm + 5) {
          stats.state = 'ASSOCIATED';
        }
      }
    }

    return {
      associations: this.associations_snapshot(),
      frames: frames,
      channel_utilization: this._channel_utilization(),
      drops: drops
    };
  }

  /**
   * 关联快照。
   *
   * @returns {WirelessAssociation[]} 关联记录。
   */
  associations_snapshot(): WirelessAssociation[] {
    const result: WirelessAssociation[] = [];
    for (const sta_id of this.associations.keys()) {
      const record = this._association_record(sta_id);
      if (record) {
        result.push(record);
      }
    }
    return result;
  }

  /**
   * AP 快照（含覆盖半径与客户端数）。
   *
   * @param {(node_id: string) => string} [hostname_of] 设备名解析函数。
   * @returns {WirelessAccessPoint[]} AP 列表。
   */
  aps_snapshot(hostname_of?: (node_id: string) => string): WirelessAccessPoint[] {
    const utilization = this._channel_utilization();
    const result: WirelessAccessPoint[] = [];
    for (const [ap_id, ap] of this.aps.entries()) {
      result.push({
        device_id: ap_id,
        ssid: ap.ssid || 'SIMLAB-WLAN',
        channel: ap.channel ?? this.channel,
        tx_power_dbm: ap.tx_power_dbm ?? DEFAULT_TX_POWER_DBM,
        coverage_radius_m: Number(
          coverage_radius_m(
            ap.tx_power_dbm ?? DEFAULT_TX_POWER_DBM,
            channel_frequency_mhz(ap.channel ?? this.channel),
            this.exponent,
            DEFAULT_SENSITIVITY_DBM
          ).toFixed(1)
        ),
        position: { ...ap.position },
        client_count: [...this.associations.values()].filter((item) => item === ap_id).length,
        channel_utilization: Number(utilization.toFixed(2))
      });
    }
    return result;
  }

  /**
   * 完整状态快照。
   *
   * @param {(node_id: string) => string} [hostname_of] 设备名解析函数。
   * @returns {WirelessSnapshot} 快照。
   */
  snapshot(hostname_of?: (node_id: string) => string): WirelessSnapshot {
    return {
      success: true,
      runtime: {
        adapter: 'browser-local',
        process: 'radio_model.ts',
        alive: true,
        channel: this.channel,
        band: this.freq_mhz < 3000 ? '2.4GHz' : '5GHz'
      },
      aps: this.aps_snapshot(hostname_of),
      associations: this.associations_snapshot()
    };
  }

  /**
   * 信道利用率（所有 AP 的 airtime 之和）。
   *
   * @returns {number} 0–1。
   * @private
   */
  private _channel_utilization(): number {
    let total = 0;
    for (const stats of this.stats.values()) {
      total += stats.airtime * 0.5;
    }
    return utils.clamp(total, 0, 0.98);
  }
}
