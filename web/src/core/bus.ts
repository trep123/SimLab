/**
 * @File : web/src/core/bus.ts
 * @Time : 2026-10-05 06:30
 * @Author : Cetrp
 * @Description : 全局事件总线单例：本地运行时与远端运行时共用，界面通过它做状态投影。
 */

import { EventBus } from './event_bus';

/** 全局事件总线（保留最近 800 条事件）。 */
export const bus = new EventBus({ history_limit: 800 });
