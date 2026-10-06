import type { CableRecord } from '../data/types';
import type { DisplayMode, ViewPreset } from './store';
import type { RenderSettings } from './render_settings';

const STORAGE_KEY = 'simlab.saved-experiments.v1';
const MAX_EXPERIMENTS = 50;

/** 保存的端口配置。 */
export interface SavedPortConfiguration {
  short_name: string;
  admin_up: boolean;
  vlan: number;
  speed_mode: string;
  duplex: string;
  poe_enabled: boolean;
  description: string;
}

/** 保存的设备状态。 */
export interface SavedDevice {
  device_id: string;
  model_id: string;
  device_type?: string;
  hostname: string;
  position: { x: number; y: number; z: number };
  power_on: boolean;
  /** Cloud 选中的管理员批准宿主 OVS 桥。 */
  cloud_uplink?: string;
  /** AP 浏览器射频模型参数。 */
  ap_radio?: { ssid: string; channel: number; tx_power_dbm: number };
  ports: SavedPortConfiguration[];
}

/** 保存的实验文档。 */
export interface SavedExperiment {
  schema_version: '1.0';
  experiment_id: string;
  name: string;
  created_at: string;
  updated_at: string;
  devices: SavedDevice[];
  cables: CableRecord[];
  /** 浏览器无线模型的关联配置；不表示客体系统已有真实无线网卡。 */
  wireless_associations?: { sta_device_id: string; ap_device_id: string }[];
  cable_labels: Record<string, { from: string; to: string }>;
  cable_waypoints: Record<string, [number, number, number][]>;
  scene: {
    view: ViewPreset;
    display_mode: DisplayMode;
    flow_enabled: boolean;
    auto_rotate: boolean;
    render: RenderSettings;
  };
}

/** 实验库列表项。 */
export interface SavedExperimentSummary {
  experiment_id: string;
  name: string;
  updated_at: string;
  device_count: number;
  cable_count: number;
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** 带稳定错误码的实验存储异常。 */
export class ExperimentStorageError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ExperimentStorageError';
    this.code = code;
  }
}

function valid_text(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum;
}

function validate_document(value: unknown): SavedExperiment | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const item = value as Partial<SavedExperiment>;
  if (
    item.schema_version !== '1.0' ||
    !valid_text(item.experiment_id, 96) ||
    !valid_text(item.name, 80) ||
    !valid_text(item.created_at, 40) ||
    !valid_text(item.updated_at, 40) ||
    !Array.isArray(item.devices) ||
    !Array.isArray(item.cables) ||
    !item.scene ||
    typeof item.scene !== 'object'
  ) {
    return null;
  }
  if (
    item.devices.length > 500 ||
    item.cables.length > 2000 ||
    (item.wireless_associations !== undefined &&
      (!Array.isArray(item.wireless_associations) ||
       item.wireless_associations.length > 500 ||
       item.wireless_associations.some((link) =>
         !link || !valid_text(link.sta_device_id, 96) ||
         !valid_text(link.ap_device_id, 96)))) ||
    item.devices.some(
      (device) =>
        !device ||
        !valid_text(device.device_id, 96) ||
        !valid_text(device.model_id, 128) ||
        !valid_text(device.hostname, 128) ||
        !device.position ||
        !Number.isFinite(device.position.x) ||
        !Number.isFinite(device.position.y) ||
        !Number.isFinite(device.position.z) ||
        !Array.isArray(device.ports)
        || (device.ap_radio !== undefined && (
          typeof device.ap_radio.ssid !== 'string' ||
          !Number.isInteger(device.ap_radio.channel) ||
          !Number.isInteger(device.ap_radio.tx_power_dbm)
        ))
    )
  ) {
    return null;
  }
  return item as SavedExperiment;
}

function read_all(storage: StorageLike): SavedExperiment[] {
  const raw = storage.getItem(STORAGE_KEY);
  if (!raw) {
    return [];
  }
  try {
    const decoded = JSON.parse(raw) as unknown;
    if (!Array.isArray(decoded)) {
      throw new Error('根节点不是数组');
    }
    return decoded.map(validate_document).filter((item): item is SavedExperiment => Boolean(item));
  } catch (error) {
    throw new ExperimentStorageError(
      'EXP_STORAGE_CORRUPTED',
      '浏览器中的实验库数据已损坏，请清除站点数据后重试。'
    );
  }
}

function write_all(storage: StorageLike, documents: SavedExperiment[]): void {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(documents.slice(0, MAX_EXPERIMENTS)));
  } catch (error) {
    throw new ExperimentStorageError(
      'EXP_STORAGE_QUOTA',
      '浏览器存储空间不足，请删除旧实验后重试。'
    );
  }
}

function browser_storage(): StorageLike {
  if (typeof localStorage === 'undefined') {
    throw new ExperimentStorageError('EXP_STORAGE_UNAVAILABLE', '当前浏览器不支持本地实验保存。');
  }
  return localStorage;
}

/** 生成新的本地实验 ID。 */
export function create_experiment_id(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return 'exp-' + crypto.randomUUID();
  }
  return 'exp-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

/** 列出浏览器中保存的实验。 */
export function list_saved_experiments(storage: StorageLike = browser_storage()): SavedExperimentSummary[] {
  return read_all(storage)
    .sort((left, right) => right.updated_at.localeCompare(left.updated_at))
    .map((document) => ({
      experiment_id: document.experiment_id,
      name: document.name,
      updated_at: document.updated_at,
      device_count: document.devices.length,
      cable_count: document.cables.length
    }));
}

/** 读取一个已保存实验。 */
export function load_saved_experiment(
  experiment_id: string,
  storage: StorageLike = browser_storage()
): SavedExperiment {
  const document = read_all(storage).find((item) => item.experiment_id === experiment_id);
  if (!document) {
    throw new ExperimentStorageError('EXP_NOT_FOUND', '实验不存在或已被删除。');
  }
  return structuredClone(document);
}

/** 新增或覆盖一个实验。 */
export function save_experiment_document(
  document: SavedExperiment,
  storage: StorageLike = browser_storage()
): void {
  if (!validate_document(document)) {
    throw new ExperimentStorageError('EXP_DOCUMENT_INVALID', '实验数据不完整，无法保存。');
  }
  const documents = read_all(storage).filter(
    (item) => item.experiment_id !== document.experiment_id
  );
  documents.unshift(structuredClone(document));
  write_all(storage, documents);
}

/** 删除一个已保存实验。 */
export function delete_saved_experiment(
  experiment_id: string,
  storage: StorageLike = browser_storage()
): void {
  write_all(
    storage,
    read_all(storage).filter((item) => item.experiment_id !== experiment_id)
  );
}
