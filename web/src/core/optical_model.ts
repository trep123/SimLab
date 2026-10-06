/**
 * @File : web/src/core/optical_model.ts
 * @Time : 2026-10-05 13:40
 * @Author : Cetrp
 * @Description : 浏览器内 GPON 光链路模型（与 docs/OPTICAL_RUNTIME_CONTRACT.md §5 同公式）：
 *               光纤衰减、分光器插损、接收光功率、余量、测距 RTD、BER 与 DBA 带宽分配。
 */

import { utils } from './constants';

/** 波长相关衰减（dB/km）。 */
const FIBER_ATTENUATION_DB_PER_KM: Record<number, number> = {
  1310: 0.35,
  1490: 0.22,
  1550: 0.2
};

/** 分光器典型插损（dB）。 */
const SPLITTER_LOSS_DB: Record<number, number> = {
  2: 3.5,
  4: 7.2,
  8: 10.5,
  16: 13.7,
  32: 16.5,
  64: 20.0
};

/** 单模光纤群折射率（G.652）。 */
const GROUP_INDEX = 1.468;

/** 光速（m/s）。 */
const LIGHT_SPEED = 299792458;

/** 默认参数。 */
const DEFAULTS = {
  olt_tx_power_dbm: 3.0,
  wavelength_down_nm: 1490,
  onu_sensitivity_dbm: -28,
  onu_overload_dbm: -8,
  los_threshold_dbm: -30,
  connector_loss_db: 0.5,
  splice_loss_db: 0.1,
  max_distance_m: 20000,
  downstream_capacity_mbps: 2488,
  upstream_capacity_mbps: 1244,
  guaranteed_mbps: 128,
  max_mbps: 1024
};

/** OLT 记录。 */
export interface OpticalOlt {
  node_id: string;
  pon_ports: number;
  tx_power_dbm: number;
  onu_count: number;
  downstream_capacity_mbps: number;
  upstream_capacity_mbps: number;
  downstream_used_mbps: number;
  upstream_used_mbps: number;
}

/** 光链路记录（契约 §4）。 */
export interface OpticalLink {
  onu_id: string;
  olt_id: string;
  pon_port: number;
  fiber_length_m: number;
  splitter_ratio: number;
  connectors: number;
  splices: number;
  fiber_loss_db: number;
  splitter_loss_db: number;
  connector_loss_db: number;
  splice_loss_db: number;
  total_loss_db: number;
  rx_power_dbm: number;
  power_margin_db: number;
  rtd_ns: number;
  distance_m: number;
  state: string;
  alarm: string | null;
  /** 光纤是否断开（断纤时无光，接收光功率视为 −40 dBm）。 */
  broken: boolean;
  ber: number;
  downstream_mbps: number;
  upstream_mbps: number;
  downstream_allocated_mbps: number;
  upstream_allocated_mbps: number;
  last_change: string;
}

/** 告警记录。 */
export interface OpticalAlarm {
  onu_id: string;
  code: string;
  message: string;
  at: string;
}

/** 光链路快照。 */
export interface OpticalSnapshot {
  success: boolean;
  runtime: { adapter: string; process: string; alive: boolean; c_lib: boolean };
  olts: OpticalOlt[];
  links: OpticalLink[];
  alarms: OpticalAlarm[];
}

/**
 * 光纤衰减。
 *
 * @param {number} length_m 光纤长度（米）。
 * @param {number} wavelength_nm 波长（nm）。
 * @returns {number} 衰减（dB）。
 */
export function fiber_loss_db(length_m: number, wavelength_nm: number): number {
  const per_km = FIBER_ATTENUATION_DB_PER_KM[wavelength_nm] || 0.25;
  return (per_km * length_m) / 1000;
}

/**
 * 分光器插损。
 *
 * @param {number} split_ratio 分光比（2/4/8/16/32/64）。
 * @returns {number} 插损（dB）。
 */
export function splitter_loss_db(split_ratio: number): number {
  return SPLITTER_LOSS_DB[split_ratio] || SPLITTER_LOSS_DB[8];
}

/**
 * 往返测距时间（Ranging Time，ns）。
 *
 * @param {number} distance_m 距离（米）。
 * @returns {number} RTD（纳秒）。
 */
export function rtd_ns(distance_m: number): number {
  return ((2 * distance_m * GROUP_INDEX) / LIGHT_SPEED) * 1e9;
}

/**
 * 由接收光功率判定状态。
 *
 * @param {number} rx_power_dbm 接收光功率。
 * @param {number} sensitivity_dbm 灵敏度。
 * @param {number} overload_dbm 过载点。
 * @param {number} los_threshold_dbm LOS 门限。
 * @returns {string} 状态码。
 */
