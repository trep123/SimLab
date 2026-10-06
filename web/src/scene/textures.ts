/**
 * @File : scene/textures.ts
 * @Time : 2026-10-04 12:35
 * @Author : Cetrp
 * @Description : 程序化贴图：拉丝金属机箱、散热孔、丝印面板、PCB 与背面接口，全部随厂商品牌参数变化
 * 。
 */
import * as THREE from 'three';

import { utils } from '../core/constants';

/**
 * 创建 Canvas 贴图。
 *
 * @param {number} width 宽。
 * @param {number} height 高。
 * @param {Function} draw 绘制函数 (ctx, w, h)。
 * @param {boolean} [repeat] 是否重复平铺。
 * @returns {object} THREE.CanvasTexture。
 */
function canvas_texture(width, height, draw, repeat = false) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  draw(canvas.getContext('2d'), width, height);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  if (repeat) {
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
  }
  return texture;
}

/**
 * 生成灰度贴图（粗糙度等）。
 *
 * @param {number} width 宽。
 * @param {number} height 高。
 * @param {Function} draw 绘制函数。
 * @returns {object} 灰度贴图。
 */
function gray_texture(width, height, draw) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  draw(canvas.getContext('2d'), width, height);
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  return texture;
}

/**
 * 十六进制颜色转 {r,g,b}。
 *
 * @param {string} hex 颜色。
 * @returns {object} RGB 分量。
 */
function hex_to_rgb(hex) {
  const value = String(hex || '#888888').replace('#', '');
  return {
    r: parseInt(value.slice(0, 2), 16),
    g: parseInt(value.slice(2, 4), 16),
    b: parseInt(value.slice(4, 6), 16)
  };
}

/**
 * 调整颜色明度。
 *
 * @param {string} hex 颜色。
 * @param {number} ratio 明度比例，>1 变亮，<1 变暗。
 * @returns {string} 新的十六进制颜色。
 */
function shade(hex, ratio) {
  const rgb = hex_to_rgb(hex);
  const clamp_byte = (value) => Math.max(0, Math.min(255, Math.round(value * ratio)));
  const to_hex = (value) => value.toString(16).padStart(2, '0');
  return '#' + to_hex(clamp_byte(rgb.r)) + to_hex(clamp_byte(rgb.g)) + to_hex(clamp_byte(rgb.b));
}

/**
 * 拉丝金属贴图。
 *
 * @param {string} base_color 基色。
 * @param {boolean} horizontal 是否水平拉丝。
 * @returns {object} 贴图。
 */
function make_brushed(base_color, horizontal) {
  const rgb = hex_to_rgb(base_color);
  return canvas_texture(
    512,
    512,
    (ctx, width, height) => {
      ctx.fillStyle = 'rgb(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ')';
      ctx.fillRect(0, 0, width, height);
      for (let i = 0; i < 4200; i += 1) {
        const delta = utils.rnd(-22, 20);
        const value_r = Math.max(0, Math.min(255, rgb.r + delta));
        const value_g = Math.max(0, Math.min(255, rgb.g + delta));
        const value_b = Math.max(0, Math.min(255, rgb.b + delta));
        ctx.strokeStyle =
          'rgba(' +
          Math.round(value_r) +
          ',' +
          Math.round(value_g) +
          ',' +
          Math.round(value_b) +
          ',' +
          utils.rnd(0.15, 0.45).toFixed(2) +
          ')';
        ctx.lineWidth = utils.rnd(0.5, 1.6);
        if (horizontal) {
          const y = Math.random() * height;
          ctx.beginPath();
          ctx.moveTo(0, y);
          ctx.lineTo(width, y + utils.rnd(-2, 2));
          ctx.stroke();
        } else {
          const x = Math.random() * width;
          ctx.beginPath();
          ctx.moveTo(x, 0);
          ctx.lineTo(x + utils.rnd(-2, 2), height);
          ctx.stroke();
        }
      }
      for (let i = 0; i < 90; i += 1) {
        ctx.strokeStyle = 'rgba(255,255,255,' + utils.rnd(0.02, 0.08).toFixed(3) + ')';
        ctx.lineWidth = utils.rnd(0.4, 1);
        const y = Math.random() * height;
        ctx.beginPath();
        ctx.moveTo(utils.rnd(0, width), y);
        ctx.lineTo(
          utils.rnd(0, width) + (horizontal ? utils.rnd(40, 220) : 0),
          y + (horizontal ? utils.rnd(-1, 1) : utils.rnd(40, 220))
        );
        ctx.stroke();
      }
    },
    true
  );
}

