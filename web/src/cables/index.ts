/**
 * @File : web/src/cables/index.ts
 * @Time : 2026-10-04 14:20
 * @Author : Cetrp
 * @Description : 线缆模块出口：线缆目录、参数化连接器、线缆对象与线缆图层的统一引用入口。
 */

export {
  CABLE_CATALOG,
  CABLE_CATEGORY_LABELS,
  cables_by_category,
  cables_for_connector,
  connector_pair_text,
  default_cable_id_for,
  get_cable_kind,
  is_compatible,
  order_kind_for_connector
} from './catalog';
export {
  build_cable_connector,
  connector_exit,
  connector_length,
  has_dust_cap,
  set_dust_cap
} from './connectors';
export { CableObject } from './cable_object';
export { CableLayer, default_kind_for_connector, layer_records_from_cables } from './cable_layer';

export type { CableCategory, CableKind } from './catalog';
export type { ConnectorExit } from './connectors';
export type { CableEndpoint, CableEndpointSide, CableObjectOptions } from './cable_object';
export type { CableLayerRecord, WaypointPick } from './cable_layer';