export function state_from_rx(
  rx_power_dbm: number,
  sensitivity_dbm: number,
  overload_dbm: number,
  los_threshold_dbm: number
): string {
  if (rx_power_dbm > overload_dbm) {
    return 'OVERLOAD';
  }
  if (rx_power_dbm >= sensitivity_dbm) {
    return rx_power_dbm - sensitivity_dbm < 3 ? 'MARGINAL' : 'WORKING';
  }
  if (rx_power_dbm >= los_threshold_dbm) {
    return 'LOF';
  }
  return rx_power_dbm < -33 ? 'DYING_GASP' : 'LOS';
}

/**
 * 误码率分档。
 *
 * @param {number} margin_db 功率余量。
 * @returns {number} BER。
 */
export function ber_from_margin(margin_db: number): number {
  if (margin_db >= 6) {
    return 1e-12;
  }
  if (margin_db >= 3) {
    return 1e-9;
  }
  if (margin_db >= 0) {
    return 1e-6;
  }
  return 1e-3;
}

/**
 * 浏览器内光链路模型。
 */
export class LocalOpticalModel {
  /** OLT 表。 */
  private olts = new Map<string, OpticalOlt>();

  /** 链路表（onu_id → 链路）。 */
  private links = new Map<string, OpticalLink>();

  /** 最近一次步进产生 / 仍在持续中的告警。 */
  private alarms = new Map<string, OpticalAlarm>();

  /** 参数。 */
  private params = { ...DEFAULTS };

  /**
   * 应用全局光参数。
   *
   * @param {Partial<typeof DEFAULTS>} options 参数。
   * @returns {void}
   */
  configure(options: Partial<typeof DEFAULTS>): void {
    this.params = { ...this.params, ...options };
  }

  /**
   * 注册 OLT。
   *
   * @param {object} node OLT 描述。
   * @param {string} node.node_id 设备 ID。
   * @param {number} [node.pon_ports] PON 口数量。
   * @param {number} [node.tx_power_dbm] 发光功率。
   * @returns {void}
   */
  add_olt(node: { node_id: string; pon_ports?: number; tx_power_dbm?: number }): void {
    this.olts.set(node.node_id, {
      node_id: node.node_id,
      pon_ports: node.pon_ports || 2,
      tx_power_dbm:
        node.tx_power_dbm === undefined ? this.params.olt_tx_power_dbm : node.tx_power_dbm,
      onu_count: 0,
      downstream_capacity_mbps: this.params.downstream_capacity_mbps,
      upstream_capacity_mbps: this.params.upstream_capacity_mbps,
      downstream_used_mbps: 0,
      upstream_used_mbps: 0
    });
  }

  /**
   * 注册 ONU 并绑定 OLT。
   *
   * @param {object} node ONU 描述。
   * @param {string} node.node_id ONU 设备 ID。
   * @param {string} node.olt_id OLT 设备 ID。
   * @param {number} [node.pon_port] PON 口。
   * @param {number} [node.fiber_length_m] 光纤长度（米）。
   * @param {number} [node.splitter_ratio] 分光比。
   * @param {number} [node.connectors] 连接器数量。
   * @param {number} [node.splices] 熔接点数量。
   * @returns {OpticalLink | null} 链路记录。
   */
  add_onu(node: {
    node_id: string;
    olt_id: string;
    pon_port?: number;
    fiber_length_m?: number;
    splitter_ratio?: number;
    connectors?: number;
    splices?: number;
  }): OpticalLink | null {
    const olt = this.olts.get(node.olt_id);
    if (!olt) {
      return null;
    }
    const link: OpticalLink = {
      onu_id: node.node_id,
      olt_id: node.olt_id,
      pon_port: node.pon_port || 1,
      fiber_length_m: node.fiber_length_m === undefined ? 1000 : node.fiber_length_m,
      splitter_ratio: node.splitter_ratio || 8,
      connectors: node.connectors === undefined ? 2 : node.connectors,
      splices: node.splices === undefined ? 1 : node.splices,
      fiber_loss_db: 0,
      splitter_loss_db: 0,
      connector_loss_db: 0,
      splice_loss_db: 0,
      total_loss_db: 0,
      rx_power_dbm: 0,
      power_margin_db: 0,
      rtd_ns: 0,
      distance_m: node.fiber_length_m === undefined ? 1000 : node.fiber_length_m,
      state: 'WORKING',
      alarm: null,
      broken: false,
      ber: 1e-12,
      downstream_mbps: 0,
      upstream_mbps: 0,
      downstream_allocated_mbps: 0,
      upstream_allocated_mbps: 0,
      last_change: new Date().toISOString()
    };
    this.links.set(node.node_id, link);
    this._recompute(link);
    this._refresh_olt_counts();
    return link;
  }

