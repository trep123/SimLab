/**
 * @File : scene/flow.ts
 * @Time : 2026-10-04 14:00
 * @Author : Cetrp
 * @Description : 转发路径可视化：端口到交换芯片的走线（铜箔）与数据包粒子，用于透视 / 爆炸视图教学。
 */
import * as THREE from 'three';

import { DEVICE_STATE } from '../core/constants';

/** 最大并发粒子数。 */
const MAX_PARTICLES = 260;

/** 速率到粒子颜色。 */
const SPEED_COLORS = {
  '10G': 0x37e0c9,
  '1000M': 0x2bff9a,
  '100M': 0xffb648,
  '10M': 0x4fa8ff
};

/**
 * 转发路径图层。
 */
class FlowLayer {
  /** 允许渲染层动态挂载内部状态。 */
  [key: string]: any;

  /**
   * @param {object} options 参数。
   * @param {object} options.device_object 设备三维对象。
   * @param {object} options.runtime_device 设备运行时。
   */
  constructor(options) {
    this.device_object = options.device_object;
    this.runtime_device = options.runtime_device;
    this.group = new THREE.Group();
    this.group.visible = false;
    this.particles = [];
    this._timer = 0;
    this._build();
  }

  /**
   * 构建走线与粒子网格。
   *
   * @returns {void}
   * @private
   */
  _build() {
    const layout = this.device_object.layout;
    const chip_position = new THREE.Vector3(layout.width * 0.1, -layout.height * 0.24, -0.2);
    this.curves = [];
    const positions = [];
    const colors = [];
    const copper = new THREE.Color(0x2f6f5a);
    const gold = new THREE.Color(0xd8c46a);

    for (const entry of layout.ports) {
      const is_optical = entry.kind === 'sfp' || entry.kind === 'sfp_plus';
      const direction = entry.y > 0 ? 1 : -1;
      const curve = new THREE.CatmullRomCurve3([
        new THREE.Vector3(entry.x, entry.y, layout.front_z - 0.08),
        new THREE.Vector3(entry.x, entry.y - 0.2, layout.depth * 0.42),
        new THREE.Vector3(entry.x * 0.72, -layout.height * 0.28, direction * 0.55),
        new THREE.Vector3(
          chip_position.x + (entry.x < chip_position.x ? -0.7 : 0.7),
          -layout.height * 0.26,
          chip_position.z + direction * 0.4
        ),
        chip_position
      ]);
      this.curves.push({ curve: curve, definition: entry.port });
      const points = curve.getPoints(24);
      const line_color = is_optical ? gold : copper;
      for (let i = 0; i < points.length - 1; i += 1) {
        positions.push(
          points[i].x,
          points[i].y,
          points[i].z,
          points[i + 1].x,
          points[i + 1].y,
          points[i + 1].z
        );
        colors.push(
          line_color.r,
          line_color.g,
          line_color.b,
          line_color.r,
          line_color.g,
          line_color.b
        );
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    this.group.add(
      new THREE.LineSegments(
        geometry,
        new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.5 })
      )
    );

    this.particle_mesh = new THREE.InstancedMesh(
      new THREE.SphereGeometry(0.05, 8, 6),
      new THREE.MeshBasicMaterial({
        transparent: true,
        opacity: 0.95,
        blending: THREE.AdditiveBlending,
        depthWrite: false
      }),
      MAX_PARTICLES
    );
    this.particle_mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const white = new THREE.Color(0xffffff);
    for (let i = 0; i < MAX_PARTICLES; i += 1) {
      this.particle_mesh.setColorAt(i, white);
    }
    this.particle_mesh.count = 0;
    this.group.add(this.particle_mesh);
    this._matrix = new THREE.Matrix4();
    this._quaternion = new THREE.Quaternion();
    this._scale = new THREE.Vector3(1, 1, 1);
    this._vector = new THREE.Vector3();
    this._color = new THREE.Color();
  }

  /**
   * 重建活跃粒子集合。
   *
   * @returns {void}
   * @private
   */
  _sync_particles() {
    const device = this.runtime_device;
    if (!device) {
      this.particle_mesh.count = 0;
      return;
    }
    const active = this.curves.filter((item) => {
      const port_state = device.ports.find(
        (port) => port.short_name === item.definition.short_name
      );
      return port_state && port_state.link_up && port_state.admin_up;
    });
    if (active.length === 0) {
      this.particles.length = 0;
      this.particle_mesh.count = 0;
      return;
    }
    const wanted = Math.min(MAX_PARTICLES, active.length * 5);
    this.particles.length = 0;
    for (let i = 0; i < wanted; i += 1) {
      const source = active[i % active.length];
      let target = active[Math.floor(Math.random() * active.length)];
      if (target === source && active.length > 1) {
        target = active[(active.indexOf(source) + 1) % active.length];
      }
      const port_state = device.ports.find(
        (port) => port.short_name === source.definition.short_name
      );
      this.particles.push({
        source: source,
        target: target,
        progress: Math.random(),
        speed: port_state ? port_state.speed : '1000M'
      });
    }
    this.particle_mesh.count = this.particles.length;
  }

  /**
   * 推进粒子动画。
   *
   * @param {number} delta_seconds 时间增量。
   * @returns {void}
   */
  update(delta_seconds) {
    if (!this.group.visible || !this.runtime_device) {
      return;
    }
    this._timer += delta_seconds;
    if (this._timer > 0.6 || this.particles.length === 0) {
      this._timer = 0;
      this._sync_particles();
    }
    const running = this.runtime_device.power_state === DEVICE_STATE.RUNNING;
    for (let i = 0; i < this.particles.length; i += 1) {
      const particle = this.particles[i];
      const rate = particle.speed === '10G' ? 0.85 : particle.speed === '1000M' ? 0.55 : 0.32;
      particle.progress += delta_seconds * rate * (running ? 1 : 0);
      if (particle.progress > 1) {
        particle.progress -= 1;
      }
      if (particle.progress < 0.5) {
        particle.source.curve.getPoint(particle.progress * 2, this._vector);
      } else {
        particle.target.curve.getPoint(1 - (particle.progress - 0.5) * 2, this._vector);
      }
      const scale = particle.speed === '10G' ? 1.25 : particle.speed === '1000M' ? 1.0 : 0.72;
      this._matrix.compose(this._vector, this._quaternion, this._scale.set(scale, scale, scale));
      this.particle_mesh.setMatrixAt(i, this._matrix);
      this.particle_mesh.setColorAt(
        i,
        this._color.setHex(SPEED_COLORS[particle.speed] || 0x2bff9a)
      );
    }
    this.particle_mesh.instanceMatrix.needsUpdate = true;
    if (this.particle_mesh.instanceColor) {
      this.particle_mesh.instanceColor.needsUpdate = true;
    }
  }

  /**
   * 显示 / 隐藏。
   *
   * @param {boolean} visible 是否可见。
   * @returns {void}
   */
  set_visible(visible) {
    this.group.visible = visible;
  }

  /**
   * 释放资源。
   *
   * @returns {void}
   */
  dispose() {
    this.group.traverse((object) => {
      if (object.geometry) {
        object.geometry.dispose();
      }
    });
  }
}

export { FlowLayer };
