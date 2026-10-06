/**
 * @File : web/src/devices/part_kit.ts
 * @Time : 2026-10-06 09:10
 * @Author : Cetrp
 * @Description : 部件制造工具箱：几何原语、材质、丝印贴图与常见接口小件（RJ45/SFP/指示灯/螺丝…），
 *               供 devices/parts 下的参数化部件复用，保证"同一种东西只有一份实现"。
 */

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

/** 默认金属粗糙度与金属度。 */
export const METAL_ROUGHNESS = 0.52;
export const METAL_METALNESS = 0.38;

/** 面板常用色。 */
export const COLOR = {
  chassis_light: '#aab2bc',
  chassis_dark: '#3c434c',
  chassis_mid: '#8f9aa6',
  plastic_dark: '#191d24',
  plastic_gray: '#2b3038',
  gold: '#d7b26a',
  silver: '#c8ced6',
  label_white: '#e8edf3',
  light_blue: '#7fb2ff'
} as const;

/**
 * 组合位移与旋转。
 *
 * @param {number} x X 坐标。
 * @param {number} y Y 坐标。
 * @param {number} z Z 坐标。
 * @param {number} rx X 轴旋转。
 * @param {number} ry Y 轴旋转。
 * @param {number} rz Z 轴旋转。
 * @returns {THREE.Matrix4} 变换矩阵。
 */
export function trs(x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)),
    new THREE.Vector3(1, 1, 1)
  );
}

/**
 * 合并一组几何体（带各自变换）。
 *
 * @param {{geometry: THREE.BufferGeometry; matrix: THREE.Matrix4}[]} items 待合并项。
 * @returns {THREE.BufferGeometry} 合并后的几何体。
 */
export function merge_geometries(
  items: { geometry: THREE.BufferGeometry; matrix: THREE.Matrix4 }[]
): THREE.BufferGeometry {
  const merged = new THREE.BufferGeometry();
  if (items.length === 0) {
    return merged;
  }
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  for (const item of items) {
    /* 合并后的几何不再携带各自的索引，因此先展开索引，避免圆角件出现缺面或错误三角形。 */
    const geometry = (
      item.geometry.index ? item.geometry.toNonIndexed() : item.geometry.clone()
    ).applyMatrix4(item.matrix);
    const position = geometry.getAttribute('position');
    const normal = geometry.getAttribute('normal');
    const uv = geometry.getAttribute('uv');
    for (let index = 0; index < position.count; index += 1) {
      positions.push(position.getX(index), position.getY(index), position.getZ(index));
      if (normal) {
        normals.push(normal.getX(index), normal.getY(index), normal.getZ(index));
      }
      if (uv) {
        uvs.push(uv.getX(index), uv.getY(index));
      }
    }
    geometry.dispose();
  }
  merged.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  if (normals.length === positions.length) {
    merged.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  }
  if (uvs.length > 0) {
    merged.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  }
  merged.computeVertexNormals();

  return merged;
}

/**
 * 圆角盒体（机箱/模块通用）。
 *
 * @param {number} width 宽。
 * @param {number} height 高。
 * @param {number} depth 深。
 * @param {number} radius 圆角半径。
 * @returns {THREE.BufferGeometry} 几何体。
 */
export function rounded_box(
  width: number,
  height: number,
  depth: number,
  radius = 0.006
): THREE.BufferGeometry {
  const safe_width = Math.max(0.001, width);
  const safe_height = Math.max(0.001, height);
  const safe_depth = Math.max(0.001, depth);
  const safe_radius = Math.max(
    0.00005,
    Math.min(radius, safe_width / 2.05, safe_height / 2.05, safe_depth / 2.05)
  );

  /* RoundedBoxGeometry 会生成真实圆角面与连续法线；旧实现只移动立方体顶点，近景仍是折角。 */
  return new RoundedBoxGeometry(safe_width, safe_height, safe_depth, 4, safe_radius);
}

/**
 * 构造机箱材质。
 *
 * @param {string} color 颜色。
 * @param {object} [options] 选项。
 * @returns {THREE.MeshStandardMaterial} 材质。
 */
export function chassis_material(
  color: string,
  options: { metalness?: number; roughness?: number } = {}
): THREE.MeshStandardMaterial {
  return new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(color),
    metalness: options.metalness === undefined ? METAL_METALNESS : options.metalness,
    roughness: options.roughness === undefined ? METAL_ROUGHNESS : options.roughness,
    clearcoat: 0.05,
    clearcoatRoughness: 0.7,
    envMapIntensity: 0.82
  });
}

/** 拉丝金属贴图缓存（颜色 → 贴图）。 */
const BRUSHED_TEXTURE_CACHE = new Map<string, THREE.Texture>();

/** 拉丝金属粗糙度贴图缓存。 */
const BRUSHED_ROUGHNESS_CACHE = new Map<string, THREE.Texture>();

/**
 * 生成稳定伪随机数，保证同一型号每次渲染的金属纹理一致。
 *
 * @param {number} seed 初始种子。
 * @returns {() => number} 0~1 随机数生成器。
 */
function seeded_random(seed: number): () => number {
  let state = seed >>> 0;

  return (): number => {
    state = (state * 1664525 + 1013904223) >>> 0;

    return state / 4294967296;
  };
}

/**
 * 从颜色文本生成纹理种子。
 *
 * @param {string} color 颜色文本。
 * @returns {number} 无符号种子。
 */
function texture_seed(color: string): number {
  let seed = 2166136261;
  for (const character of color) {
    seed ^= character.charCodeAt(0);
    seed = Math.imul(seed, 16777619);
  }

  return seed >>> 0;
}

/**
 * 程序化拉丝金属贴图：细密横向纹理 + 轻微色差，用于机箱外壳。
 *
 * @param {string} color 基色。
 * @param {number} [size] 贴图边长（像素）。
 * @returns {THREE.Texture | null} 可平铺贴图（无 DOM 环境返回 null）。
 */