  /**
   * 移除节点（OLT 会级联移除其 ONU）。
   *
   * @param {string} node_id 节点 ID。
   * @returns {void}
   */
  remove_node(node_id: string): void {
    this.olts.delete(node_id);
    for (const [onu_id, link] of [...this.links.entries()]) {
      if (onu_id === node_id || link.olt_id === node_id) {
        this.links.delete(onu_id);
        this.alarms.delete(onu_id);
      }
    }
    this._refresh_olt_counts();
  }

  /**
   * 变更光纤参数。
   *
   * @param {string} onu_id ONU 设备 ID。
   * @param {object} options 光纤参数。
   * @returns {OpticalLink | null} 链路记录。
   */
  set_fiber(
    onu_id: string,
    options: {
      fiber_length_m?: number;
      splitter_ratio?: number;
      connectors?: number;
      splices?: number;
      broken?: boolean;
    }
  ): OpticalLink | null {
    const link = this.links.get(onu_id);
    if (!link) {
      return null;
    }
    if (options.broken !== undefined) {
      link.broken = options.broken;
    }
    if (options.fiber_length_m !== undefined) {
      link.fiber_length_m = options.fiber_length_m;
      link.distance_m = options.fiber_length_m;
    }
    if (options.splitter_ratio !== undefined) {
      link.splitter_ratio = options.splitter_ratio;
    }
    if (options.connectors !== undefined) {
      link.connectors = options.connectors;
    }
    if (options.splices !== undefined) {
      link.splices = options.splices;
    }
    this._recompute(link);
    link.last_change = new Date().toISOString();
    return link;
  }

  /**
   * 设置 ONU 业务负载。
   *
   * @param {string} onu_id ONU 设备 ID。
   * @param {object} traffic 上下行需求（Mbps）。
   * @returns {OpticalLink | null} 链路记录。
   */
  set_traffic(
    onu_id: string,
    traffic: { downstream_mbps?: number; upstream_mbps?: number }
  ): OpticalLink | null {
    const link = this.links.get(onu_id);
    if (!link) {
      return null;
    }
    if (traffic.downstream_mbps !== undefined) {
      link.downstream_mbps = traffic.downstream_mbps;
    }
    if (traffic.upstream_mbps !== undefined) {
      link.upstream_mbps = traffic.upstream_mbps;
    }
    this._allocate();
    return link;
  }

  /**
   * 推进仿真：DBA 收敛 + 告警。
   *
   * @param {number} dt 时间步长（秒）。
   * @returns {{links: OpticalLink[]; olts: OpticalOlt[]; alarms: OpticalAlarm[]}} 本步结果。
   */
  step(dt: number): { links: OpticalLink[]; olts: OpticalOlt[]; alarms: OpticalAlarm[] } {
    void dt;
    for (const link of this.links.values()) {
      this._recompute(link);
    }
    this._allocate();
    this._refresh_olt_counts();
    return {
      links: [...this.links.values()].map((link) => ({ ...link })),
      olts: [...this.olts.values()].map((olt) => ({ ...olt })),
      alarms: [...this.alarms.values()].map((alarm) => ({ ...alarm }))
    };
  }

  /**
   * 完整状态快照。
   *
   * @returns {OpticalSnapshot} 快照。
   */
  snapshot(): OpticalSnapshot {
    return {
      success: true,
      runtime: { adapter: 'browser-local', process: 'optical_model.ts', alive: true, c_lib: false },
      olts: [...this.olts.values()].map((olt) => ({ ...olt })),
      links: [...this.links.values()].map((link) => ({ ...link })),
      alarms: [...this.alarms.values()].map((alarm) => ({ ...alarm }))
    };
  }

  /**
   * 是否存在该节点。
   *
   * @param {string} node_id 节点 ID。
   * @returns {boolean} 是否存在。
   */
  has_olt(node_id: string): boolean {
    return this.olts.has(node_id);
  }

  /**
   * 是否存在该 ONU 链路。
   *
   * @param {string} onu_id ONU 设备 ID。
   * @returns {boolean} 是否存在。
   */
  has_onu(onu_id: string): boolean {
    return this.links.has(onu_id);
  }

