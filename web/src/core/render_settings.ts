/** 三维渲染画质档位。 */
export type RenderQuality = 'auto' | 'low' | 'medium' | 'high' | 'ultra';

/** 用户可调节的三维画面参数。 */
export interface RenderSettings {
  quality: RenderQuality;
  shadows_enabled: boolean;
  lighting_enabled: boolean;
  lighting_intensity: number;
  exposure: number;
}

/** 渲染器实际采用的性能预算。 */
export interface RenderProfile {
  resolved_quality: Exclude<RenderQuality, 'auto'>;
  pixel_ratio: number;
  target_fps: number;
  vnc_fps: number;
  shadow_map_size: number;
  environment_enabled: boolean;
}

/** 默认设置，自动档会根据浏览器报告的硬件能力选择预算。 */
export const DEFAULT_RENDER_SETTINGS: RenderSettings = {
  quality: 'auto',
  shadows_enabled: true,
  lighting_enabled: true,
  lighting_intensity: 1,
  exposure: 0.96
};

const PROFILES: Record<Exclude<RenderQuality, 'auto'>, Omit<RenderProfile, 'resolved_quality'>> = {
  low: {
    pixel_ratio: 0.75,
    target_fps: 30,
    vnc_fps: 8,
    shadow_map_size: 512,
    environment_enabled: false
  },
  medium: {
    pixel_ratio: 1,
    target_fps: 45,
    vnc_fps: 15,
    shadow_map_size: 1024,
    environment_enabled: true
  },
  high: {
    pixel_ratio: 1.5,
    target_fps: 60,
    vnc_fps: 24,
    shadow_map_size: 2048,
    environment_enabled: true
  },
  ultra: {
    pixel_ratio: 2,
    target_fps: 60,
    vnc_fps: 30,
    shadow_map_size: 4096,
    environment_enabled: true
  }
};

/**
 * 根据 CPU 核数、设备内存与屏幕像素密度估算自动档位。
 * 浏览器不提供设备内存时仅使用 CPU 和像素密度，结果保持保守。
 */
export function detect_render_quality(): Exclude<RenderQuality, 'auto'> {
  if (typeof navigator === 'undefined') {
    return 'medium';
  }
  const threads = Number(navigator.hardwareConcurrency || 4);
  const reported_memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  const memory = reported_memory === undefined ? Number.POSITIVE_INFINITY : Number(reported_memory);
  const ratio = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1;
  if (threads <= 4 || memory <= 4) {
    return 'low';
  }
  if (threads <= 8 || memory <= 8 || ratio >= 2.5) {
    return 'medium';
  }
  return 'high';
}

/** 把用户档位解析为渲染器可直接应用的性能预算。 */
export function resolve_render_profile(quality: RenderQuality): RenderProfile {
  const resolved_quality = quality === 'auto' ? detect_render_quality() : quality;
  return { resolved_quality: resolved_quality, ...PROFILES[resolved_quality] };
}

/** 限制设置范围，避免损坏的保存文件把场景调成全黑或过曝。 */
export function normalize_render_settings(value?: Partial<RenderSettings>): RenderSettings {
  const quality = value?.quality;
  return {
    quality:
      quality === 'auto' ||
      quality === 'low' ||
      quality === 'medium' ||
      quality === 'high' ||
      quality === 'ultra'
        ? quality
        : DEFAULT_RENDER_SETTINGS.quality,
    shadows_enabled:
      typeof value?.shadows_enabled === 'boolean'
        ? value.shadows_enabled
        : DEFAULT_RENDER_SETTINGS.shadows_enabled,
    lighting_enabled:
      typeof value?.lighting_enabled === 'boolean'
        ? value.lighting_enabled
        : DEFAULT_RENDER_SETTINGS.lighting_enabled,
    lighting_intensity: Math.min(1.8, Math.max(0.2, Number(value?.lighting_intensity) || 1)),
    exposure: Math.min(1.5, Math.max(0.45, Number(value?.exposure) || 0.96))
  };
}