export function brushed_metal_texture(color: string, size = 256): THREE.Texture | null {
  const cached = BRUSHED_TEXTURE_CACHE.get(color);
  if (cached) {
    return cached;
  }
  const base = new THREE.Color(color);
  const random = seeded_random(texture_seed(color));
  /* 无 DOM 环境（单元测试/服务端）跳过贴图，保持几何与材质可用。 */
  if (typeof document === 'undefined') {
    return null;
  }
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  if (context) {
    const red = Math.round(base.r * 255);
    const green = Math.round(base.g * 255);
    const blue = Math.round(base.b * 255);
    context.fillStyle = 'rgb(' + red + ',' + green + ',' + blue + ')';
    context.fillRect(0, 0, size, size);
    /* 横向拉丝保持低对比度，近看可见、远看不会变成粗条纹。 */
    for (let index = 0; index < size * 1.7; index += 1) {
      const y = random() * size;
      const alpha = 0.01 + random() * 0.035;
      const lighter = random() > 0.5;
      context.strokeStyle = lighter
        ? 'rgba(255,255,255,' + alpha.toFixed(3) + ')'
        : 'rgba(0,0,0,' + alpha.toFixed(3) + ')';
      context.lineWidth = random() > 0.9 ? 1.1 : 0.55;
      context.beginPath();
      context.moveTo(0, y);
      context.lineTo(size, y + (random() - 0.5) * 0.8);
      context.stroke();
    }
    /* 少量长划痕模拟喷涂钢板的制造差异。 */
    for (let index = 0; index < 10; index += 1) {
      const x = random() * size;
      context.strokeStyle = 'rgba(0,0,0,' + (0.006 + random() * 0.012).toFixed(3) + ')';
      context.lineWidth = 0.5 + random();
      context.beginPath();
      context.moveTo(x, 0);
      context.lineTo(x + (random() - 0.5) * 2, size);
      context.stroke();
    }
  }
  texture.anisotropy = 8;
  BRUSHED_TEXTURE_CACHE.set(color, texture);

  return texture;
}

/**
 * 程序化拉丝粗糙度贴图，为金属高光增加细密方向性变化。
 *
 * @param {string} color 缓存键使用的机箱颜色。
 * @param {number} [size] 贴图边长。
 * @returns {THREE.Texture | null} 粗糙度贴图；无 DOM 环境时为空。
 */
function brushed_roughness_texture(color: string, size = 256): THREE.Texture | null {
  const cached = BRUSHED_ROUGHNESS_CACHE.get(color);
  if (cached) {
    return cached;
  }
  if (typeof document === 'undefined') {
    return null;
  }
  const random = seeded_random(texture_seed(color) ^ 0x9e3779b9);
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.NoColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 8;
  if (context) {
    context.fillStyle = '#9c9c9c';
    context.fillRect(0, 0, size, size);
    for (let index = 0; index < size * 2; index += 1) {
      const value = Math.round(118 + random() * 82);
      context.strokeStyle = 'rgba(' + value + ',' + value + ',' + value + ',0.38)';
      context.lineWidth = 0.5 + random() * 0.9;
      const y = random() * size;
      context.beginPath();
      context.moveTo(0, y);
      context.lineTo(size, y + (random() - 0.5) * 0.5);
      context.stroke();
    }
  }
  BRUSHED_ROUGHNESS_CACHE.set(color, texture);

  return texture;
}

/**
 * 构造机箱外壳材质（可选拉丝纹理，真机金属质感）。
 *
 * @param {string} color 基色。
 * @param {object} [options] 选项。
 * @param {boolean} [options.brushed] 是否叠加拉丝纹理。
 * @param {number} [options.metalness] 金属度。
 * @param {number} [options.roughness] 粗糙度。
 * @returns {THREE.MeshStandardMaterial} 材质。
 */
export function shell_material(
  color: string,
  options: { brushed?: boolean; metalness?: number; roughness?: number } = {}
): THREE.MeshStandardMaterial {
  const material = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(color),
    metalness: options.metalness === undefined ? 0.68 : options.metalness,
    roughness: options.roughness === undefined ? 0.38 : options.roughness,
    clearcoat: 0.08,
    clearcoatRoughness: 0.62,
    envMapIntensity: 0.9,
    anisotropy: 0.3
  });
  if (options.brushed !== false) {
    const texture = brushed_metal_texture(color);
    const roughness_texture = brushed_roughness_texture(color);
    /* 无 DOM 环境下拿不到贴图，保持纯色材质即可。 */
    if (texture) {
      texture.repeat.set(4, 4);
      material.map = texture;
      /* 颜色已经烘焙在贴图中，材质改为白色可避免同一基色被重复相乘。 */
      material.color.set('#ffffff');
    }
    if (roughness_texture) {
      roughness_texture.repeat.set(4, 4);
      material.roughnessMap = roughness_texture;
      material.bumpMap = roughness_texture;
      material.bumpScale = 0.008;
    }
  }

  return material;
}

/**
 * 构造塑料/橡胶材质。
 *
 * @param {string} color 颜色。
 * @param {number} [roughness] 粗糙度。
 * @returns {THREE.MeshStandardMaterial} 材质。
 */
export function plastic_material(color: string, roughness = 0.72): THREE.MeshStandardMaterial {
  return new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(color),
    metalness: 0.05,
    roughness: roughness,
    clearcoat: roughness < 0.55 ? 0.16 : 0.035,
    clearcoatRoughness: Math.min(0.9, roughness + 0.08),
    envMapIntensity: 0.72
  });
}

/**
 * 构造发光材质（指示灯）。
 *
 * @param {string} color 颜色。
 * @param {number} [intensity] 发光强度。
 * @returns {THREE.MeshStandardMaterial} 材质。
 */
export function emissive_material(color: string, intensity = 1.4): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: new THREE.Color(color),
    emissive: new THREE.Color(color),
    emissiveIntensity: intensity,
    metalness: 0.1,
    roughness: 0.35
  });
}

/**
 * 面板丝印贴图：底色 + 品牌线 + 型号 + 端口标签行。
 *
 * @param {object} options 选项。
 * @param {number} options.width 面板宽（米，仅用于比例）。
 * @param {number} options.height 面板高（米）。
 * @param {string} options.background 底色。
 * @param {string} [options.brand_line] 品牌线文本。
 * @param {string} [options.sub_line] 副标题文本。
 * @param {{text: string; x: number}[]} [options.labels] 端口标签（x 为面板归一化 0~1）。
 * @param {number} [options.pixels_per_meter] 贴图分辨率。
 * @returns {THREE.CanvasTexture} 贴图。
 */