  /**
   * 重算单条链路的光功率与状态。
   *
   * @param {OpticalLink} link 链路记录。
   * @returns {void}
   * @private
   */
  private _recompute(link: OpticalLink): void {
    const olt = this.olts.get(link.olt_id);
    const tx_power = olt ? olt.tx_power_dbm : this.params.olt_tx_power_dbm;
    link.fiber_loss_db = fiber_loss_db(link.fiber_length_m, this.params.wavelength_down_nm);
    link.splitter_loss_db = splitter_loss_db(link.splitter_ratio);
    link.connector_loss_db = link.connectors * this.params.connector_loss_db;
    link.splice_loss_db = link.splices * this.params.splice_loss_db;
    link.total_loss_db =
      link.fiber_loss_db + link.splitter_loss_db + link.connector_loss_db + link.splice_loss_db;
    /* 断纤时无光到达：接收光功率按 −40 dBm 处理（低于 LOS 门限，触发 DYING_GASP/LOS）。 */
    link.rx_power_dbm = link.broken ? -40 : tx_power - link.total_loss_db;
    link.power_margin_db = link.rx_power_dbm - this.params.onu_sensitivity_dbm;
    link.rtd_ns = rtd_ns(link.distance_m);
    link.ber = ber_from_margin(link.power_margin_db);
    link.state = state_from_rx(
      link.rx_power_dbm,
      this.params.onu_sensitivity_dbm,
      this.params.onu_overload_dbm,
      this.params.los_threshold_dbm
    );
    link.alarm = link.broken
      ? 'LOS'
      : link.state === 'LOS' || link.state === 'DYING_GASP'
        ? link.state
        : link.state === 'OVERLOAD'
          ? 'OVERLOAD'
          : link.state === 'LOF'
            ? 'LOF'
            : link.fiber_length_m > this.params.max_distance_m
              ? 'FIBER_LIMIT'
              : null;
    const existing = this.alarms.get(link.onu_id);
    if (link.alarm) {
      this.alarms.set(link.onu_id, {
        onu_id: link.onu_id,
        code: link.alarm,
        message:
          'ONU 接收光功率 ' +
          link.rx_power_dbm.toFixed(2) +
          ' dBm（门限 ' +
          this.params.los_threshold_dbm +
          ' dBm，余量 ' +
          link.power_margin_db.toFixed(2) +
          ' dB）',
        at: existing && existing.code === link.alarm ? existing.at : new Date().toISOString()
      });
    } else {
      this.alarms.delete(link.onu_id);
    }
  }

  /**
   * DBA 带宽分配：先保底，再按需求比例分配剩余带宽。
   *
   * @returns {void}
   * @private
   */
  private _allocate(): void {
    for (const olt of this.olts.values()) {
      const links = [...this.links.values()].filter((link) => link.olt_id === olt.node_id);
      const allocate = (
        capacity: number,
        demand_of: (link: OpticalLink) => number,
        assigned: (link: OpticalLink, value: number) => void
      ): number => {
        if (links.length === 0) {
          return 0;
        }
        const guaranteed_total = links.length * this.params.guaranteed_mbps;
        let remaining = Math.max(0, capacity - guaranteed_total);
        const demands = links.map((link) => Math.max(0, demand_of(link)));
        const total_demand = demands.reduce((sum, value) => sum + value, 0);
        let used = 0;
        links.forEach((link, index) => {
          const guaranteed = Math.min(this.params.guaranteed_mbps, Math.max(0, demands[index]));
          const share = total_demand > 0 ? (demands[index] / total_demand) * remaining : 0;
          const extra = Math.min(
            share,
            Math.max(0, this.params.max_mbps - guaranteed),
            Math.max(0, demands[index] - guaranteed)
          );
          const value = utils.clamp(guaranteed + extra, 0, this.params.max_mbps);
          remaining -= extra;
          assigned(link, Number(value.toFixed(1)));
          used += value;
        });
        return Number(used.toFixed(1));
      };

      olt.downstream_used_mbps = allocate(
        olt.downstream_capacity_mbps,
        (link) => link.downstream_mbps,
        (link, value) => {
          link.downstream_allocated_mbps = value;
        }
      );
      olt.upstream_used_mbps = allocate(
        olt.upstream_capacity_mbps,
        (link) => link.upstream_mbps,
        (link, value) => {
          link.upstream_allocated_mbps = value;
        }
      );
    }
  }

  /**
   * 刷新 OLT 上的 ONU 计数。
   *
   * @returns {void}
   * @private
   */
  private _refresh_olt_counts(): void {
    for (const olt of this.olts.values()) {
      olt.onu_count = [...this.links.values()].filter((link) => link.olt_id === olt.node_id).length;
    }
  }
}
