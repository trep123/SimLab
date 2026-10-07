/**
 * @File : web/src/devices/parts/port_module.ts
 * @Time : 2026-10-06 10:20
 * @Author : Cetrp
 * @Description : 参数化端口模块：按连接器类型与行列数生成端口开口、丝印与"线缆锚点"，
 *               锚点供线缆对象从真实接口长出（真高仿连线的几何基础）。
 */

import * as THREE from 'three';

import {
  COLOR,
  chassis_material,
  dc_barrel_jack,
  emissive_material,
  iec_c14_jack,
  label_texture,
  plastic_material,
  rj45_jack,
  rounded_box,
  sc_adapter,
  sfp_cage,
  trs
} from '../part_kit';
import type { ConnectorType, PartDefinition, PortSlotSpec } from '../template_types';

/** 各连接器的默认外观尺寸（米）与可插线缆类型。 */
export const CONNECTOR_GEOMETRY: Record<
  ConnectorType,
  { width: number; height: number; depth: number; label: string; cable: string }
> = {
  rj45: { width: 0.0142, height: 0.0122, depth: 0.014, label: 'RJ45 网口', cable: 'cat6' },
  sfp: { width: 0.0145, height: 0.0098, depth: 0.05, label: 'SFP 光口', cable: 'fiber_lc' },
  sfp_plus: { width: 0.0155, height: 0.0104, depth: 0.055, label: 'SFP+ 光口', cable: 'fiber_lc' },
  gpon: {
    width: 0.0125,
    height: 0.009,
    depth: 0.03,
    label: 'GPON 光口（SC/APC）',
    cable: 'fiber_sc'
  },
  console_rj45: {
    width: 0.0125,
    height: 0.011,
    depth: 0.012,
    label: 'Console 口',
    cable: 'console'
  },
  usb: { width: 0.0135, height: 0.0065, depth: 0.008, label: 'USB 口', cable: 'usb' },
  power_iec_c14: {
    width: 0.032,
    height: 0.026,
    depth: 0.01,
    label: 'IEC C14 电源口',
    cable: 'power_iec'
  },
  power_dc_barrel: {
    width: 0.009,
    height: 0.009,
    depth: 0.008,
    label: 'DC 电源口',
    cable: 'power_dc'
  },
  power_dc_terminal: {
    width: 0.02,
    height: 0.012,
    depth: 0.01,
    label: '直流端子',
    cable: 'power_dc'
  },
  antenna_sma: { width: 0.008, height: 0.008, depth: 0.01, label: 'SMA 天线座', cable: '' }
};

/**
 * 构造指定连接器的插座几何。
 *
 * @param {ConnectorType} connector 连接器类型。
 * @returns {THREE.Group} 插座组（开口朝 +Z）。
 */
export function build_jack(connector: ConnectorType): THREE.Group {
  const geometry = CONNECTOR_GEOMETRY[connector];
  switch (connector) {
    case 'rj45':
    case 'console_rj45':
      return rj45_jack(geometry.width, geometry.height, geometry.depth);
    case 'sfp':
    case 'sfp_plus':
      return sfp_cage(geometry.width, geometry.height, geometry.depth);
    case 'gpon':
      return sc_adapter(geometry.width);
    case 'usb':
      return new THREE.Group().add(
        new THREE.Mesh(
          new THREE.BoxGeometry(geometry.width * 0.8, geometry.height, geometry.depth),
          chassis_material(COLOR.silver)
        )
      );
    case 'power_iec_c14':
      return iec_c14_jack();
    case 'power_dc_barrel':
      return dc_barrel_jack(geometry.width / 2);
    case 'power_dc_terminal':
      return new THREE.Group().add(
        new THREE.Mesh(
          new THREE.BoxGeometry(geometry.width, geometry.height, geometry.depth),
          plastic_material('#8a2b2b', 0.6)
        )
      );
    case 'antenna_sma':
      return new THREE.Group().add(
        new THREE.Mesh(
          new THREE.CylinderGeometry(geometry.width / 2, geometry.width / 2, geometry.depth, 14),
          chassis_material(COLOR.gold)
        ).rotateX(Math.PI / 2)
      );
    default:
      return new THREE.Group();
  }
}