/**
 * 粗糙度贴图。
 *
 * @returns {object} 灰度贴图。
 */
function make_brushed_rough() {
  return gray_texture(256, 256, (ctx, width, height) => {
    ctx.fillStyle = '#9a9a9a';
    ctx.fillRect(0, 0, width, height);
    for (let i = 0; i < 2200; i += 1) {
      const value = Math.round(utils.rnd(110, 200));
      ctx.strokeStyle =
        'rgba(' + value + ',' + value + ',' + value + ',' + utils.rnd(0.2, 0.5).toFixed(2) + ')';
      ctx.lineWidth = utils.rnd(0.6, 2);
      const y = Math.random() * height;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }
  });
}

/**
 * PCB 贴图（阻焊绿油 + 走线 + 过孔 + 丝印）。
 *
 * @param {string} solder_color 阻焊颜色。
 * @returns {object} 贴图。
 */
function make_pcb(solder_color) {
  const base = hex_to_rgb(solder_color);
  return canvas_texture(
    1400,
    700,
    (ctx, width, height) => {
      ctx.fillStyle = solder_color;
      ctx.fillRect(0, 0, width, height);
      for (let i = 0; i < 24; i += 1) {
        ctx.fillStyle =
          'rgba(' +
          Math.round(base.r * 0.7) +
          ',' +
          Math.round(base.g * 0.8) +
          ',' +
          Math.round(base.b * 0.7) +
          ',' +
          utils.rnd(0.3, 0.7).toFixed(2) +
          ')';
        const x = utils.rnd(0, width);
        const y = utils.rnd(0, height);
        ctx.beginPath();
        ctx.moveTo(x, y);
        for (let k = 0; k < 5; k += 1) {
          ctx.lineTo(x + utils.rnd(-160, 160), y + utils.rnd(-120, 120));
        }
        ctx.closePath();
        ctx.fill();
      }
      for (let bus_index = 0; bus_index < 10; bus_index += 1) {
        const y = utils.rnd(60, height - 60);
        ctx.lineWidth = 2.2;
        ctx.strokeStyle = 'rgba(190,205,120,.5)';
        ctx.beginPath();
        ctx.moveTo(20, y);
        for (let x = 20; x < width; x += 26) {
          ctx.lineTo(x, y + utils.rnd(-3, 3));
        }
        ctx.stroke();
      }
      for (let pair = 0; pair < 14; pair += 1) {
        let x = utils.rnd(40, width * 0.5);
        let y = utils.rnd(30, height - 30);
        const direction = Math.random() < 0.5 ? 1 : -1;
        ctx.strokeStyle = 'rgba(205,215,130,' + utils.rnd(0.35, 0.65).toFixed(2) + ')';
        ctx.lineWidth = 1.6;
        for (const offset of [0, 6]) {
          ctx.beginPath();
          ctx.moveTo(x, y + offset);
          let cursor_x = x;
          let cursor_y = y + offset;
          for (let step = 0; step < utils.rint(4, 8); step += 1) {
            const length = utils.rnd(24, 70);
            if (Math.random() < 0.5) {
              cursor_x += length;
              ctx.lineTo(cursor_x, cursor_y);
            } else {
              cursor_y += direction * length;
              ctx.lineTo(cursor_x, cursor_y);
            }
          }
          ctx.stroke();
        }
      }
      ctx.fillStyle = 'rgba(215,205,140,.8)';
      for (let i = 0; i < 60; i += 1) {
        const x = utils.rnd(0, width);
        const y = utils.rnd(0, height);
        if (Math.random() < 0.5) {
          ctx.fillRect(x, y, 7, 3.4);
        } else {
          ctx.fillRect(x, y, 3.4, 7);
        }
      }
      for (let i = 0; i < 180; i += 1) {
        const x = utils.rnd(0, width);
        const y = utils.rnd(0, height);
        ctx.fillStyle = 'rgba(220,210,150,.9)';
        ctx.beginPath();
        ctx.arc(x, y, 3.2, 0, 7);
        ctx.fill();
        ctx.fillStyle = 'rgba(10,25,18,.95)';
        ctx.beginPath();
        ctx.arc(x, y, 1.5, 0, 7);
        ctx.fill();
      }
      ctx.fillStyle = 'rgba(235,240,225,.7)';
      ctx.font = '11px monospace';
      ctx.textBaseline = 'top';
      const names = ['U1', 'U2', 'U3', 'U4', 'U5', 'J1', 'J2', 'TP1', 'R14', 'C31', 'L7', 'Y1'];
      for (let i = 0; i < 40; i += 1) {
        ctx.fillText(names[i % names.length], utils.rnd(8, width - 40), utils.rnd(8, height - 16));
      }
      ctx.strokeStyle = 'rgba(235,240,225,.45)';
      ctx.lineWidth = 1.2;
      for (let i = 0; i < 8; i += 1) {
        ctx.strokeRect(
          utils.rnd(20, width - 140),
          utils.rnd(20, height - 100),
          utils.rnd(50, 130),
          utils.rnd(30, 86)
        );
      }
    },
    true
  );
}

