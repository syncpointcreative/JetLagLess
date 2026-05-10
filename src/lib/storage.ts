import { Platform } from 'react-native';

const memory = new Map<string, string>();

const webOk =
  Platform.OS === 'web' &&
  typeof window !== 'undefined' &&
  typeof window.localStorage !== 'undefined';

export const storage = {
  get(key: string): string | null {
    if (webOk) {
      try {
        return window.localStorage.getItem(key);
      } catch {
        return memory.get(key) ?? null;
      }
    }
    return memory.get(key) ?? null;
  },
  set(key: string, value: string): void {
    if (webOk) {
      try {
        window.localStorage.setItem(key, value);
        return;
      } catch {
        memory.set(key, value);
        return;
      }
    }
    memory.set(key, value);
  },
  remove(key: string): void {
    if (webOk) {
      try {
        window.localStorage.removeItem(key);
        return;
      } catch {
        memory.delete(key);
        return;
      }
    }
    memory.delete(key);
  },
};

export function readJson<T>(key: string): T | undefined {
  const raw = storage.get(key);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

export function writeJson<T>(key: string, value: T): void {
  storage.set(key, JSON.stringify(value));
}
