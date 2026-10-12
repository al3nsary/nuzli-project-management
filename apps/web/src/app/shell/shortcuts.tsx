import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Modal } from '@mantine/core';
import { shortcutTargets, type NavNode } from '../nav';
import { t } from '../../i18n';
import { useShellStore } from './store';

/** Typing in a field (or a rich editor) turns every shortcut off (rule 8). */
export function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName.toLowerCase();
  if (tag === 'textarea' || tag === 'select') return true;
  if (tag === 'input') {
    const type = (el as HTMLInputElement).type;
    return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file'].includes(type);
  }
  return el.getAttribute('role') === 'textbox' || el.getAttribute('role') === 'combobox';
}

/**
 * Ctrl+K palette, Ctrl+B fold, `?` sheet and `g` then a letter. Keys are read by physical code
 * (`KeyG`, `KeyP`), so they work the same on the Arabic keyboard layout.
 */
export function useShortcuts(tree: NavNode[], opts: { mobile: boolean }) {
  const navigate = useNavigate();
  const pendingG = useRef<number | null>(null);
  const treeRef = useRef(tree);
  treeRef.current = tree;
  const mobileRef = useRef(opts.mobile);
  mobileRef.current = opts.mobile;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isTyping(e.target)) return;
      const s = useShellStore.getState();
      const mod = e.ctrlKey || e.metaKey;
      if (mod && !e.shiftKey && !e.altKey && e.code === 'KeyK') {
        e.preventDefault();
        s.setPalette(!s.palette);
        return;
      }
      if (mod && !e.shiftKey && !e.altKey && e.code === 'KeyB') {
        e.preventDefault();
        if (mobileRef.current) s.setDrawer(!s.drawer);
        else s.toggleMini();
        return;
      }
      if (mod || e.altKey) return;
      // Another dialog owns the keyboard.
      if (s.palette || s.sheet || document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      if (e.key === '?' || e.key === '؟' || (e.code === 'Slash' && e.shiftKey)) {
        e.preventDefault();
        s.setSheet(true);
        return;
      }
      if (pendingG.current !== null) {
        window.clearTimeout(pendingG.current);
        pendingG.current = null;
        const letter = /^Key([A-Z])$/.exec(e.code)?.[1]?.toLowerCase();
        const target = letter ? shortcutTargets(treeRef.current).get(letter) : undefined;
        if (target?.path) {
          e.preventDefault();
          navigate(target.path);
        }
        return;
      }
      if (e.code === 'KeyG' && !e.shiftKey) {
        pendingG.current = window.setTimeout(() => {
          pendingG.current = null;
        }, 1200);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (pendingG.current !== null) window.clearTimeout(pendingG.current);
    };
  }, [navigate]);
}

function Keys({ keys }: { keys: string[] }) {
  return (
    <span className="nz-keys">
      {keys.map((k, i) => (
        <kbd key={i} className="nz-kbd">
          {k}
        </kbd>
      ))}
    </span>
  );
}

/** `?` — every shortcut this user can use. */
export function ShortcutSheet({ tree }: { tree: NavNode[] }) {
  const opened = useShellStore((s) => s.sheet);
  const setSheet = useShellStore((s) => s.setSheet);
  const go = [...shortcutTargets(tree).entries()];
  return (
    <Modal opened={opened} onClose={() => setSheet(false)} title={t('shortcuts.title')} size={520}>
      <div className="nz-sheet">
        <section>
          <h3>{t('shortcuts.general')}</h3>
          <dl>
            <div>
              <dt>{t('shortcuts.palette')}</dt>
              <dd>
                <Keys keys={[t('kbd.ctrl'), 'K']} />
              </dd>
            </div>
            <div>
              <dt>{t('shortcuts.fold')}</dt>
              <dd>
                <Keys keys={[t('kbd.ctrl'), 'B']} />
              </dd>
            </div>
            <div>
              <dt>{t('shortcuts.sheet')}</dt>
              <dd>
                <Keys keys={['?']} />
              </dd>
            </div>
            <div>
              <dt>{t('shortcuts.close')}</dt>
              <dd>
                <Keys keys={[t('kbd.esc')]} />
              </dd>
            </div>
          </dl>
        </section>
        {go.length ? (
          <section>
            <h3>{t('shortcuts.goTo')}</h3>
            <dl>
              {go.map(([k, n]) => (
                <div key={k}>
                  <dt>{t(n.title ?? n.label)}</dt>
                  <dd>
                    <Keys keys={['G', k.toUpperCase()]} />
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ) : null}
        <p className="nz-sheet-note">{t('shortcuts.note')}</p>
      </div>
    </Modal>
  );
}