/**
 * 顶盖贴图：拉丝 + 冲压散热孔 + 铭牌。
 *
 * @param {object} options 参数。
 * @param {object} options.brand 品牌参数。
 * @param {string} options.model_line 型号丝印。
 * @param {string} options.sub_line 规格丝印。
 * @param {string} options.serial 序列号。
 * @param {string} options.mac MAC 地址。
 * @returns {object} 贴图。
 */
function make_top(options) {
  const chassis = options.brand.chassis_color || '#8f9aa6';
  const dark = shade(chassis, 0.88);
  const rgb = hex_to_rgb(dark);
  const is_light = (rgb.r + rgb.g + rgb.b) / 3 > 140;
  const label_text = options.label_text || 'DEMO UNIT';
  return canvas_texture(1024, 576, (ctx, width, height) => {
    ctx.fillStyle = dark;
    ctx.fillRect(0, 0, width, height);
    for (let i = 0; i < 3600; i += 1) {
      const value = utils.rnd(0.75, 1.15);
      const line_color =
        'rgba(' +
        Math.round(rgb.r * value) +
        ',' +
        Math.round(rgb.g * value) +
        ',' +
        Math.round(rgb.b * value) +
        ',' +
        utils.rnd(0.1, 0.35).toFixed(2) +
        ')';
      ctx.strokeStyle = line_color;
      ctx.lineWidth = utils.rnd(0.5, 1.5);
      const y = Math.random() * height;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y + utils.rnd(-1.5, 1.5));
      ctx.stroke();
    }

    const draw_hole = (x, y, radius) => {
      const gradient = ctx.createRadialGradient(
        x - radius * 0.3,
        y - radius * 0.3,
        radius * 0.1,
        x,
        y,
        radius
      );
      gradient.addColorStop(0, 'rgba(6,8,11,.95)');
      gradient.addColorStop(0.72, 'rgba(10,13,17,.98)');
      gradient.addColorStop(1, 'rgba(14,18,23,.9)');
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, 7);
      ctx.fill();
      ctx.strokeStyle = 'rgba(150,165,182,.3)';
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 1.15);
      ctx.stroke();
    };
    for (let y = 34; y < height - 30; y += 25) {
      for (let x = 430; x < width - 30; x += 25) {
        draw_hole(x, y, 6.2);
      }
    }
    for (let y = 48; y < height - 30; y += 25) {
      for (let x = 444; x < width - 30; x += 25) {
        draw_hole(x, y, 6.2);
      }
    }

    ctx.fillStyle = is_light ? 'rgba(60,72,86,.62)' : 'rgba(200,212,226,.5)';
    ctx.font = '13px sans-serif';
    ctx.fillText('VENTILATION  ·  DO NOT BLOCK', 40, 34);
    ctx.fillStyle = is_light ? 'rgba(60,72,86,.45)' : 'rgba(200,212,226,.35)';
    ctx.font = '11px sans-serif';
    ctx.fillText(options.model_line || '', 40, 56);

    const label_x = 54;
    const label_y = height - 215;
    ctx.fillStyle = '#e9edf2';
    ctx.beginPath();
    ctx.moveTo(label_x + 8, label_y);
    ctx.arcTo(label_x + 336, label_y, label_x + 336, label_y + 152, 8);
    ctx.arcTo(label_x + 336, label_y + 152, label_x, label_y + 152, 8);
    ctx.arcTo(label_x, label_y + 152, label_x, label_y, 8);
    ctx.arcTo(label_x, label_y, label_x + 336, label_y, 8);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = options.brand.logo_color || '#1d2733';
    ctx.textBaseline = 'top';
    ctx.font = 'bold 27px sans-serif';
    ctx.fillText(options.brand.logo_text || '', label_x + 20, label_y + 16);
    ctx.fillStyle = '#3c6ea5';
    ctx.font = 'bold 19px sans-serif';
    ctx.fillText(options.model_line || '', label_x + 20, label_y + 52);
    ctx.fillStyle = '#5b6878';
    ctx.font = '12.5px sans-serif';
    ctx.fillText(options.sub_line || '', label_x + 20, label_y + 84);
    ctx.fillText(
      'SN: ' + (options.serial || '') + '   AC 100-240V 50/60Hz',
      label_x + 20,
      label_y + 104
    );
    ctx.fillText('MAC: ' + (options.mac || ''), label_x + 20, label_y + 124);
    ctx.fillStyle = '#1d2733';
    for (let i = 0; i < 52; i += 1) {
      const bar_width = Math.random() < 0.5 ? 1 : 3;
      ctx.fillRect(label_x + 230 + i * 2, label_y + 18, bar_width, 34);
    }
    ctx.fillStyle = 'rgba(255,255,255,.12)';
    ctx.font = 'bold 62px sans-serif';
    ctx.save();
    ctx.translate(300, 190);
    ctx.rotate(-0.12);
    ctx.textAlign = 'center';
    ctx.fillText(label_text, 0, 0);
    ctx.restore();
  });
}

