/** Synthetic browser events preserve listener registration, removal and delivery. */
export function createBrowserEvent<Args extends unknown[]>() {
  const listeners = new Set<(...args: Args) => unknown>();
  return {
    addListener: (listener: (...args: Args) => unknown) => {
      listeners.add(listener);
    },
    removeListener: (listener: (...args: Args) => unknown) => {
      listeners.delete(listener);
    },
    hasListener: (listener: (...args: Args) => unknown) => listeners.has(listener),
    hasListeners: () => listeners.size > 0,
    emit: (...args: Args) => {
      for (const listener of [...listeners]) listener(...args);
    },
    clear: () => listeners.clear(),
  };
}