export function panel_texture(options: {
  width: number;
  height: number;
  background: string;
  brand_line?: string;
  sub_line?: string;
  labels?: { text: string; x: number }[];
  pixels_per_meter?: number;
  /** 品牌线字高（米，缺省 3.2 mm）。 */
  brand_text_m?: number;
  /** 副标题字高（米，缺省 2 mm）。 */
  sub_text_m?: number;
}): THREE.Texture {
  /* 无 DOM 环境（单元测试 / SSR）下返回空贴图，几何与装配逻辑仍可验证。 */
  if (typeof document === 'undefined') {
    return new THREE.Texture();
  }
  /* 分辨率按物理尺寸给：小面板也要有足够像素画 2~3 mm 的字。 */
  const density = options.pixels_per_meter || 1600;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(96, Math.round(options.width * density));
  canvas.height = Math.max(64, Math.round(options.height * density));
  const context = canvas.getContext('2d');
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  if (!context) {
    return texture;
  }
  context.fillStyle = options.background;
  context.fillRect(0, 0, canvas.width, canvas.height);

  /* 顶部高光与底部阴影，模拟拉丝金属。 */
  const gradient = context.createLinearGradient(0, 0, 0, canvas.height);
  gradient.addColorStop(0, 'rgba(255,255,255,0.10)');
  gradient.addColorStop(0.45, 'rgba(255,255,255,0.02)');
  gradient.addColorStop(1, 'rgba(0,0,0,0.22)');
  context.fillStyle = gradient;
  context.fillRect(0, 0, canvas.width, canvas.height);

  /* 喷涂面板的细颗粒与水平拉丝，比纯色平面更接近真实钣金。 */
  const random = seeded_random(texture_seed(options.background) ^ 0x7f4a7c15);
  for (let index = 0; index < canvas.height * 2; index += 1) {
    const y = random() * canvas.height;
    const alpha = 0.008 + random() * 0.018;
    context.strokeStyle =
      random() > 0.5
        ? 'rgba(255,255,255,' + alpha.toFixed(3) + ')'
        : 'rgba(0,0,0,' + alpha.toFixed(3) + ')';
    context.lineWidth = 0.5;
    context.beginPath();
    context.moveTo(0, y);
    context.lineTo(canvas.width, y);
    context.stroke();
  }

  /* 丝印按物理尺寸：品牌线 3.2 mm，副标题 2 mm（真机面板就是这个量级）。 */
  const brand_px = Math.max(7, (options.brand_text_m || 0.0032) * density);
  const sub_px = Math.max(6, (options.sub_text_m || 0.002) * density);
  context.textBaseline = 'middle';
  const rack_panel = options.width / Math.max(options.height, 0.001) >= 4;
  const fit_font = (text: string, preferred: number, max_width: number): number => {
    let font_size = preferred;
    while (font_size > 6) {
      context.font = '600 ' + Math.round(font_size) + 'px system-ui, sans-serif';
      if (context.measureText(text).width <= max_width) {
        break;
      }
      font_size -= 0.5;
    }

    return font_size;
  };
  if (rack_panel) {
    /* 机架设备把品牌信息限制在左侧控制区，避免丝印铺到 24/48 口矩阵下面。 */
    const safe_width = canvas.width * 0.21;
    const words = (options.brand_line || '').trim().split(/\s+/).filter(Boolean);
    const logo = words.shift() || '';
    const model = words.join(' ');
    context.save();
    context.beginPath();
    context.rect(canvas.width * 0.018, 0, safe_width, canvas.height);
    context.clip();
    if (logo) {
      context.fillStyle = 'rgba(248,251,254,0.98)';
      const logo_size = fit_font(logo, brand_px * 1.15, safe_width * 0.94);
      context.font = '800 ' + Math.round(logo_size) + 'px system-ui, sans-serif';
      context.fillText(logo, canvas.width * 0.025, canvas.height * 0.26);
    }
    if (model) {
      context.fillStyle = 'rgba(226,235,244,0.92)';
      const model_size = fit_font(model, sub_px * 0.96, safe_width * 0.94);
      context.font = '600 ' + Math.round(model_size) + 'px system-ui, sans-serif';
      context.fillText(model, canvas.width * 0.025, canvas.height * 0.5);
    }
    if (options.sub_line) {
      context.fillStyle = 'rgba(184,201,217,0.78)';
      const detail_size = fit_font(options.sub_line, sub_px * 0.78, safe_width * 0.94);
      context.font = Math.round(detail_size) + 'px system-ui, sans-serif';
      context.fillText(options.sub_line, canvas.width * 0.025, canvas.height * 0.72);
    }
    context.restore();
    context.strokeStyle = 'rgba(225,235,245,0.18)';
    context.lineWidth = Math.max(1, canvas.height * 0.012);
    context.beginPath();
    context.moveTo(canvas.width * 0.235, canvas.height * 0.16);
    context.lineTo(canvas.width * 0.235, canvas.height * 0.84);
    context.stroke();
  } else {
    /* AP、ONU 等桌面设备在顶面居中显示品牌与型号。 */
    context.textAlign = 'center';
    if (options.brand_line) {
      context.fillStyle = 'rgba(242,247,252,0.96)';
      const size = fit_font(options.brand_line, brand_px, canvas.width * 0.88);
      context.font = '700 ' + Math.round(size) + 'px system-ui, sans-serif';
      context.fillText(options.brand_line, canvas.width * 0.5, canvas.height * 0.42);
    }
    if (options.sub_line) {
      context.fillStyle = 'rgba(198,214,230,0.82)';
      const size = fit_font(options.sub_line, sub_px, canvas.width * 0.84);
      context.font = Math.round(size) + 'px system-ui, sans-serif';
      context.fillText(options.sub_line, canvas.width * 0.5, canvas.height * 0.64);
    }
    context.textAlign = 'left';
  }
  if (options.labels && options.labels.length > 0) {
    context.font = Math.max(8, Math.round(sub_px)) + 'px system-ui, sans-serif';
    context.textAlign = 'center';
    for (const label of options.labels) {
      context.fillStyle = 'rgba(226,236,246,0.86)';
      context.fillText(label.text, canvas.width * label.x, canvas.height * 0.88);
    }
    context.textAlign = 'left';
  }

  return texture;
}

/**
 * 文本标签贴图（单行，透明底）。
 *
 * @param {string} text 文本。
 * @param {string} color 文本颜色。
 * @param {number} [pixels] 单边像素。
 * @returns {THREE.CanvasTexture} 贴图。
 */
export function label_texture(text: string, color: string, pixels = 128): THREE.Texture {
  if (typeof document === 'undefined') {
    return new THREE.Texture();
  }
  const canvas = document.createElement('canvas');
  canvas.width = pixels;
  canvas.height = Math.round(pixels / 2);
  const context = canvas.getContext('2d');
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  if (context) {
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = color;
    context.font = 'bold ' + Math.round(canvas.height * 0.6) + 'px system-ui, sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(text, canvas.width / 2, canvas.height / 2);
  }

  return texture;
}

/**
 * 通风栅格（由若干条缝隙合并而成，随面板朝向摆放）。
 *
 * @param {number} width 区域宽。
 * @param {number} height 区域高。
 * @param {number} count 条数。
 * @param {number} [depth] 厚度。
 * @returns {THREE.BufferGeometry} 几何体。
 */
export function vent_grille(
  width: number,
  height: number,
  count: number,
  depth = 0.004
): THREE.BufferGeometry {
  const slot_height = (height / count) * 0.45;
  const items: { geometry: THREE.BufferGeometry; matrix: THREE.Matrix4 }[] = [];
  for (let index = 0; index < count; index += 1) {
    const y = -height / 2 + (index + 0.5) * (height / count);
    items.push({
      geometry: new THREE.BoxGeometry(width, slot_height, depth),
      matrix: trs(0, y, 0)
    });
  }

  return merge_geometries(items);
}

