import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { readStored, writeStored } from './storage';

export type ThemePref = 'system' | 'light' | 'dark';
type Listener = () => void;

const listeners = new Set<Listener>();
let pref: ThemePref = parsePref(readStored('theme'));

function parsePref(v: string | null): ThemePref {
  return v === 'light' || v === 'dark' ? v : 'system';
}

function systemDark(): boolean {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    return false;
  }
}

export function resolvedTheme(p: ThemePref = pref): 'light' | 'dark' {
  return p === 'system' ? (systemDark() ? 'dark' : 'light') : p;
}

function apply(): void {
  document.documentElement.dataset.theme = resolvedTheme();
}

export function setThemePref(p: ThemePref): void {
  pref = p;
  writeStored('theme', p === 'system' ? null : p);
  apply();
  for (const l of listeners) l();
}

function subscribe(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Theme preference (persisted) + the resolved light/dark value; follows the OS when 'system'. */
export function useTheme(): { pref: ThemePref; theme: 'light' | 'dark'; setPref: (p: ThemePref) => void; toggle: () => void } {
  const p = useSyncExternalStore(subscribe, () => pref);
  const theme = useSyncExternalStore(subscribe, () => resolvedTheme(pref));
  useEffect(() => {
    let mq: MediaQueryList | null = null;
    try {
      mq = window.matchMedia('(prefers-color-scheme: dark)');
    } catch {
      return;
    }
    const onChange = () => {
      if (pref === 'system') {
        apply();
        for (const l of listeners) l();
      }
    };
    mq.addEventListener('change', onChange);
    return () => mq?.removeEventListener('change', onChange);
  }, []);
  const toggle = useCallback(() => setThemePref(resolvedTheme() === 'dark' ? 'light' : 'dark'), []);
  return { pref: p, theme, setPref: setThemePref, toggle };
}
