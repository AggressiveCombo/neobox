// localStorage and sessionStorage can throw (private mode, disabled storage, quota). Callers use these
// instead of the window globals: a write that fails is kept in memory for this page's lifetime, and a
// read that throws reads as absent, so the game keeps working without persistence instead of erroring.

export interface KeyValue {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function area(scope: "local" | "session"): Storage | null {
  try {
    return scope === "local" ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

function backed(scope: "local" | "session"): KeyValue {
  // Values that could not be written to the browser store; they win over it until a write succeeds.
  const memory = new Map<string, string>();
  return {
    getItem(key) {
      if (memory.has(key)) return memory.get(key) ?? null;
      try {
        return area(scope)?.getItem(key) ?? null;
      } catch {
        return null;
      }
    },
    setItem(key, value) {
      try {
        const store = area(scope);
        if (!store) throw new Error("storage unavailable");
        store.setItem(key, value);
        memory.delete(key);
      } catch {
        memory.set(key, value);
      }
    },
    removeItem(key) {
      memory.delete(key);
      try {
        area(scope)?.removeItem(key);
      } catch {
        // nothing stored in the browser to remove
      }
    },
  };
}

/** Survives visits, like localStorage (falls back to memory when the browser refuses writes). */
export const local: KeyValue = backed("local");
/** Lasts as long as the tab, like sessionStorage. */
export const session: KeyValue = backed("session");