/**
 * RJ45 插座（含卡扣与屏蔽罩），开口朝 +Z。
 *
 * @param {number} [width] 宽（米）。
 * @param {number} [height] 高（米）。
 * @param {number} [depth] 深（米）。
 * @returns {THREE.Group} 插座组。
 */
export function rj45_jack(width = 0.0142, height = 0.0122, depth = 0.012): THREE.Group {
  const group = new THREE.Group();
  /* ① 金属屏蔽罩。 */
  const shell = new THREE.Mesh(
    rounded_box(width, height, depth, 0.0008),
    chassis_material(COLOR.silver, { metalness: 0.7, roughness: 0.34 })
  );
  group.add(shell);
  /* ② 塑料内芯。 */
  const core = new THREE.Mesh(
    new THREE.BoxGeometry(width * 0.92, height * 0.86, depth * 0.9),
    plastic_material(COLOR.plastic_dark, 0.85)
  );
  core.position.z = -depth * 0.05;
  group.add(core);
  /* ③ 插孔腔体。 */
  const cavity = new THREE.Mesh(
    new THREE.BoxGeometry(width * 0.78, height * 0.74, depth * 0.42),
    plastic_material('#0a0d11', 0.95)
  );
  cavity.position.z = depth * 0.3;
  group.add(cavity);
  /* ④ 8 根金手指（未插线时可见）。 */
  const pin_items: { geometry: THREE.BufferGeometry; matrix: THREE.Matrix4 }[] = [];
  for (let index = 0; index < 8; index += 1) {
    const offset = (index - 3.5) * (width * 0.1);
    pin_items.push({
      geometry: new THREE.BoxGeometry(width * 0.075, height * 0.06, depth * 0.5),
      matrix: trs(offset, height * 0.24, depth * 0.22)
    });
  }
  group.add(
    new THREE.Mesh(
      merge_geometries(pin_items),
      chassis_material(COLOR.gold, { metalness: 0.9, roughness: 0.25 })
    )
  );
  /* ⑤ 卡扣弹片。 */
  const clip = new THREE.Mesh(
    new THREE.BoxGeometry(width * 0.45, height * 0.14, depth * 0.5),
    chassis_material(COLOR.silver, { metalness: 0.75, roughness: 0.3 })
  );
  clip.position.set(0, -height * 0.5, depth * 0.16);
  group.add(clip);
  /* ⑥ 开口包边（亮色金属框，让端口在深色面板上更立体）。 */
  const bezel_items: { geometry: THREE.BufferGeometry; matrix: THREE.Matrix4 }[] = [];
  const bezel = Math.max(0.0006, width * 0.06);
  bezel_items.push({
    geometry: new THREE.BoxGeometry(width * 0.98, bezel, depth * 0.06),
    matrix: trs(0, height * 0.42, depth * 0.48)
  });
  bezel_items.push({
    geometry: new THREE.BoxGeometry(width * 0.98, bezel, depth * 0.06),
    matrix: trs(0, -height * 0.42, depth * 0.48)
  });
  bezel_items.push({
    geometry: new THREE.BoxGeometry(bezel, height * 0.95, depth * 0.06),
    matrix: trs(-width * 0.46, 0, depth * 0.48)
  });
  bezel_items.push({
    geometry: new THREE.BoxGeometry(bezel, height * 0.95, depth * 0.06),
    matrix: trs(width * 0.46, 0, depth * 0.48)
  });
  group.add(
    new THREE.Mesh(
      merge_geometries(bezel_items),
      chassis_material('#e6ecf3', { metalness: 0.85, roughness: 0.22 })
    )
  );
  /* ⑦ 两枚嵌入式导光窗：链路/速率灯位于插口上沿左右两侧。 */
  for (const side of [-1, 1]) {
    const led_window = new THREE.Mesh(
      rounded_box(width * 0.13, height * 0.11, depth * 0.12, height * 0.025),
      emissive_material(side < 0 ? '#123a30' : '#3a3014', 0.16)
    );
    led_window.position.set(side * width * 0.34, height * 0.36, depth * 0.48);
    led_window.name = side < 0 ? 'link_led_window' : 'speed_led_window';
    group.add(led_window);
  }

  return group;
}

/**
 * SFP/SFP+ 笼子（金属笼 + 上盖弹片），开口朝 +Z。
 *
 * @param {number} [width] 宽（米）。
 * @param {number} [height] 高（米）。
 * @param {number} [depth] 深（米）。
 * @returns {THREE.Group} 笼子组。
 */
export function sfp_cage(width = 0.0145, height = 0.0098, depth = 0.052): THREE.Group {
  const group = new THREE.Group();
  const cage = new THREE.Mesh(
    rounded_box(width, height, depth, 0.0006),
    chassis_material(COLOR.silver, { metalness: 0.72, roughness: 0.32 })
  );
  group.add(cage);
  /* 笼口内衬。 */
  const mouth = new THREE.Mesh(
    new THREE.BoxGeometry(width * 0.74, height * 0.58, depth * 0.05),
    plastic_material('#0a0d11', 0.95)
  );
  mouth.position.z = depth * 0.49;
  group.add(mouth);
  /* EMI 弹片：开口上下各 6 片。 */
  const finger_items: { geometry: THREE.BufferGeometry; matrix: THREE.Matrix4 }[] = [];
  for (let index = 0; index < 6; index += 1) {
    const offset = (index - 2.5) * (width * 0.15);
    for (const sign of [1, -1]) {
      finger_items.push({
        geometry: new THREE.BoxGeometry(width * 0.05, height * 0.2, depth * 0.03),
        matrix: trs(offset, sign * height * 0.36, depth * 0.5)
      });
    }
  }
  group.add(
    new THREE.Mesh(
      merge_geometries(finger_items),
      chassis_material(COLOR.silver, { metalness: 0.8, roughness: 0.28 })
    )
  );
  /* 上盖弹片。 */
  const latch = new THREE.Mesh(
    new THREE.BoxGeometry(width * 0.86, height * 0.16, depth * 0.1),
    chassis_material(COLOR.gold, { metalness: 0.85, roughness: 0.25 })
  );
  latch.position.set(0, height * 0.5, depth * 0.3);
  group.add(latch);
  /* 防尘塞（未插模块时可见）。 */
  const dust_plug = new THREE.Mesh(
    new THREE.BoxGeometry(width * 0.7, height * 0.5, depth * 0.06),
    plastic_material('#1b2b45', 0.55)
  );
  dust_plug.position.z = depth * 0.5;
  dust_plug.name = 'port_dust_plug';
  group.add(dust_plug);
  /* 笼口序列压痕与接地弹片让空 SFP 槽在近景下仍有工业细节。 */
  for (const side of [-1, 1]) {
    const grounding_tab = new THREE.Mesh(
      new THREE.BoxGeometry(width * 0.12, height * 0.54, depth * 0.025),
      chassis_material('#b8c0c8', { metalness: 0.92, roughness: 0.2 })
    );
    grounding_tab.position.set(side * width * 0.44, 0, depth * 0.48);
    group.add(grounding_tab);
  }

  return group;
}

