import { EventEmitter } from "node:events";

const store = new Map(); // key: `${clientId}::${componentId}` -> StateEntry

export const stateBus = new EventEmitter();

function key(clientId, componentId) {
  return `${clientId}::${componentId}`;
}

export const stateEngine = {
  upsert(event) {
    const k = key(event.clientId, event.componentId);
    const previous = store.get(k);
    const entry = { ...event, updatedAt: new Date().toISOString() };
    store.set(k, entry);

    const changed = !previous || previous.value !== event.value;
    stateBus.emit(changed ? "state.changed" : "state.heartbeat", {
      ...entry,
      previousValue: previous?.value ?? null,
    });
  },

  get(clientId, componentId) {
    return store.get(key(clientId, componentId)) ?? null;
  },

  getAllForClient(clientId) {
    return [...store.values()].filter((e) => e.clientId === clientId);
  },

  getAll() {
    return [...store.values()];
  },

  // Matches StateQuery.subscribe from docs/06-state-engine.md §6.5 — filters
  // on state.changed only (the documented "value actually differs" topic),
  // returns an unsubscribe function.
  subscribe(filter, handler) {
    const wrapped = (event) => {
      if (filter.clientId && event.clientId !== filter.clientId) return;
      if (filter.componentId && event.componentId !== filter.componentId) return;
      if (filter.eventType && event.eventType !== filter.eventType) return;
      handler(event);
    };
    stateBus.on("state.changed", wrapped);
    return () => stateBus.off("state.changed", wrapped);
  },
};
