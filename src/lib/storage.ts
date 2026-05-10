import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';

const memory = new Map<string, string>();

const webOk =
  Platform.OS === 'web' &&
  typeof window !== 'undefined' &&
  typeof window.localStorage !== 'undefined';

export async function getItem(key: string): Promise<string | null> {
  if (webOk) {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return memory.get(key) ?? null;
    }
  }
  if (Platform.OS !== 'web') {
    try {
      return await AsyncStorage.getItem(key);
    } catch {
      return memory.get(key) ?? null;
    }
  }
  return memory.get(key) ?? null;
}

export async function setItem(key: string, value: string): Promise<void> {
  if (webOk) {
    try {
      window.localStorage.setItem(key, value);
      return;
    } catch {
      memory.set(key, value);
      return;
    }
  }
  if (Platform.OS !== 'web') {
    try {
      await AsyncStorage.setItem(key, value);
      return;
    } catch {
      memory.set(key, value);
      return;
    }
  }
  memory.set(key, value);
}

export async function removeItem(key: string): Promise<void> {
  if (webOk) {
    try {
      window.localStorage.removeItem(key);
      return;
    } catch {
      memory.delete(key);
      return;
    }
  }
  if (Platform.OS !== 'web') {
    try {
      await AsyncStorage.removeItem(key);
      return;
    } catch {
      memory.delete(key);
      return;
    }
  }
  memory.delete(key);
}

/** Synchronous read — only works on web. Used for the lazy-init draft hydration. */
export function getItemSync(key: string): string | null {
  if (webOk) {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return memory.get(key) ?? null;
    }
  }
  return memory.get(key) ?? null;
}

export async function readJson<T>(key: string): Promise<T | undefined> {
  const raw = await getItem(key);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

export function readJsonSync<T>(key: string): T | undefined {
  const raw = getItemSync(key);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

export async function writeJson<T>(key: string, value: T): Promise<void> {
  await setItem(key, JSON.stringify(value));
}

// Keep the old `storage` namespace for callers that use it.
export const storage = {
  get: getItemSync,
  set: (key: string, value: string) => {
    void setItem(key, value);
  },
  remove: (key: string) => {
    void removeItem(key);
  },
};