/**
 * SC/APC 光口（GPON 用，蓝色方口 + 绿斜切）。
 *
 * @param {number} [size] 边长（米）。
 * @returns {THREE.Group} 光口组。
 */
export function sc_adapter(size = 0.0125): THREE.Group {
  const group = new THREE.Group();
  const body = new THREE.Mesh(
    rounded_box(size, size * 0.72, size * 0.9, 0.0006),
    plastic_material('#2f6fd0', 0.55)
  );
  group.add(body);
  const cap = new THREE.Mesh(
    new THREE.CylinderGeometry(size * 0.16, size * 0.16, size * 1.1, 16),
    plastic_material('#2f9e63', 0.5)
  );
  cap.rotation.x = Math.PI / 2;
  cap.position.z = size * 0.5;
  group.add(cap);
  /* 内部陶瓷插芯。 */
  const ferrule = new THREE.Mesh(
    new THREE.CylinderGeometry(size * 0.07, size * 0.07, size * 0.9, 12),
    new THREE.MeshStandardMaterial({
      color: new THREE.Color('#e8eef5'),
      roughness: 0.25,
      metalness: 0.1
    })
  );
  ferrule.rotation.x = Math.PI / 2;
  ferrule.position.z = size * 0.62;
  group.add(ferrule);
  /* 防尘帽（未接线时可见）。 */
  const dust_cap = new THREE.Mesh(
    new THREE.CylinderGeometry(size * 0.2, size * 0.2, size * 0.5, 14),
    plastic_material('#0f2f4a', 0.6)
  );
  dust_cap.rotation.x = Math.PI / 2;
  dust_cap.position.z = size * 0.78;
  dust_cap.name = 'port_dust_cap';
  group.add(dust_cap);

  return group;
}

/**
 * 直流电源座（圆形 DC 桶）。
 *
 * @param {number} [radius] 半径（米）。
 * @returns {THREE.Group} 电源座组。
 */
export function dc_barrel_jack(radius = 0.0045): THREE.Group {
  const group = new THREE.Group();
  const ring = new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius, 0.004, 20),
    chassis_material(COLOR.silver)
  );
  ring.rotation.x = Math.PI / 2;
  group.add(ring);
  const pin = new THREE.Mesh(
    new THREE.CylinderGeometry(radius * 0.28, radius * 0.28, 0.006, 12),
    chassis_material(COLOR.gold)
  );
  pin.rotation.x = Math.PI / 2;
  group.add(pin);

  return group;
}

/**
 * IEC C14 交流电源插座（品字口）。
 *
 * @returns {THREE.Group} 插座组。
 */
export function iec_c14_jack(): THREE.Group {
  const group = new THREE.Group();
  const plate = new THREE.Mesh(
    rounded_box(0.034, 0.028, 0.0055, 0.0018),
    plastic_material('#10141a', 0.72)
  );
  plate.name = 'iec_outer_bezel';
  group.add(plate);

  /* IEC C14 的内腔上窄下宽，采用挤出轮廓而不是普通黑色矩形。 */
  const cavity_shape = new THREE.Shape();
  cavity_shape.moveTo(-0.0092, 0.0087);
  cavity_shape.lineTo(0.0092, 0.0087);
  cavity_shape.lineTo(0.0115, -0.0087);
  cavity_shape.lineTo(-0.0115, -0.0087);
  cavity_shape.closePath();
  const cavity_geometry = new THREE.ExtrudeGeometry(cavity_shape, {
    depth: 0.0013,
    bevelEnabled: true,
    bevelSegments: 2,
    steps: 1,
    bevelSize: 0.00055,
    bevelThickness: 0.00045
  });
  cavity_geometry.center();
  const cavity = new THREE.Mesh(cavity_geometry, plastic_material('#05070a', 0.96));
  cavity.position.z = 0.003;
  cavity.name = 'iec_recessed_cavity';
  group.add(cavity);

  const positions: [number, number][] = [
    [0, 0.0055],
    [-0.0062, -0.0047],
    [0.0062, -0.0047]
  ];
  for (const [index, [x, y]] of positions.entries()) {
    const pin = new THREE.Mesh(
      rounded_box(0.0017, index === 0 ? 0.0055 : 0.0048, 0.001, 0.00025),
      chassis_material('#d9dde2', { metalness: 0.92, roughness: 0.2 })
    );
    pin.position.set(x, y, 0.00415);
    pin.name = index === 0 ? 'iec_ground_blade' : 'iec_power_blade';
    group.add(pin);
  }

  /* 面板固定螺钉。 */
  for (const x of [-0.0143, 0.0143]) {
    const fastener = new THREE.Mesh(
      new THREE.CylinderGeometry(0.00135, 0.00135, 0.001, 14),
      chassis_material('#7c838b', { metalness: 0.82, roughness: 0.28 })
    );
    fastener.rotation.x = Math.PI / 2;
    fastener.position.set(x, 0, 0.00325);
    fastener.name = 'iec_fastener';
    group.add(fastener);
  }

  return group;
}

/**
 * 指示灯（圆点 + 轻微外凸）。
 *
 * @param {string} color 颜色。
 * @param {number} [radius] 半径（米）。
 * @returns {THREE.Group} 指示灯组。
 */
export function led_dot(color: string, radius = 0.0022): THREE.Group {
  const group = new THREE.Group();
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(radius, 14, 10, 0, Math.PI * 2, 0, Math.PI / 2),
    emissive_material(color)
  );
  dome.rotation.x = Math.PI / 2;
  group.add(dome);
  const bezel = new THREE.Mesh(
    new THREE.CylinderGeometry(radius * 1.2, radius * 1.2, radius * 0.4, 16),
    plastic_material(COLOR.plastic_dark, 0.7)
  );
  bezel.rotation.x = Math.PI / 2;
  bezel.position.z = -radius * 0.2;
  group.add(bezel);

  return group;
}

/**
 * 面板螺丝。
 *
 * @param {number} [radius] 半径（米）。
 * @returns {THREE.Mesh} 螺丝。
 */
