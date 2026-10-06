/**
 * @File : web/src/ui/LabelEditor.tsx
 * @Time : 2026-10-07 19:20
 * @Author : Cetrp
 * @Description : 线缆标签编辑浮层：在三维平台里点击标签后弹出输入框，
 *               回车保存（写回清单）、Esc 取消；清空则恢复默认编号。
 */

import { useEffect, useRef } from 'react';

import type { JSX } from 'react';

import { use_store } from '../core/store';

/**
 * 标签编辑浮层。
 *
 * @returns {JSX.Element | null} 组件。
 */
export function LabelEditor(): JSX.Element | null {
  const editor = use_store((state) => state.label_editor);
  const save = use_store((state) => state.save_label_text);
  const close = use_store((state) => state.close_label_editor);
  const input_ref = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (editor && input_ref.current) {
      input_ref.current.focus();
      input_ref.current.select();
    }
  }, [editor]);

  if (!editor) {
    return null;
  }
  const side_label = editor.side === 'from' ? 'A 端' : 'B 端';

  return (
    <div className="label-editor" role="dialog" aria-label="编辑线缆标签">
      <div className="label-editor-head">
        {'线缆标签 · ' + side_label + '（' + editor.cable_id + '）'}
      </div>
      <input
        ref={input_ref}
        type="text"
        maxLength={12}
        value={editor.text}
        placeholder="如 CAB-12A"
        onChange={(event) => {
          use_store.setState({
            label_editor: { ...editor, text: event.target.value }
          });
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            save(editor.cable_id, editor.side, editor.text);
          } else if (event.key === 'Escape') {
            event.preventDefault();
            close();
          }
        }}
      />
      <div className="label-editor-actions">
        <button
          type="button"
          className="mini"
          onClick={() => save(editor.cable_id, editor.side, editor.text)}
        >
          保存
        </button>
        <button type="button" className="mini" onClick={() => close()}>
          取消
        </button>
        <button
          type="button"
          className="mini"
          title="恢复默认编号（A-01 / B-01）"
          onClick={() => save(editor.cable_id, editor.side, '')}
        >
          恢复默认
        </button>
      </div>
    </div>
  );
}