/**
 * 侧面散热格栅贴图。
 *
 * @param {string} chassis_color 机箱颜色。
 * @returns {object} 贴图。
 */
function make_side(chassis_color) {
  const dark = shade(chassis_color, 0.34);
  return canvas_texture(512, 140, (ctx, width, height) => {
    ctx.fillStyle = dark;
    ctx.fillRect(0, 0, width, height);
    for (let i = 0; i < 1600; i += 1) {
      const value = Math.round(utils.rnd(40, 70));
      ctx.strokeStyle = 'rgba(' + value + ',' + (value + 4) + ',' + (value + 9) + ',.3)';
      ctx.lineWidth = utils.rnd(0.5, 1.5);
      const y = Math.random() * height;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }
    for (let i = 0; i < 7; i += 1) {
      const x = 70 + i * 58;
      for (let j = 0; j < 16; j += 1) {
        const y = 18 + j * 6.6;
        ctx.fillStyle = 'rgba(6,8,11,.9)';
        ctx.fillRect(x, y, 34, 3.4);
        ctx.fillStyle = 'rgba(150,165,182,.2)';
        ctx.fillRect(x, y + 3.4, 34, 1);
      }
    }
  });
}

/**
 * 背面贴图：风扇格栅 + 电源插座 + 接地螺柱。
 *
 * @param {string} chassis_color 机箱颜色。
 * @param {boolean} is_rack 是否机架式。
 * @returns {object} 贴图。
 */