export function screw(radius = 0.0035): THREE.Mesh {
  const head = new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius, radius * 0.5, 14),
    chassis_material(COLOR.chassis_dark)
  );
  head.rotation.x = Math.PI / 2;
  /* 十字槽用两个深色凹线表达，近景可辨认安装件而不是普通圆点。 */
  const slot_material = plastic_material('#101419', 0.82);
  for (const rotation of [0, Math.PI / 2]) {
    const slot = new THREE.Mesh(
      new THREE.BoxGeometry(radius * 1.1, radius * 0.18, radius * 0.08),
      slot_material
    );
    slot.rotation.z = rotation;
    slot.position.y = radius * 0.27;
    head.add(slot);
  }

  return head;
}

/**
 * 机架安装耳。
 *
 * @param {number} height 高度（米）。
 * @param {number} depth 深度（米）。
 * @param {number} [thickness] 厚度（米）。
 * @returns {THREE.Mesh} 安装耳。
 */
export function rack_ear(height: number, depth: number, thickness = 0.003): THREE.Mesh {
  const ear = new THREE.Mesh(
    rounded_box(thickness, height * 0.92, depth * 0.16, 0.001),
    chassis_material(COLOR.chassis_mid, { metalness: 0.74, roughness: 0.34 })
  );
  for (const y of [-height * 0.27, height * 0.27]) {
    const hole = new THREE.Mesh(
      new THREE.CylinderGeometry(height * 0.055, height * 0.055, thickness * 1.8, 18),
      plastic_material('#090c10', 0.96)
    );
    hole.rotation.x = Math.PI / 2;
    hole.position.set(0, y, depth * 0.078);
    ear.add(hole);
  }

  return ear;
}

/**
 * 无线天线（杆 + 底座 + 关节）。
 *
 * @param {number} [length] 杆长（米）。
 * @param {number} [radius] 杆半径（米）。
 * @returns {THREE.Group} 天线组。
 */
export function antenna_rod(length = 0.12, radius = 0.0055): THREE.Group {
  const group = new THREE.Group();
  const base = new THREE.Mesh(
    new THREE.CylinderGeometry(radius * 1.5, radius * 1.7, length * 0.14, 16),
    plastic_material(COLOR.plastic_dark, 0.6)
  );
  base.position.y = length * 0.07;
  group.add(base);
  const collar = new THREE.Mesh(
    new THREE.CylinderGeometry(radius * 1.18, radius * 1.18, length * 0.045, 20),
    chassis_material(COLOR.gold, { metalness: 0.92, roughness: 0.22 })
  );
  collar.position.y = length * 0.145;
  group.add(collar);
  const joint = new THREE.Mesh(
    new THREE.SphereGeometry(radius * 1.15, 12, 10),
    plastic_material(COLOR.plastic_gray, 0.5)
  );
  joint.position.y = length * 0.16;
  group.add(joint);
  const rod = new THREE.Mesh(
    new THREE.CylinderGeometry(radius * 0.75, radius * 0.95, length * 0.82, 14),
    plastic_material(COLOR.plastic_dark, 0.55)
  );
  rod.position.y = length * 0.16 + length * 0.41;
  group.add(rod);
  const tip = new THREE.Mesh(
    new THREE.SphereGeometry(radius * 0.77, 14, 10),
    plastic_material('#12161c', 0.48)
  );
  tip.scale.y = 1.2;
  tip.position.y = length * 0.985;
  group.add(tip);

  return group;
}

/** 屏幕界面贴图缓存。 */
const SCREEN_TEXTURE_CACHE = new Map<string, THREE.Texture>();

/**
 * 生成教学终端桌面贴图：渐变壁纸、窗口、任务栏和状态指示均为程序化绘制。
 *
 * @param {string} glow 主色。
 * @returns {THREE.Texture} 屏幕贴图。
 */
export function screen_texture(glow = '#1b2b45'): THREE.Texture {
  const cached = SCREEN_TEXTURE_CACHE.get(glow);
  if (cached) {
    return cached;
  }
  if (typeof document === 'undefined') {
    return new THREE.Texture();
  }
  const canvas = document.createElement('canvas');
  canvas.width = 960;
  canvas.height = 600;
  const context = canvas.getContext('2d');
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  if (context) {
    const background = context.createLinearGradient(0, 0, canvas.width, canvas.height);
    background.addColorStop(0, '#071425');
    background.addColorStop(0.5, glow);
    background.addColorStop(1, '#0c4f63');
    context.fillStyle = background;
    context.fillRect(0, 0, canvas.width, canvas.height);
    const halo = context.createRadialGradient(700, 150, 10, 700, 150, 420);
    halo.addColorStop(0, 'rgba(84,232,219,0.36)');
    halo.addColorStop(1, 'rgba(20,70,100,0)');
    context.fillStyle = halo;
    context.fillRect(0, 0, canvas.width, canvas.height);

    /* 网络实验状态窗口。 */
    context.fillStyle = 'rgba(7,14,24,0.82)';
    context.strokeStyle = 'rgba(105,220,230,0.45)';
    context.lineWidth = 2;
    context.beginPath();
    context.roundRect(86, 72, 510, 340, 14);
    context.fill();
    context.stroke();
    context.fillStyle = '#172a3b';
    context.beginPath();
    context.roundRect(86, 72, 510, 48, [14, 14, 0, 0]);
    context.fill();
    context.fillStyle = '#dce8f3';
    context.font = '600 23px system-ui, sans-serif';
    context.fillText('SimLab Network Console', 112, 104);
    context.font = '19px ui-monospace, monospace';
    const lines = [
      '$ ip link show eth0',
      '2: eth0: <BROADCAST,MULTICAST,UP>',
      '    inet 192.168.10.21/24',
      '$ ping 192.168.10.1',
      '64 bytes: ttl=64 time=0.42 ms',
      'link state: UP · 1000 Mbps'
    ];
    lines.forEach((line, index) => {
      context.fillStyle = index === lines.length - 1 ? '#57e8c9' : '#a9bfd2';
      context.fillText(line, 116, 157 + index * 40);
    });

    /* 右侧拓扑卡片。 */
    context.fillStyle = 'rgba(7,14,24,0.66)';
    context.beginPath();
    context.roundRect(630, 72, 244, 210, 14);
    context.fill();
    context.stroke();
    const nodes: [number, number][] = [
      [690, 140],
      [810, 120],
      [758, 220]
    ];
    context.strokeStyle = '#4adac8';
    context.lineWidth = 4;
    context.beginPath();
    context.moveTo(nodes[0][0], nodes[0][1]);
    context.lineTo(nodes[1][0], nodes[1][1]);
    context.lineTo(nodes[2][0], nodes[2][1]);
    context.lineTo(nodes[0][0], nodes[0][1]);
    context.stroke();
    for (const [x, y] of nodes) {
      context.fillStyle = '#112c3c';
      context.strokeStyle = '#72f2df';
      context.beginPath();
      context.arc(x, y, 17, 0, Math.PI * 2);
      context.fill();
      context.stroke();
    }

    /* 底部任务栏与状态。 */
    context.fillStyle = 'rgba(5,10,18,0.88)';
    context.fillRect(0, 548, canvas.width, 52);
    for (let index = 0; index < 5; index += 1) {
      context.fillStyle = index === 0 ? '#38d8c1' : '#6e8094';
      context.beginPath();
      context.roundRect(28 + index * 48, 562, 24, 24, 5);
      context.fill();
    }
    context.fillStyle = '#c4d2df';
    context.font = '18px system-ui, sans-serif';
    context.fillText('NET 1000M  ·  10:24', 748, 582);
  }
  SCREEN_TEXTURE_CACHE.set(glow, texture);

  return texture;
}

