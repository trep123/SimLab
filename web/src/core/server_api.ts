/**
 * Django Session API 客户端：账户、服务器实验文档与成员权限。
 */

import type { SavedExperiment, SavedExperimentSummary } from './experiment_storage';

export type ExperimentRole = 'OWNER' | 'EDITOR' | 'VIEWER';

export interface ServerUser {
  id: number;
  username: string;
  is_staff: boolean;
  is_superuser: boolean;
}

export interface ServerExperimentSummary extends SavedExperimentSummary {
  owner: string;
  role: ExperimentRole;
  config_revision: number;
  has_document: boolean;
  created_at: string;
}

export interface ExperimentMemberSummary {
  user_id: number;
  username: string;
  role: ExperimentRole;
}

export class ServerApiError extends Error {
  code: string;
  status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'ServerApiError';
    this.code = code;
    this.status = status;
  }
}

let csrf_token = '';
let csrf_request: Promise<void> | null = null;

export async function server_request_json<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const method = String(options.method || 'GET').toUpperCase();
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...options,
    headers: {
      ...(typeof FormData !== 'undefined' && options.body instanceof FormData
        ? {} : { 'Content-Type': 'application/json' }),
      ...(method !== 'GET' && method !== 'HEAD' && csrf_token
        ? { 'X-CSRFToken': csrf_token }
        : {}),
      ...(options.headers || {})
    }
  });
  if (response.status === 204) {
    return undefined as T;
  }
  const content_type = response.headers.get('content-type') || '';
  if (!content_type.includes('application/json')) {
    throw new ServerApiError(
      'INVALID_API_RESPONSE',
      '服务器没有返回 JSON，请检查 Vite /api 代理与 Django 服务',
      response.status
    );
  }
  const payload = (await response.json()) as {
    error?: { code?: string; message?: unknown; retryable?: boolean };
  };
  if (!response.ok) {
    const detail = payload.error || {};
    throw new ServerApiError(
      detail.code || `HTTP_${response.status}`,
      typeof detail.message === 'string' ? detail.message : '服务器请求失败',
      response.status
    );
  }
  return payload as T;
}

function mutation_options(method: string, body?: object): RequestInit {
  return {
    method: method,
    headers: { 'X-CSRFToken': csrf_token },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  };
}

/** 获取 CSRF cookie 与 masked token。 */
export function bootstrap_csrf(): Promise<void> {
  if (csrf_token) {
    return Promise.resolve();
  }
  if (!csrf_request) {
    csrf_request = server_request_json<{ csrf_token: string }>('/api/v1/auth/csrf/')
      .then((payload) => {
        csrf_token = payload.csrf_token;
      })
      .finally(() => {
        csrf_request = null;
      });
  }
  return csrf_request;
}

/** 查询当前 Session 用户。 */
export function fetch_current_user(): Promise<ServerUser> {
  return server_request_json('/api/v1/auth/me/');
}

/** 使用用户名和密码建立 Django Session。 */
export async function login_user(username: string, password: string): Promise<ServerUser> {
  await bootstrap_csrf();
  const payload = await server_request_json<{ user: ServerUser; csrf_token: string }>(
    '/api/v1/auth/login/',
    mutation_options('POST', { username: username, password: password })
  );
  csrf_token = payload.csrf_token;
  return payload.user;
}

/** 退出当前 Session。 */
export async function logout_user(): Promise<void> {
  await bootstrap_csrf();
  await server_request_json<void>('/api/v1/auth/logout/', mutation_options('POST'));
  csrf_token = '';
}

interface RawExperimentSummary {
  id: string;
  name: string;
  owner: string;
  role: ExperimentRole;
  config_revision: number;
  has_document: boolean;
  device_count: number;
  cable_count: number;
  created_at: string;
  updated_at: string;
}

function normalize_summary(item: RawExperimentSummary): ServerExperimentSummary {
  return {
    experiment_id: item.id,
    name: item.name,
    owner: item.owner,
    role: item.role,
    config_revision: item.config_revision,
    has_document: item.has_document,
    device_count: item.device_count,
    cable_count: item.cable_count,
    created_at: item.created_at,
    updated_at: item.updated_at
  };
}

/** 列出当前账户可访问的服务器实验。 */
export async function list_server_experiments(): Promise<ServerExperimentSummary[]> {
  const items = await server_request_json<RawExperimentSummary[]>('/api/v1/experiments/');
  return items.map(normalize_summary);
}

/** 创建归属于当前账户的空实验。 */
export async function create_server_experiment(name: string): Promise<ServerExperimentSummary> {
  await bootstrap_csrf();
  const item = await server_request_json<RawExperimentSummary>(
    '/api/v1/experiments/',
    mutation_options('POST', { name: name })
  );
  return normalize_summary(item);
}

/** 读取服务器实验文档。 */
export async function load_server_experiment(experiment_id: string): Promise<SavedExperiment> {
  const payload = await server_request_json<{ document: SavedExperiment }>(
    `/api/v1/experiments/${experiment_id}/document/`
  );
  return payload.document;
}

/** 覆盖保存服务器实验文档。 */
export async function save_server_experiment(
  document: SavedExperiment,
  expected_config_revision: number
): Promise<ServerExperimentSummary> {
  await bootstrap_csrf();
  const payload = await server_request_json<{ experiment: RawExperimentSummary }>(
    `/api/v1/experiments/${document.experiment_id}/document/`,
    mutation_options('PUT', {
      document: document,
      expected_config_revision: expected_config_revision
    })
  );
  return normalize_summary(payload.experiment);
}

/** 归档一个服务器实验。 */
export async function delete_server_experiment(experiment_id: string): Promise<void> {
  await bootstrap_csrf();
  await server_request_json<void>(
    `/api/v1/experiments/${experiment_id}/document/`,
    mutation_options('DELETE')
  );
}

/** 读取实验成员权限。 */
export function list_experiment_members(
  experiment_id: string
): Promise<ExperimentMemberSummary[]> {
  return server_request_json(`/api/v1/experiments/${experiment_id}/members/`);
}

/** 添加成员或更新其 EDITOR/VIEWER 权限。 */
export async function set_experiment_member(
  experiment_id: string,
  username: string,
  role: Exclude<ExperimentRole, 'OWNER'>
): Promise<ServerExperimentSummary> {
  await bootstrap_csrf();
  const payload = await server_request_json<{ experiment: RawExperimentSummary }>(
    `/api/v1/experiments/${experiment_id}/members/`,
    mutation_options('POST', { username: username, role: role })
  );
  return normalize_summary(payload.experiment);
}

/** 移除实验成员。 */
export async function remove_experiment_member(
  experiment_id: string,
  user_id: number
): Promise<void> {
  await bootstrap_csrf();
  await server_request_json<void>(
    `/api/v1/experiments/${experiment_id}/members/${user_id}/`,
    mutation_options('DELETE')
  );
}