function make_back(chassis_color, is_rack) {
  const dark = shade(chassis_color, 0.28);
  const fan_count = is_rack ? 3 : 1;
  return canvas_texture(1024, 300, (ctx, width, height) => {
    ctx.fillStyle = dark;
    ctx.fillRect(0, 0, width, height);
    for (let i = 0; i < 2200; i += 1) {
      const value = Math.round(utils.rnd(34, 60));
      ctx.strokeStyle = 'rgba(' + value + ',' + (value + 4) + ',' + (value + 9) + ',.3)';
      ctx.lineWidth = utils.rnd(0.5, 1.5);
      const y = Math.random() * height;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }
    const draw_fan = (center_x, center_y) => {
      ctx.strokeStyle = 'rgba(8,10,14,.9)';
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.arc(center_x, center_y, 64, 0, 7);
      ctx.stroke();
      ctx.lineWidth = 4;
      for (let radius = 16; radius < 60; radius += 9) {
        ctx.beginPath();
        ctx.arc(center_x, center_y, radius, 0, 7);
        ctx.stroke();
      }
      ctx.lineWidth = 3.4;
      for (let a = 0; a < 8; a += 1) {
        const angle = (a / 8) * 6.283;
        ctx.beginPath();
        ctx.moveTo(center_x + Math.cos(angle) * 12, center_y + Math.sin(angle) * 12);
        ctx.lineTo(center_x + Math.cos(angle) * 60, center_y + Math.sin(angle) * 60);
        ctx.stroke();
      }
      ctx.fillStyle = '#14171c';
      ctx.beginPath();
      ctx.arc(center_x, center_y, 13, 0, 7);
      ctx.fill();
    };
    if (fan_count === 3) {
      draw_fan(210, 150);
      draw_fan(430, 150);
      draw_fan(650, 150);
    } else {
      draw_fan(210, 150);
    }
    ctx.fillStyle = '#171a1f';
    ctx.fillRect(800, 80, 170, 140);
    ctx.strokeStyle = 'rgba(150,165,182,.4)';
    ctx.lineWidth = 2;
    ctx.strokeRect(800, 80, 170, 140);
    ctx.fillStyle = '#2b3138';
    ctx.fillRect(818, 100, 60, 44);
    ctx.fillRect(894, 100, 60, 44);
    ctx.fillStyle = '#0c0e12';
    ctx.beginPath();
    ctx.arc(848, 168, 15, 0, 7);
    ctx.fill();
    ctx.fillRect(886, 156, 26, 26);
    ctx.fillStyle = 'rgba(200,212,226,.55)';
    ctx.font = '13px sans-serif';
    ctx.fillText('AC 100-240V', 812, 234);
    ctx.fillStyle = 'rgba(200,212,226,.4)';
    ctx.font = '11px sans-serif';
    ctx.fillText('2.5A MAX 50/60Hz', 812, 254);
    ctx.fillStyle = '#8d99a6';
    ctx.beginPath();
    ctx.arc(770, 150, 11, 0, 7);
    ctx.fill();
    ctx.fillStyle = '#4a545f';
    ctx.beginPath();
    ctx.arc(770, 150, 5, 0, 7);
    ctx.fill();
  });
}

/**
 * 前面板丝印贴图：品牌、型号、端口编号、LED 标签、Console/USB 标识。
 *
 * @param {object} options 参数。
 * @param {object} options.layout 面板布局。
 * @param {object} options.brand 品牌参数。
 * @param {object} options.manifest 设备 Manifest。
 * @param {boolean} options.poe 是否为 PoE 机型。
 * @returns {object} 贴图。
 */
