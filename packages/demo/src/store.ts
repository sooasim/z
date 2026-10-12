/**
 * Browser-local demo state (localStorage). Shared by all personas on this device, so a booking made as the
 * guest shows up for the host after a persona switch.
 */
import type { Obj } from './util';

const STATE_KEY = 'jpdemo:state:v1';
export const SESSION_KEY = 'jpdemo:session:v1';
export const ACCOUNTS_KEY = 'jpdemo:accounts:v1';
export const UI_KEY = 'jpdemo:ui:v1';

export type Kind = 'reservation' | 'exchange' | 'guideRequest' | 'guideBooking' | 'order' | 'payment' | 'quote' | 'hold' | 'conversation' | 'property' | 'review' | 'notification' | 'agreement' | 'cmsEntry';

export interface DemoState {
  v: 1;
  /** Full entity objects created or modified in the demo, by kind and id. */
  entities: Record<Kind, Record<string, Obj>>;
  /** Locally sent messages by conversation id. */
  messages: Record<string, Obj[]>;
  /** Favorites by persona: added (full list items) and removed keys `TYPE:id`. */
  favorites: Record<string, { added: Obj[]; removed: string[] }>;
  /** Read markers. */
  read: { notifications: Record<string, string>; allBefore: Record<string, string>; conversations: Record<string, string> };
  /** PATCHed resources by persona (`/v1/me/profile`, `/v1/me/preferences`, …). */
  patches: Record<string, Record<string, Obj>>;
  /** Idempotency-Key replay cache. */
  idem: Record<string, { status: number; body: any; at: number }>;
  /** Next free index per id pool. */
  pool: Record<string, number>;
  log: Array<{ at: string; method: string; path: string }>;
}

const empty = (): DemoState => ({
  v: 1,
  entities: { reservation: {}, exchange: {}, guideRequest: {}, guideBooking: {}, order: {}, payment: {}, quote: {}, hold: {}, conversation: {}, property: {}, review: {}, notification: {}, agreement: {}, cmsEntry: {} },
  messages: {},
  favorites: {},
  read: { notifications: {}, allBefore: {}, conversations: {} },
  patches: {},
  idem: {},
  pool: {},
  log: [],
});

let state: DemoState = load();

function load(): DemoState {
  try {
    const raw = localStorage.getItem(STATE_KEY);
    if (raw) {
      const s = JSON.parse(raw);
      if (s && s.v === 1) {
        const e = empty();
        return { ...e, ...s, entities: { ...e.entities, ...(s.entities || {}) }, read: { ...e.read, ...(s.read || {}) } };
      }
    }
  } catch {
    /* corrupted or unavailable storage → start fresh */
  }
  return empty();
}

export function S(): DemoState {
  return state;
}

export function save() {
  try {
    // keep the replay cache bounded
    const keys = Object.keys(state.idem);
    if (keys.length > 300) for (const k of keys.sort((a, b) => state.idem[a].at - state.idem[b].at).slice(0, keys.length - 300)) delete state.idem[k];
    if (state.log.length > 200) state.log = state.log.slice(-200);
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
  } catch {
    /* storage full / disabled: the demo keeps working in memory */
  }
}

export function resetAll() {
  state = empty();
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith('jpdemo:')) localStorage.removeItem(k);
    for (const k of Object.keys(sessionStorage)) if (k.startsWith('jp_') || k.startsWith('jpdemo:')) sessionStorage.removeItem(k);
  } catch {
    /* ignore */
  }
}

export function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
export function writeJson(key: string, v: unknown) {
  try {
    if (v === null || v === undefined) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* ignore */
  }
}

export function entity(kind: Kind, id: string): Obj | undefined {
  return state.entities[kind]?.[id];
}
export function putEntity(kind: Kind, obj: Obj): Obj {
  (state.entities[kind] ||= {})[obj.id] = obj;
  save();
  return obj;
}
export function entities(kind: Kind): Obj[] {
  return Object.values(state.entities[kind] || {});
}