/** 移动终端屏幕贴图缓存。 */
let mobile_screen_cache: THREE.Texture | null = null;

/**
 * 生成手机锁屏/网络状态界面贴图。
 *
 * @returns {THREE.Texture} 竖屏贴图。
 */
export function mobile_screen_texture(): THREE.Texture {
  if (mobile_screen_cache) {
    return mobile_screen_cache;
  }
  if (typeof document === 'undefined') {
    return new THREE.Texture();
  }
  const canvas = document.createElement('canvas');
  canvas.width = 480;
  canvas.height = 1024;
  const context = canvas.getContext('2d');
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  if (context) {
    const background = context.createLinearGradient(0, 0, 480, 1024);
    background.addColorStop(0, '#08182b');
    background.addColorStop(0.55, '#163e58');
    background.addColorStop(1, '#071017');
    context.fillStyle = background;
    context.fillRect(0, 0, 480, 1024);
    const halo = context.createRadialGradient(340, 260, 20, 340, 260, 380);
    halo.addColorStop(0, 'rgba(58,231,205,0.5)');
    halo.addColorStop(1, 'rgba(20,82,103,0)');
    context.fillStyle = halo;
    context.fillRect(0, 0, 480, 1024);
    context.fillStyle = '#eaf4fb';
    context.font = '600 92px system-ui, sans-serif';
    context.textAlign = 'center';
    context.fillText('10:24', 240, 210);
    context.font = '25px system-ui, sans-serif';
    context.fillStyle = '#b9cad7';
    context.fillText('10月4日  星期日', 240, 258);
    context.fillStyle = 'rgba(8,18,29,0.72)';
    context.beginPath();
    context.roundRect(38, 340, 404, 210, 32);
    context.fill();
    context.textAlign = 'left';
    context.fillStyle = '#72ead8';
    context.font = '600 28px system-ui, sans-serif';
    context.fillText('SimLab 网络', 76, 398);
    context.fillStyle = '#d3e1eb';
    context.font = '25px system-ui, sans-serif';
    context.fillText('Wi-Fi 6  已连接', 76, 452);
    context.fillText('192.168.10.32 · -48 dBm', 76, 498);
    for (let index = 0; index < 4; index += 1) {
      context.fillStyle = index === 0 ? '#4ae0c9' : 'rgba(220,235,244,0.72)';
      context.beginPath();
      context.arc(102 + index * 92, 870, 30, 0, Math.PI * 2);
      context.fill();
    }
    context.fillStyle = 'rgba(238,246,251,0.84)';
    context.beginPath();
    context.roundRect(176, 980, 128, 8, 4);
    context.fill();
  }
  mobile_screen_cache = texture;

  return texture;
}

/**
 * 显示屏（边框 + 发光面板）。
 *
 * @param {number} width 宽（米）。
 * @param {number} height 高（米）。
 * @param {string} [glow] 屏幕颜色。
 * @returns {THREE.Group} 屏幕组。
 */
export function screen_panel(width: number, height: number, glow = '#1b2b45'): THREE.Group {
  const group = new THREE.Group();
  const bezel = new THREE.Mesh(
    rounded_box(width, height, 0.008, 0.003),
    plastic_material(COLOR.plastic_dark, 0.5)
  );
  group.add(bezel);
  const panel = new THREE.Mesh(
    new THREE.PlaneGeometry(width * 0.94, height * 0.9),
    new THREE.MeshPhysicalMaterial({
      color: '#ffffff',
      map: screen_texture(glow),
      emissive: '#ffffff',
      emissiveMap: screen_texture(glow),
      emissiveIntensity: 0.42,
      roughness: 0.08,
      metalness: 0.05,
      clearcoat: 1,
      clearcoatRoughness: 0.08
    })
  );
  panel.name = 'screen_surface';
  panel.position.z = 0.0045;
  group.add(panel);
  const camera = new THREE.Mesh(
    new THREE.SphereGeometry(Math.min(width, height) * 0.012, 14, 10),
    new THREE.MeshPhysicalMaterial({
      color: '#05080c',
      roughness: 0.06,
      metalness: 0.18,
      clearcoat: 1
    })
  );
  camera.position.set(0, height * 0.465, 0.0048);
  group.add(camera);

  return group;
}

/**
 * 键盘面板（底座 + 键帽阵列）。
 *
 * @param {number} width 宽（米）。
 * @param {number} depth 深（米）。
 * @param {number} [rows] 键行数。
 * @param {number} [columns] 每行键数。
 * @returns {THREE.Group} 键盘组。
 */
export function keyboard_deck(width: number, depth: number, rows = 5, columns = 14): THREE.Group {
  const group = new THREE.Group();
  const deck = new THREE.Mesh(
    rounded_box(width, 0.0035, depth, 0.0012),
    plastic_material(COLOR.plastic_gray, 0.7)
  );
  group.add(deck);
  const key_width = (width * 0.92) / columns;
  const key_depth = (depth * 0.6) / rows;
  const items: { geometry: THREE.BufferGeometry; matrix: THREE.Matrix4 }[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const x = -width * 0.46 + (column + 0.5) * key_width;
      const z = -depth * 0.28 + (row + 0.5) * key_depth;
      items.push({
        geometry: new THREE.BoxGeometry(key_width * 0.82, 0.0022, key_depth * 0.78),
        matrix: trs(x, 0.0026, z)
      });
    }
  }
  const keys = new THREE.Mesh(merge_geometries(items), plastic_material(COLOR.plastic_dark, 0.85));
  group.add(keys);

  /* 一张透明键帽丝印覆盖层替代数十份独立材质，近景可读且保持绘制批次稳定。 */
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = 360;
    const context = canvas.getContext('2d');
    if (context) {
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = 'rgba(220,230,240,0.72)';
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.font = '600 23px system-ui, sans-serif';
      const legends = ['1234567890-=', 'QWERTYUIOP[]', 'ASDFGHJKL;\'', 'ZXCVBNM,./', ''];
      for (let row = 0; row < rows; row += 1) {
        const legend = legends[row] || '';
        for (let column = 0; column < columns; column += 1) {
          const text = legend[column] || (row === rows - 1 && column === 6 ? 'SPACE' : '');
          if (!text) {
            continue;
          }
          context.fillText(
            text,
            ((column + 0.5) / columns) * canvas.width,
            ((row + 0.5) / rows) * canvas.height
          );
        }
      }
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = 8;
      const legends_mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(width * 0.92, depth * 0.6),
        new THREE.MeshBasicMaterial({
          map: texture,
          transparent: true,
          depthWrite: false,
          opacity: 0.82
        })
      );
      legends_mesh.rotation.x = -Math.PI / 2;
      legends_mesh.position.set(0, 0.0038, depth * 0.02);
      group.add(legends_mesh);
    }
  }

  /* 扬声器微孔阵列。 */
  const speaker_holes: { geometry: THREE.BufferGeometry; matrix: THREE.Matrix4 }[] = [];
  for (const side of [-1, 1]) {
    for (let index = 0; index < 18; index += 1) {
      speaker_holes.push({
        geometry: new THREE.CylinderGeometry(0.00065, 0.00065, 0.0008, 8),
        matrix: trs(
          side * width * 0.475,
          0.0022,
          -depth * 0.34 + index * ((depth * 0.68) / 17)
        )
      });
    }
  }
  group.add(new THREE.Mesh(merge_geometries(speaker_holes), plastic_material('#0d1116', 0.92)));

  return group;
}

