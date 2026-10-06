/**
 * @File : web/src/ui/ContextMenu.tsx
 * @Time : 2026-10-06 20:20
 * @Author : Cetrp
 * @Description : 右键菜单：按命中对象（设备 / 端口 / 线缆 / 空白）给出对应操作，
 *               参数类设置走菜单，开关机/连线等物理操作仍由鼠标点击与拖拽完成。
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import type { JSX } from 'react';

import { use_store } from '../core/store';
import { DEVICE_STATE } from '../core/constants';
import { CABLE_CATALOG } from '../cables/catalog';
import { runtime_capability } from '../core/runtime_capability';

/** 菜单项。 */
interface MenuItem {
  /** 文本。 */
  label: string;
  /** 动作。 */
  action?: () => void;
  /** 子菜单。 */
  children?: MenuItem[];
  /** 是否危险操作（红色）。 */
  danger?: boolean;
  /** 是否禁用。 */
  disabled?: boolean;
  /** 分隔线。 */
  separator?: boolean;
}

/**
 * 右键菜单组件。
 *
 * @returns {JSX.Element | null} 组件。
 */
export function ContextMenu(): JSX.Element | null {
  const menu = use_store((state) => state.context_menu);
  const runtime = use_store((state) => state.runtime);
  const [open_submenu, set_open_submenu] = useState<string | null>(null);
  /* 子菜单关闭延时：鼠标从父项移向子菜单途中不立即收起。 */
  const close_timer = useRef<number | null>(null);
  const [renaming, set_renaming] = useState(false);
  const [rename_value, set_rename_value] = useState('');

  /* 点击任意处或按 Esc 关闭菜单。 */
  useEffect(() => {
    if (!menu) {
      set_open_submenu(null);
      set_renaming(false);
      return;
    }
    const close = (): void => use_store.getState().close_context_menu();
    const on_key = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        close();
      }
    };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', on_key);

    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', on_key);
    };
  }, [menu]);

  /**
   * 取消待执行的子菜单关闭。
   *
   * @returns {void}
   */
  const cancel_close = (): void => {
    if (close_timer.current !== null) {
      window.clearTimeout(close_timer.current);
      close_timer.current = null;
    }
  };

  /**
   * 延时关闭子菜单（指针重新进入父项或子菜单时取消）。
   *
   * @returns {void}
   */
  const schedule_close = (): void => {
    cancel_close();
    close_timer.current = window.setTimeout(() => {
      set_open_submenu(null);
      close_timer.current = null;
    }, 260);
  };

  useEffect(() => {
    return () => cancel_close();
  }, []);

  const items = useMemo<MenuItem[]>(() => {
    if (!menu) {
      return [];
    }
    const state = use_store.getState();
    if (menu.kind === 'device' && menu.device_id) {
      const device = runtime ? runtime.get_device(menu.device_id) : null;
      if (!device) {
        return [];
      }
      const is_running = device.power_state === DEVICE_STATE.RUNNING;
      const capability = runtime_capability(device.manifest);
      const ports = device.ports.slice(0, 12);
      return [
        {
          label: is_running ? '关机（也可点击机身电源键）' : '开机（也可点击机身电源键）',
          action: () => void state.toggle_power(device.device_id)
        },
        {
          label: '重启设备（软重启）',
          action: () => {
            void (async () => {
              await state.toggle_power(device.device_id);
              window.setTimeout(
                () => void use_store.getState().toggle_power(device.device_id),
                600
              );
            })();
          }
        },
        { label: '保存配置', action: () => void state.save_config(device.device_id) },
        { label: '', separator: true },
        {
          label: '重命名…',
          action: () => {
            set_rename_value(device.hostname);
            set_renaming(true);
          }
        },
        { label: '', separator: true },
        {
          label:
            capability.console_kind === 'real'
              ? '打开 CLI 调试（真实：' + capability.engine_label + '）'
              : '打开 CLI 调试（模拟）',
          action: () => {
            state.select_device(device.device_id);
            state.open_console(device.device_id);
          }
        },
        {
          label:
            '运行时：' +
            capability.engine_label +
            (capability.image ? '（' + capability.image + '）' : ''),
          disabled: true
        },
        ...(capability.snapshot
          ? [
              {
                label: '创建冷快照（后端预留接口）',
                action: () => state.request_snapshot(device.device_id)
              }
            ]
          : []),
        { label: '', separator: true },
        {
          label: '编辑设备模板（设备工坊）',
          action: () => void state.open_workshop(device.model_id)
        },
        { label: '复制设备', action: () => void state.duplicate_device(device.device_id) },
        { label: '', separator: true },
        {
          label: '选择端口连线…',
          children: ports.map((port) => ({
            label: port.short_name + (port.link_up ? '（UP）' : ''),
            action: () => state.start_link({ device_id: device.device_id, port: port.short_name })
          }))
        },
        {
          label: '注入故障',
          children: [
            {
              label: '高温告警',
              action: () => void state.inject_fault(device.device_id, null, 'high_temp')
            },
            {
              label: '电源故障',
              action: () => void state.inject_fault(device.device_id, null, 'power_fail')
            }
          ]
        },
        { label: '', separator: true },
        {
          label: '删除设备',
          danger: true,
          action: () => void state.delete_device(device.device_id)
        }
      ];
    }
    if (menu.kind === 'port' && menu.device_id && menu.port) {
      const device = runtime ? runtime.get_device(menu.device_id) : null;
      const port = device ? device.find_port(menu.port) : null;
      if (!device || !port) {
        return [];
      }
      return [
        {
          label: '端口 ' + port.name + '（' + (port.link_up ? 'UP' : 'DOWN') + '）',
          disabled: true
        },
        { label: '', separator: true },
        port.plugged
          ? {
              label: '拔出线缆（也可直接点击接口）',
              action: () => void state.disconnect_port(device.device_id, port.short_name)
            }
          : {
              label: '从此端口开始连线…',
              action: () => state.start_link({ device_id: device.device_id, port: port.short_name })
            },
        {
          label: port.admin_up ? 'shutdown（管理关闭）' : 'undo shutdown（启用）',
          action: () =>
            void state.configure_port(device.device_id, port.short_name, {
              admin_up: !port.admin_up
            })
        },
        {
          label: 'VLAN 设置',
          children: [1, 10, 20, 30, 100].map((vlan) => ({
            label: 'VLAN ' + vlan + (port.vlan === vlan ? ' ✓' : ''),
            action: () =>
              void state.configure_port(device.device_id, port.short_name, { vlan: vlan })
          }))
        },
        {
          label: '速率 / 双工',
          children: [
            {
              label: '自协商',
              action: () =>
                void state.configure_port(device.device_id, port.short_name, { speed: 'auto' })
            },
            {
              label: '1000M 全双工',
              action: () =>
                void state.configure_port(device.device_id, port.short_name, { speed: '1000M' })
            },
            {
              label: '100M 全双工',
              action: () =>
                void state.configure_port(device.device_id, port.short_name, { speed: '100M' })
            }
          ]
        },
        {
          label: 'PoE',
          children: [
            {
              label: '开启 PoE',
              action: () =>
                void state.configure_port(device.device_id, port.short_name, { poe: true })
            },
            {
              label: '关闭 PoE',
              action: () =>
                void state.configure_port(device.device_id, port.short_name, { poe: false })
            }
          ]
        },
        {
          label: '注入端口故障',
          children: [
            {
              label: 'CRC 错误',
              action: () => void state.inject_fault(device.device_id, port.short_name, 'crc')
            },
            {
              label: '断纤',
              action: () =>
                void state.inject_fault(device.device_id, port.short_name, 'cable_broken')
            },
            {
              label: '光衰（光口）',
              action: () =>
                void state.inject_fault(device.device_id, port.short_name, 'fiber_degrade')
            }
          ]
        },
        { label: '', separator: true },
        {
          label:
            runtime_capability(device.manifest).console_kind === 'real'
              ? '打开 CLI 调试（真实虚拟机）'
              : '打开 CLI 调试（模拟）',
          action: () => {
            state.select_port(device.device_id, port.short_name);
            state.open_console(device.device_id);
          }
        }
      ];
    }
    if (menu.kind === 'cable' && menu.cable_id) {
      const cable = state.cables.find((item) => item.cable_id === menu.cable_id);
      const optical = state.optical?.links?.find(
        (link) =>
          link.onu_id === cable?.source.device_id || link.onu_id === cable?.target?.device_id
      );
      const items_list: MenuItem[] = [
        {
          label: cable
            ? '线缆 ' + cable.cable_id + '（' + (cable.state === 'UP' ? 'UP' : 'DOWN') + '）'
            : '线缆',
          disabled: true
        },
        { label: '', separator: true },
        {
          label: '拔出线缆',
          danger: true,
          action: () => {
            if (cable?.target) {
              void state.disconnect_port(cable.source.device_id, cable.source.port);
            } else {
              void state.disconnect_port(cable!.source.device_id, cable!.source.port);
            }
          }
        },
        {
          label: '整理走线（重置路径）',
          action: () =>
            window.dispatchEvent(
              new CustomEvent('simlab:cable-reset-route', { detail: { cable_id: menu.cable_id } })
            )
        },
        {
          label: '更换线缆类型',
          children: CABLE_CATALOG.map((kind) => ({
            label: kind.label,
            action: () =>
              window.dispatchEvent(
                new CustomEvent('simlab:cable-retype', {
                  detail: { cable_id: menu.cable_id, cable_kind: kind.cable_id }
                })
              )
          }))
        }
      ];
      if (optical) {
        items_list.push({ label: '', separator: true });
        items_list.push({
          label: '光链路：' + optical.state + ' / ' + optical.rx_power_dbm + ' dBm',
          disabled: true
        });
        items_list.push({
          label: optical.broken ? '恢复光纤' : '模拟断纤',
          action: () => void state.set_optical_fiber(optical.onu_id, { broken: !optical.broken })
        });
      }

      return items_list;
    }
    /* 空白菜单：新建 / 视图 / 显示开关。 */
    return [
      {
        label: '新建设备',
        children: (state.template_list ? state.template_list() : [])
          .slice(0, 12)
          .map((template) => ({
            label: template.display_name,
            action: () => void state.create_device(template.model_id)
          }))
      },
      { label: '打开设备工坊', action: () => void state.open_workshop(null) },
      { label: '', separator: true },
      {
        label: '视角',
        children: [
          { label: '正面', action: () => state.set_view('front') },
          { label: '45°', action: () => state.set_view('iso') },
          { label: '俯视', action: () => state.set_view('top') },
          { label: '全览', action: () => window.dispatchEvent(new CustomEvent('simlab:frame-all')) }
        ]
      },
      {
        label: '显示模式',
        children: [
          { label: '外观', action: () => state.set_display_mode('shell') },
          { label: '透视', action: () => state.set_display_mode('xray') },
          { label: '爆炸图', action: () => state.set_display_mode('explode') }
        ]
      },
      {
        label: state.flow_enabled ? '隐藏转发动画' : '显示转发动画',
        action: () => state.toggle_flow()
      }
    ];
  }, [menu, runtime]);

  if (!menu || items.length === 0) {
    return null;
  }

  /**
   * 渲染一组菜单项。
   *
   * @param {MenuItem[]} list 菜单项。
   * @param {string} prefix 子菜单键前缀。
   * @returns {JSX.Element[]} 元素列表。
   */
  const render_items = (list: MenuItem[], prefix: string): JSX.Element[] =>
    list.map((item, index) => {
      const key = prefix + '-' + index;
      if (item.separator) {
        return <div key={key} className="menu-separator" />;
      }
      if (item.children && item.children.length > 0) {
        const is_open = open_submenu === key;
        return (
          <div
            key={key}
            className={is_open ? 'menu-item has-children open' : 'menu-item has-children'}
            onPointerEnter={() => set_open_submenu(key)}
          >
            <span>{item.label}</span>
            <i>›</i>
            {is_open && <div className="submenu">{render_items(item.children, key + '-sub')}</div>}
          </div>
        );
      }

      return (
        <div
          key={key}
          className={
            'menu-item' + (item.danger ? ' danger' : '') + (item.disabled ? ' disabled' : '')
          }
          onPointerEnter={() => {
            cancel_close();
            set_open_submenu(null);
          }}
          onClick={(event) => {
            event.stopPropagation();
            if (item.disabled || !item.action) {
              return;
            }
            item.action();
            use_store.getState().close_context_menu();
          }}
        >
          {item.label}
        </div>
      );
    });

  return (
    <div
      className="context-menu"
      style={{
        left: Math.min(menu.x, window.innerWidth - 240),
        top: Math.min(menu.y, window.innerHeight - 320)
      }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {renaming && menu.device_id ? (
        <div className="menu-rename">
          <input
            autoFocus
            value={rename_value}
            onChange={(event) => set_rename_value(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                void use_store.getState().rename_device(menu.device_id!, rename_value);
                use_store.getState().close_context_menu();
              }
            }}
          />
          <button
            type="button"
            className="mini on"
            onClick={() => {
              void use_store.getState().rename_device(menu.device_id!, rename_value);
              use_store.getState().close_context_menu();
            }}
          >
            确定
          </button>
        </div>
      ) : (
        render_items(items, 'menu')
      )}
    </div>
  );
}
