/**
 * @File : web/src/devices/template_types.ts
 * @Time : 2026-10-05 20:10
 * @Author : Cetrp
 * @Description : 设备模板契约：每个设备型号一个模板模块，模板由参数化部件装配而成；
 *               模板只描述"长什么样、有哪些接口、如何组装"，行为（转发/CLI/仿真）仍由运行时承担。
 */

import type * as THREE from 'three';

/** 部件类别：决定在设备工坊里归入哪个部件栏。 */
export type PartCategory =
  | 'chassis'
  | 'front_panel'
  | 'port_module'
  | 'power'
  | 'cooling'
  | 'wireless'
  | 'compute'
  | 'internal'
  | 'accessory';

/** 连接器类型：决定线缆栏里哪些线缆可以插上去。 */
export type ConnectorType =
  | 'rj45'
  | 'sfp'
  | 'sfp_plus'
  | 'gpon'
  | 'console_rj45'
  | 'usb'
  | 'power_iec_c14'
  | 'power_dc_barrel'
  | 'power_dc_terminal'
  | 'antenna_sma';

/** 端口槽位描述：一个物理开口 + 一个用于接线/插拔的连接器锚点。 */
export interface PortSlotSpec {
  /** 端口短名（与 Manifest 端口号一致，例如 GE0/0/1）。 */
  short_name: string;
  /** 端口全名。 */
  name: string;
  /** 连接器类型。 */
  connector: ConnectorType;
  /** 速率（bps），0 表示非数据口（电源/Console）。 */
  speed_bps: number;
  /** 槽位局部坐标（模板坐标系，原点在设备中心底部）。 */
  position: [number, number, number];
  /** 锚点朝向（连接器插入方向，归一化向量），线缆从这里长出。 */
  direction: [number, number, number];
  /** 标签文本（丝印，缺省取 short_name）。 */
  label?: string;
  /** 是否支持 PoE。 */
  poe?: boolean;
  /** 端口分组标识（用于端口行标题与批量选择）。 */
  group_id?: string;
}

/** 指示灯描述。 */
export interface LedSpec {
  /** 指示灯名称（SYS / PWR / LOS / LINK）。 */
  name: string;
  /** 位置。 */
  position: [number, number, number];
  /** 颜色（十六进制）。 */
  color: string;
  /** 半径（米，模板坐标系）。 */
  radius?: number;
}

/** 部件参数：传给部件构建函数的可调参数（工坊里可编辑）。 */
export interface PartParams {
  [key: string]: number | string | boolean | number[] | string[] | undefined;
}

/** 部件描述。 */
export interface PartSpec {
  /** 部件 ID（模板内唯一）。 */
  part_id: string;
  /** 部件类型（对应 parts/ 下的构建器名称）。 */
  kind: string;
  /** 部件类别（工坊分类）。 */
  category: PartCategory;
  /** 中文显示名。 */
  label: string;
  /** 构建参数（可被工坊编辑）。 */
  params: PartParams;
  /** 相对设备的局部变换。 */
  transform?: {
    position?: [number, number, number];
    rotation?: [number, number, number];
    scale?: [number, number, number];
  };
  /** 是否可拆卸（爆炸图与工坊里可单独取出）。 */
  removable?: boolean;
  /** 是否参与爆炸视图。 */
  explode?: boolean;
}

/** 设备模板：一个型号一份，独立文件维护。 */
export interface DeviceTemplate {
  /** 型号 ID（与 assets/catalog 的 model_id 一致；用户自定义模板使用 user- 前缀）。 */
  model_id: string;
  /** 厂商 ID（与 assets/vendor 一致；自定义模板为 custom）。 */
  vendor_id: string;
  /** 显示名。 */
  display_name: string;
  /** 设备类型（switch/router/ap/laptop/phone/olt/onu…，与 Manifest 对齐）。 */
  device_type: string;
  /** 外形尺寸（米：真实世界尺寸，用于场景比例换算）。 */
  dimensions: { width: number; height: number; depth: number; u_height?: number };
  /** 是否机架式（决定场景摆放姿态与安装耳）。 */
  rack_mountable: boolean;
  /** 部件清单（按装配顺序）。 */
  parts: PartSpec[];
  /** 端口槽位（由部件构建器汇总，也可在模板里显式补充）。 */
  ports: PortSlotSpec[];
  /** 指示灯。 */
  leds: LedSpec[];
  /** 模板版本（工坊保存时递增）。 */
  version: number;
  /** 模板来源：内置（assets 派生）或用户组装。 */
  origin: 'builtin' | 'user';
  /** 模板说明（工坊里显示）。 */
  description?: string;
  /** 颜色主题（工坊可改，主场景优先用 Manifest 厂商色）。 */
  theme?: {
    chassis_color?: string;
    accent_color?: string;
    metalness?: number;
    roughness?: number;
  };
}

/** 部件构建上下文。 */
export interface PartBuildContext {
  /** 部件描述。 */
  spec: PartSpec;
  /** 所属模板（取尺寸与主题）。 */
  template: DeviceTemplate;
  /** 纹理命名空间（面板丝印/标签需要）。 */
  namespace: string;
}

/** 部件构建函数：返回一个可加入设备组的 THREE.Group。 */
export type PartBuilder = (context: PartBuildContext) => THREE.Group;

/** 部件注册项：参数默认值 + 构建函数。 */
export interface PartDefinition {
  /** 部件类型名。 */
  kind: string;
  /** 类别。 */
  category: PartCategory;
  /** 中文名。 */
  label: string;
  /** 参数默认值（工坊据此生成表单）。 */
  defaults: PartParams;
  /** 参数中文说明与范围（工坊表单用）。 */
  schema?: Record<
    string,
    { label: string; min?: number; max?: number; step?: number; kind?: string }
  >;
  /** 构建函数。 */
  build: PartBuilder;
}