function make_front(options) {
  const layout = options.layout;
  const brand = options.brand;
  const manifest = options.manifest;
  const faceplate = brand.faceplate_color || '#1f242b';
  const silkscreen = (manifest.visual && manifest.visual.silkscreen) || {};
  const leds = (manifest.visual && manifest.visual.leds) || {};
  const front_panel = (manifest.visual && manifest.visual.front_panel) || {};
  const panel_width = 2048;
  const panel_height = Math.max(140, Math.round((2048 * layout.height) / layout.width));

  return canvas_texture(panel_width, panel_height, (ctx, width, height) => {
    ctx.fillStyle = faceplate;
    ctx.fillRect(0, 0, width, height);
    for (let i = 0; i < 2600; i += 1) {
      const value = Math.round(utils.rnd(30, 56));
      ctx.strokeStyle = 'rgba(' + value + ',' + (value + 4) + ',' + (value + 8) + ',.28)';
      ctx.lineWidth = utils.rnd(0.5, 1.4);
      const y = Math.random() * height;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }

    const to_x = (x) => layout.to_panel_x(x) * width;
    const to_y = (y) => layout.to_panel_y(y) * height;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    /* 端口编号与分组框。 */
    for (const group of layout.groups) {
      const group_kind = group.group.kind;
      ctx.strokeStyle = 'rgba(255,255,255,.12)';
      ctx.lineWidth = 2;
      const box_top = to_y(group.rows[0].y + layout.row_pitch * 0.5 + 0.09);
      const box_height =
        to_y(group.rows[group.rows.length - 1].y - layout.row_pitch * 0.5 - 0.09) - box_top;
      ctx.strokeRect(
        to_x(group.x_start + layout.pitch * 0.12),
        box_top,
        ((group.width - layout.pitch * 0.24) / layout.width) * width,
        box_height
      );
      ctx.fillStyle = group_kind === 'sfp' ? '#c8b06a' : '#c3ccd8';
      ctx.font = 'bold ' + Math.round(height * 0.075) + 'px sans-serif';
      for (const row of group.rows) {
        for (const entry of row.ports) {
          const label_y = entry.y < 0 ? to_y(entry.y - 0.3) : to_y(entry.y + 0.3);
          ctx.fillText(String(entry.port.index), to_x(entry.x), label_y);
        }
      }
    }

    /* 品牌与型号丝印。 */
    ctx.textAlign = 'left';
    ctx.fillStyle = brand.logo_color || '#c3ccd8';
    ctx.font = 'bold ' + Math.round(height * 0.14) + 'px sans-serif';
    ctx.fillText(silkscreen.brand_line || brand.logo_text || '', width * 0.012, height * 0.22);
    ctx.fillStyle = 'rgba(200,212,226,.55)';
    ctx.font = Math.round(height * 0.085) + 'px sans-serif';
    ctx.fillText(silkscreen.sub_line || '', width * 0.012, height * 0.52);

    /* 左侧指示灯与按键标签。 */
    ctx.textAlign = 'center';
    ctx.fillStyle = '#93a0b0';
    ctx.font = 'bold ' + Math.round(height * 0.09) + 'px sans-serif';
    ctx.fillText('PWR', to_x(-layout.width / 2 + 0.3), to_y(layout.height * 0.2));
    ctx.font = Math.round(height * 0.075) + 'px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(
      leds.system_label || 'SYS',
      to_x(-layout.width / 2 + 0.62),
      to_y(layout.height * 0.26)
    );
    ctx.fillText(
      leds.power_label || 'PWR',
      to_x(-layout.width / 2 + 0.62),
      to_y(-layout.height * 0.05)
    );
    if (front_panel.usb) {
      ctx.fillText('USB', to_x(-layout.width / 2 + 0.62), to_y(-layout.height * 0.3));
    }
    if (front_panel.console) {
      ctx.textAlign = 'center';
      ctx.fillText('CONSOLE', to_x(-layout.width / 2 + 0.42), to_y(-layout.height * 0.42));
    }
    if (options.poe) {
      ctx.fillStyle = '#ffb648';
      ctx.textAlign = 'right';
      ctx.fillText('PoE+', width - 20, height * 0.3);
    }
    ctx.fillStyle = 'rgba(255,255,255,.04)';
    ctx.fillRect(0, 0, width, height * 0.42);
  });
}

export const SceneTextures = {
  canvas_texture: canvas_texture,
  gray_texture: gray_texture,
  hex_to_rgb: hex_to_rgb,
  shade: shade,
  make_brushed: make_brushed,
  make_brushed_rough: make_brushed_rough,
  make_pcb: make_pcb,
  make_top: make_top,
  make_side: make_side,
  make_back: make_back,
  make_front: make_front
};