/** 给每个 RJ45 端口添加交换机风格的双 LED 灯窗与端口丝印。 */
function add_rj45_port_face(
  group: THREE.Group,
  options: {
    x: number;
    y: number;
    pitch_x: number;
    pitch_y: number;
    short_name: string;
    row: number;
    index: number;
    show_leds: boolean;
    show_label: boolean;
  }
): void {
  const { x, y, pitch_x, pitch_y, short_name, row, index, show_leds, show_label } = options;
  if (show_leds) {
    for (const side of [-1, 1]) {
      const led = new THREE.Mesh(
        rounded_box(pitch_x * 0.1, pitch_y * 0.09, 0.0015, pitch_y * 0.015),
        emissive_material(side < 0 ? '#15352c' : '#332b18', 0.12)
      );
      const led_y = y + (row === 0 ? -1 : 1) * pitch_y * 0.31;
      led.position.set(x + side * pitch_x * 0.27, led_y, 0.0012);
      led.name = 'port_led_window_' + index + '_' + side;
      group.add(led);
    }
  }
  if (show_label) {
    const tail = short_name.split('/').filter((part) => part.length > 0).pop() || short_name;
    const text = tail.length > 6 ? tail.slice(-6) : tail;
    const label = new THREE.Mesh(
      new THREE.PlaneGeometry(pitch_x * 0.68, pitch_y * 0.18),
      new THREE.MeshBasicMaterial({
        map: label_texture(text, '#d7e0e8', 48),
        transparent: true,
        depthWrite: false,
        opacity: 0.78
      })
    );
    const label_y = y + (row === 0 ? 1 : -1) * pitch_y * 0.39;
    label.position.set(x, label_y, 0.0015);
    label.name = 'port_label_' + short_name;
    group.add(label);
  }
}

