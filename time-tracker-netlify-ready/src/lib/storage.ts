/**
 * Safe storage wrapper. In sandboxed iframes (e.g. the in-app preview) the
 * browser may block localStorage, so we transparently fall back to an
 * in-memory store that lives for the lifetime of the page.
 */

const memory = new Map<string, string>()

let useMemory = false
try {
  const k = '__wt_test__'
  window.localStorage.setItem(k, '1')
  window.localStorage.removeItem(k)
} catch {
  useMemory = true
}

export const storage = {
  getItem(key: string): string | null {
    if (useMemory) return memory.get(key) ?? null
    try {
      return window.localStorage.getItem(key)
    } catch {
      return memory.get(key) ?? null
    }
  },
  setItem(key: string, value: string): void {
    memory.set(key, value)
    if (!useMemory) {
      try {
        window.localStorage.setItem(key, value)
      } catch {
        /* keep in memory */
      }
    }
  },
  removeItem(key: string): void {
    memory.delete(key)
    if (!useMemory) {
      try {
        window.localStorage.removeItem(key)
      } catch {
        /* ignore */
      }
    }
  },
}
