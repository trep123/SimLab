/**
 * @File : web/src/core/event_bus.ts
 * @Time : 2026-10-04 09:10
 * @Author : Cetrp
 * @Description : 事件总线（任务书 §18）：Runtime 事件经此投影到界面、日志与评分模块。
 */

import { utils } from './constants';
import type { SimlabEvent } from '../data/types';

/** 事件历史默认保留条数。 */
const DEFAULT_HISTORY_LIMIT = 500;

/**
 * 事件总线：发布订阅 + 环形事件历史。
 *
 * 前端只把事件当作事实同步源，禁止在界面层直接改写设备状态。
 */
class EventBus {
  /** 事件处理函数表：事件类型 → 处理函数集合。 */
  private _handlers: Map<string, Set<(event: SimlabEvent) => void>>;

  /** 事件历史（环形缓冲）。 */
  private _history: SimlabEvent[];

  /** 历史上限。 */
  private _history_limit: number;

  /** 事件序号。 */
  private _sequence: number;

  /**
   * @param {object} options 配置项。
   * @param {number} [options.history_limit] 事件历史上限。
   */
  constructor(options) {
    const settings = options || {};
    this._handlers = new Map();
    this._history = [];
    this._history_limit = settings.history_limit || DEFAULT_HISTORY_LIMIT;
    this._sequence = 0;
  }

  /**
   * 订阅事件。
   *
   * @param {string} event_type 事件类型，支持 '*' 通配。
   * @param {Function} handler 处理函数，入参为事件对象。
   * @returns {Function} 取消订阅函数。
   */
  subscribe(event_type, handler) {
    if (typeof handler !== 'function') {
      throw new TypeError('事件处理函数必须是 function');
    }
    if (!this._handlers.has(event_type)) {
      this._handlers.set(event_type, new Set());
    }
    this._handlers.get(event_type).add(handler);
    return () => this.unsubscribe(event_type, handler);
  }

  /**
   * 取消订阅。
   *
   * @param {string} event_type 事件类型。
   * @param {Function} handler 处理函数。
   * @returns {boolean} 是否成功移除。
   */
  unsubscribe(event_type, handler) {
    const handlers = this._handlers.get(event_type);
    if (!handlers) {
      return false;
    }
    return handlers.delete(handler);
  }

  /**
   * 发布事件。
   *
   * @param {object} event 事件对象，至少包含 event_type。
   * @returns {object} 补全字段后的事件对象。
   */
  publish(event) {
    const payload = event || {};
    this._sequence += 1;
    const full_event = Object.assign(
      {
        event_id: 'evt_' + String(this._sequence).padStart(6, '0'),
        timestamp: new Date().toISOString(),
        experiment_id: null,
        device_id: null,
        data: {}
      },
      payload
    );

    this._history.push(full_event);
    if (this._history.length > this._history_limit) {
      this._history.splice(0, this._history.length - this._history_limit);
    }

    this._dispatch(full_event.event_type, full_event);
    return full_event;
  }

  /**
   * 读取事件历史。
   *
   * @param {object} [filter] 过滤条件，支持 event_type、device_id、limit。
   * @returns {object[]} 事件数组（时间升序）。
   */
  history(filter) {
    const condition = filter || {};
    let result = this._history.slice();
    if (condition.event_type) {
      result = result.filter((item) => item.event_type === condition.event_type);
    }
    if (condition.device_id) {
      result = result.filter((item) => item.device_id === condition.device_id);
    }
    if (condition.limit && result.length > condition.limit) {
      result = result.slice(result.length - condition.limit);
    }
    return result;
  }

  /**
   * 清空历史与订阅。
   *
   * @returns {void}
   */
  reset() {
    this._history.length = 0;
    this._handlers.clear();
    this._sequence = 0;
  }

  /**
   * 分发给具体类型与通配订阅者。
   *
   * @param {string} event_type 事件类型。
   * @param {object} event 事件对象。
   * @returns {void}
   * @private
   */
  _dispatch(event_type, event) {
    const targets = [];
    const exact = this._handlers.get(event_type);
    if (exact) {
      targets.push(...exact);
    }
    const wildcard = this._handlers.get('*');
    if (wildcard) {
      targets.push(...wildcard);
    }
    for (const handler of targets) {
      try {
        handler(event);
      } catch (error) {
        // 单个订阅者异常不能阻断其它投影器，这里记录到控制台调试通道。
        if (console && console.warn) {
          console.warn('事件订阅者执行失败: ' + event_type, error);
        }
      }
    }
  }
}

/**
 * 生成带序号的命令 ID。
 *
 * @param {string} prefix 前缀。
 * @returns {string} 命令 ID。
 */
function make_id(prefix) {
  const random_part = Math.floor(utils.rnd(0, 0xffffff)).toString(16).padStart(6, '0');
  return prefix + '_' + Date.now().toString(36) + random_part;
}

export { EventBus, make_id };