/** 读取数值参数。 */
function number_param(params: Record<string, unknown>, key: string, fallback: number): number {
  const value = params[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** 读取字符串参数。 */
function text_param(params: Record<string, unknown>, key: string, fallback: string): string {
  const value = params[key];
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

/** 读取布尔参数。 */
function boolean_param(params: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = params[key];
  return typeof value === 'boolean' ? value : fallback;
}

/** 读取字符串数组参数。 */
function list_param(params: Record<string, unknown>, key: string): string[] {
  const value = params[key];
  if (Array.isArray(value)) {
    return value.map((item) => String(item));
  }
  return [];
}

/**
 * 端口行：把同一组端口按行列排布，返回插座组 + 端口槽位锚点。
 *
 * 参数：
 * - `connector`：连接器类型（决定插座外观）；
 * - `rows` / `columns`：行列数；
 * - `pitch_x` / `pitch_y`：行列间距（米）；
 * - `origin`：该行首端口中心（模板局部坐标 [x, y, z]）；
 * - `names`：端口短名列表（缺省按 `name_prefix + 序号` 生成）；
 * - `numbering`：`row-major`（默认）或 `column-major`（双排交换机按列成对编号）；
 * - `name_prefix`：短名前缀；
 * - `group_id`：端口分组标识。
 *
 * @param {object} context 构建上下文。
 * @returns {THREE.Group} 端口行组（`userData.port_slots` 含锚点）。
 */
function build_port_row(context: { spec: { params: Record<string, unknown> } }): THREE.Group {
  const { spec } = context;
  const connector = text_param(spec.params, 'connector', 'rj45') as ConnectorType;
  const rows = Math.max(1, Math.round(number_param(spec.params, 'rows', 1)));
  const columns = Math.max(1, Math.round(number_param(spec.params, 'columns', 24)));
  const pitch_x = number_param(spec.params, 'pitch_x', 0.0165);
  const pitch_y = number_param(spec.params, 'pitch_y', 0.0155);
  const origin = (spec.params.origin as number[]) || [0, 0, 0];
  const name_prefix = text_param(spec.params, 'name_prefix', 'GE0/0/');
  const group_id = text_param(spec.params, 'group_id', 'ports');
  const names = list_param(spec.params, 'names');
  const column_major = spec.params.numbering === 'column-major';
  const speed_bps = number_param(spec.params, 'speed_bps', 1000000000);
  const poe = spec.params.poe === true;
  /* 面板细节开关：每口 LED 与丝印（默认开启，端口数过多时自动关闭丝印以省资源）。 */
  const per_port_led = spec.params.per_port_led !== false;
  const per_port_label =
    spec.params.per_port_label !== false && rows * columns <= 28;

  const group = new THREE.Group();
  group.position.set(Number(origin[0]) || 0, Number(origin[1]) || 0, Number(origin[2]) || 0);
  const slots: PortSlotSpec[] = [];
  const half_columns = (columns - 1) / 2;
  const half_rows = (rows - 1) / 2;
  let index = 0;
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      index += 1;
      const x = (column - half_columns) * pitch_x;
      const y = (half_rows - row) * pitch_y;
      const jack = build_jack(connector);
      /* 插座内嵌：让开口平齐面板平面（插座本体缩进机箱内），避免凸出机箱。 */
      const jack_depth = CONNECTOR_GEOMETRY[connector].depth;
      /* 笼体缩进机箱、金属包边略高于面板，形成真实的嵌入式接口层次。 */
      jack.position.set(x, y, -jack_depth / 2 + 0.0022);
      group.add(jack);
      /* 端口下方丝印：用细长白条模拟标签（近看可读，远看是丝印）。 */
      const name_index = column_major ? column * rows + row : index - 1;
      const short_name = names[name_index] || name_prefix + (name_index + 1);
      /* 交换机与独立网口复用完全相同的每口状态灯和端口丝印。 */
      add_rj45_port_face(group, {
        x: x,
        y: y,
        pitch_x: pitch_x,
        pitch_y: pitch_y,
        short_name: short_name,
        row: row,
        index: index,
        show_leds: per_port_led && connector === 'rj45',
        show_label: per_port_label && connector === 'rj45'
      });
      slots.push({
        short_name: short_name,
        name: short_name,
        connector: connector,
        speed_bps: speed_bps,
        /* 与插座开口平面一致：jack 的前沿固定在部件局部 z=0.0022。 */
        position: [x, y, 0.0022],
        direction: [0, 0, 1],
        label: short_name,
        poe: poe,
        group_id: group_id
      });
    }
  }
  /* 端口组丝印边框：用于区分业务口与上联口，也让整排接口嵌在真实面板模块中。 */
  const frame_width = Math.max(pitch_x, columns * pitch_x);
  const frame_height = Math.max(pitch_y, rows * pitch_y);
  const frame_line = Math.max(0.00022, Math.min(pitch_x, pitch_y) * 0.025);
  const frame_material = plastic_material('#c6d0da', 0.7);
  for (const y of [-frame_height / 2, frame_height / 2]) {
    const edge = new THREE.Mesh(
      new THREE.BoxGeometry(frame_width, frame_line, 0.0008),
      frame_material
    );
    edge.position.set(0, y, 0.0005);
    group.add(edge);
  }
  for (const x of [-frame_width / 2, frame_width / 2]) {
    const edge = new THREE.Mesh(
      new THREE.BoxGeometry(frame_line, frame_height, 0.0008),
      frame_material
    );
    edge.position.set(x, 0, 0.0005);
    group.add(edge);
  }
  group.userData.port_slots = slots;

  return group;
}

/**
 * 单端口部件（电源口 / Console / 天线座等不成排的接口）。
 *
 * 参数：`connector`、`position`（[x, y, z]）、`short_name`、`direction`（缺省 +Z）。
 *
 * @param {object} context 构建上下文。
 * @returns {THREE.Group} 端口组（`userData.port_slots` 含单个锚点）。
 */
function build_single_port(context: { spec: { params: Record<string, unknown> } }): THREE.Group {
  const { spec } = context;
  const connector = text_param(spec.params, 'connector', 'power_iec_c14') as ConnectorType;
  const position = (spec.params.position as number[]) || [0, 0, 0];
  const short_name = text_param(spec.params, 'short_name', connector.toUpperCase());
  const direction = (spec.params.direction as number[]) || [0, 0, 1];
  const speed_bps = number_param(spec.params, 'speed_bps', 0);
  const group_id = text_param(spec.params, 'group_id', 'misc');
  const poe = boolean_param(spec.params, 'poe', false);
  const group = new THREE.Group();
  group.position.set(Number(position[0]) || 0, Number(position[1]) || 0, Number(position[2]) || 0);
  const jack = build_jack(connector);
  jack.position.z = -CONNECTOR_GEOMETRY[connector].depth / 2 + 0.0022;
  group.add(jack);
  if (connector === 'rj45') {
    /* 单口网卡沿用交换机每口的 2 灯窗 + 丝印间距与材质。 */
    add_rj45_port_face(group, {
      x: 0,
      y: 0,
      pitch_x: 0.0165,
      pitch_y: 0.0155,
      short_name: short_name,
      row: 0,
      index: 1,
      show_leds: spec.params.show_status !== false,
      show_label: spec.params.show_label !== false
    });
  }
  if (connector !== 'rj45') {
    const label = new THREE.Mesh(
      new THREE.PlaneGeometry(0.012, 0.0028),
      new THREE.MeshBasicMaterial({
        map: label_texture(short_name, '#d7e0e8', 64),
        transparent: true,
        depthWrite: false,
        opacity: 0.82
      })
    );
    label.position.set(0, 0.009, 0.0015);
    group.add(label);
  }
  group.userData.port_slots = [
    {
      short_name: short_name,
      name: short_name,
      connector: connector,
      speed_bps: speed_bps,
      poe: poe,
      /* 与插座开口平面一致：jack 的前沿固定在部件局部 z=0.0022。 */
      position: [0, 0, 0.0022],
      direction: [Number(direction[0]) || 0, Number(direction[1]) || 0, Number(direction[2]) || 1],
      label: short_name,
      group_id: group_id
    }
  ];

  return group;
}

/**
 * 端口模块（可插拔子卡 / 扩展模块）：外壳 + 内部端口行。
 *
 * 参数：`width`、`height`、`depth`、`color`、`connector`、`columns`、`rows`。
 *
 * @param {object} context 构建上下文。
 * @returns {THREE.Group} 模块组。
 */
function build_port_module_ext(context: {
  spec: { params: Record<string, unknown> };
}): THREE.Group {
  const { spec } = context;
  const width = number_param(spec.params, 'width', 0.11);
  const height = number_param(spec.params, 'height', 0.04);
  const depth = number_param(spec.params, 'depth', 0.12);
  const color = text_param(spec.params, 'color', COLOR.chassis_mid);
  const group = new THREE.Group();
  const shell = new THREE.Mesh(
    new THREE.BoxGeometry(width, height, depth),
    chassis_material(color, { metalness: 0.6, roughness: 0.42 })
  );
  group.add(shell);
  const inner = build_port_row({
    spec: {
      ...spec,
      params: {
        ...spec.params,
        rows: number_param(spec.params, 'rows', 1),
        columns: number_param(spec.params, 'columns', 8),
        pitch_x: number_param(spec.params, 'pitch_x', 0.0132),
        origin: [0, 0, depth / 2]
      }
    }
  });
  group.add(inner);
  group.userData.port_slots = inner.userData.port_slots;

  return group;
}

/** 端口相关部件注册表。 */
export const PORT_PARTS: PartDefinition[] = [
  {
    kind: 'network_port',
    category: 'port_module',
    label: '独立网络接口（RJ45 / SFP）',
    defaults: {
      connector: 'rj45',
      position: [0, 0, 0.005],
      short_name: 'eth0',
      direction: [0, 0, 1],
      speed_bps: 1000000000,
      group_id: 'eth',
      poe: false
    },
    schema: {
      connector: { label: '连接器', kind: 'connector' },
      short_name: { label: '接口名称', kind: 'text' },
      speed_bps: { label: '速率（bps）', min: 10000000, max: 100000000000, step: 10000000 },
      group_id: { label: '接口分组', kind: 'text' },
      poe: { label: '支持 PoE', kind: 'boolean' }
    },
    build: build_single_port
  },
  {
    kind: 'port_row',
    category: 'port_module',
    label: '端口行',
    defaults: {
      connector: 'rj45',
      rows: 1,
      columns: 24,
      pitch_x: 0.0165,
      pitch_y: 0.0155,
      origin: [0, 0, 0.006],
      name_prefix: 'GE0/0/',
      speed_bps: 1000000000,
      group_id: 'ports',
      poe: false
    },
    schema: {
      connector: { label: '连接器', kind: 'connector' },
      rows: { label: '行数', min: 1, max: 4, step: 1 },
      columns: { label: '每行端口数', min: 1, max: 48, step: 1 },
      pitch_x: { label: '列间距（米）', min: 0.008, max: 0.04, step: 0.0005 },
      pitch_y: { label: '行间距（米）', min: 0.008, max: 0.04, step: 0.0005 },
      name_prefix: { label: '端口名前缀', kind: 'text' },
      numbering: { label: '编号顺序（row-major / column-major）', kind: 'text' },
      group_id: { label: '分组标识', kind: 'text' },
      poe: { label: '支持 PoE', kind: 'boolean' }
    },
    build: build_port_row
  },
  {
    kind: 'single_port',
    category: 'port_module',
    label: '单端口（电源/Console/天线座）',
    defaults: {
      connector: 'power_iec_c14',
      position: [0, 0, 0.005],
      short_name: 'POWER',
      direction: [0, 0, 1]
    },
    schema: {
      connector: { label: '连接器', kind: 'connector' },
      short_name: { label: '端口名', kind: 'text' }
    },
    build: build_single_port
  },
  {
    kind: 'port_module',
    category: 'port_module',
    label: '扩展端口模块',
    defaults: {
      width: 0.11,
      height: 0.04,
      depth: 0.12,
      color: COLOR.chassis_mid,
      connector: 'sfp_plus',
      rows: 1,
      columns: 4,
      pitch_x: 0.0132,
      name_prefix: 'XGE0/0/'
    },
    schema: {
      connector: { label: '连接器', kind: 'connector' },
      rows: { label: '行数', min: 1, max: 2, step: 1 },
      columns: { label: '每行端口数', min: 1, max: 24, step: 1 },
      name_prefix: { label: '端口名前缀', kind: 'text' }
    },
    build: build_port_module_ext
  }
];
