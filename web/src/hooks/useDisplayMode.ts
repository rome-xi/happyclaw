import { useSyncExternalStore, useCallback } from 'react';

export type DisplayMode = 'chat' | 'compact';

const STORAGE_KEY = 'happyclaw-display-mode';

// Simple external store backed by localStorage
let currentMode: DisplayMode = (localStorage.getItem(STORAGE_KEY) as DisplayMode) || 'chat';
const listeners = new Set<() => void>();

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function getSnapshot(): DisplayMode {
  return currentMode;
}

function setMode(mode: DisplayMode) {
  currentMode = mode;
  localStorage.setItem(STORAGE_KEY, mode);
  listeners.forEach((cb) => cb());
}

export function useDisplayMode() {
  const mode = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const toggle = useCallback(() => {
    setMode(mode === 'chat' ? 'compact' : 'chat');
  }, [mode]);
  return { mode, toggle, setMode };
}