/**
 * 主板（内部结构，透视/爆炸视图用）。
 *
 * @param {number} width 宽（米）。
 * @param {number} depth 深（米）。
 * @returns {THREE.Group} 主板组。
 */
export function main_board(width: number, depth: number): THREE.Group {
  const group = new THREE.Group();
  const board = new THREE.Mesh(
    new THREE.BoxGeometry(width * 0.86, 0.0016, depth * 0.8),
    new THREE.MeshStandardMaterial({
      color: new THREE.Color('#1d3a2a'),
      roughness: 0.85,
      metalness: 0.1
    })
  );
  group.add(board);
  const items: { geometry: THREE.BufferGeometry; matrix: THREE.Matrix4 }[] = [];
  const chips = [
    [-0.22, 0.16],
    [0.08, 0.24],
    [0.3, -0.1],
    [-0.12, -0.24]
  ];
  for (const [offset_x, offset_z] of chips) {
    items.push({
      geometry: new THREE.BoxGeometry(width * 0.14, 0.004, depth * 0.12),
      matrix: trs(width * offset_x, 0.003, depth * offset_z)
    });
  }
  const chip_mesh = new THREE.Mesh(
    merge_geometries(items),
    plastic_material(COLOR.plastic_dark, 0.6)
  );
  group.add(chip_mesh);

  return group;
}

/**
 * 风扇（框 + 扇叶）。
 *
 * @param {number} size 边长（米）。
 * @returns {THREE.Group} 风扇组。
 */
export function fan_module(size = 0.04): THREE.Group {
  const group = new THREE.Group();
  group.name = 'axial_fan';
  const depth = size * 0.24;
  const rail = size * 0.095;
  const frame_items: { geometry: THREE.BufferGeometry; matrix: THREE.Matrix4 }[] = [];
  for (const side of [-1, 1]) {
    frame_items.push({
      geometry: rounded_box(rail, size, depth, rail * 0.28),
      matrix: trs(side * (size - rail) / 2, 0, 0)
    });
    frame_items.push({
      geometry: rounded_box(size - rail * 2, rail, depth, rail * 0.28),
      matrix: trs(0, side * (size - rail) / 2, 0)
    });
  }
  const frame = new THREE.Mesh(
    merge_geometries(frame_items),
    plastic_material('#171b21', 0.68)
  );
  frame.name = 'fan_open_frame';
  group.add(frame);

  /* 暗色内腔提供真实的风道深度，同时不遮挡前方扇叶。 */
  const duct = new THREE.Mesh(
    new THREE.CylinderGeometry(size * 0.395, size * 0.395, depth * 0.72, 32),
    plastic_material('#080b0f', 0.96)
  );
  duct.rotation.x = Math.PI / 2;
  duct.position.z = -depth * 0.1;
  duct.name = 'fan_duct';
  group.add(duct);

  const hub = new THREE.Mesh(
    new THREE.CylinderGeometry(size * 0.15, size * 0.18, depth * 0.56, 24),
    plastic_material('#242a32', 0.5)
  );
  hub.rotation.x = Math.PI / 2;
  hub.position.z = depth * 0.16;
  hub.name = 'fan_hub';
  group.add(hub);
  const blade_items: { geometry: THREE.BufferGeometry; matrix: THREE.Matrix4 }[] = [];
  for (let index = 0; index < 7; index += 1) {
    const angle = (index / 7) * Math.PI * 2;
    blade_items.push({
      geometry: rounded_box(size * 0.285, size * 0.092, size * 0.025, size * 0.018),
      matrix: trs(
        Math.cos(angle) * size * 0.245,
        Math.sin(angle) * size * 0.245,
        depth * 0.22,
        0,
        0,
        angle + 0.34
      )
    });
  }
  const blades = new THREE.Mesh(
    merge_geometries(blade_items),
    plastic_material('#303740', 0.48)
  );
  blades.name = 'fan_blades';
  group.add(blades);

  /* 同心钢丝护网与十字支撑。 */
  const guard_material = chassis_material('#707881', { metalness: 0.84, roughness: 0.3 });
  for (const radius_ratio of [0.2, 0.31, 0.405]) {
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(size * radius_ratio, size * 0.012, 6, 40),
      guard_material
    );
    ring.position.z = depth * 0.56;
    ring.name = 'fan_guard_ring';
    group.add(ring);
  }
  for (const rotation of [Math.PI / 4, -Math.PI / 4]) {
    const brace = new THREE.Mesh(
      rounded_box(size * 0.82, size * 0.018, size * 0.018, size * 0.006),
      guard_material
    );
    brace.rotation.z = rotation;
    brace.position.z = depth * 0.55;
    brace.name = 'fan_guard_brace';
    group.add(brace);
  }

  /* 四角固定孔。 */
  for (const x of [-1, 1]) {
    for (const y of [-1, 1]) {
      const fastener = new THREE.Mesh(
        new THREE.CylinderGeometry(size * 0.035, size * 0.035, depth * 0.12, 14),
        chassis_material('#89919a', { metalness: 0.8, roughness: 0.3 })
      );
      fastener.rotation.x = Math.PI / 2;
      fastener.position.set(x * size * 0.405, y * size * 0.405, depth * 0.55);
      fastener.name = 'fan_fastener';
      group.add(fastener);
    }
  }
  group.userData.blades = blades;

  return group;
}
