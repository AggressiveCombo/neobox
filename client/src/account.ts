// Account client: typed wrappers for the /api/account, /api/friends and /api/library
// JSON endpoints, plus prefs sync (signed-in players keep their preferences on the
// server). Failures are ApiError carrying the server's message.

import type { AppCtx } from "./ctx";
import { NAME_RE } from "./protocol";
import { prefs, sanitizePrefs } from "./prefs";
import { ACCOUNT_NAME_KEY, NAME_STORAGE_KEY, PREFS_PENDING_KEY, REMEMBER_KEY } from "./storage-keys";
import { local } from "./storage";
import { type Account, type AppState, type Screen } from "./state";
import { HttpError } from "./http-error";
import { pageFetch, pageLeaving } from "./page-leave";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The server's `error` field when the body is JSON, else the plain text body (short ones only). */
function errorMessage(text: string, status: number): string {
  try {
    const data: unknown = JSON.parse(text);
    if (typeof data === "object" && data !== null && "error" in data && typeof data.error === "string") {
      return data.error;
    }
  } catch {
    // not JSON: fall through to the text body
  }
  const plain = text.trim();
  return plain !== "" && plain.length <= 200 ? plain : new HttpError(status).message;
}

/** One JSON request. Empty success bodies resolve to undefined; non-JSON bodies to their text. */
export async function request<T>(method: string, path: string, body?: unknown, keepalive = false): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  let payload: string | undefined;
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await pageFetch(path, { method, headers, body: payload, keepalive, credentials: "same-origin" });
  } catch {
    throw new ApiError("can't reach the server", 0);
  }
  const text = await res.text();
  if (!res.ok) throw new ApiError(errorMessage(text, res.status), res.status);
  if (text === "") return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError("the server sent an unexpected answer", res.status);
  }
}

// Accounts

/** The signed-in account, or null for guests. */
export const fetchMe = (): Promise<Account | null> => request<Account | null>("GET", "/api/account/me");

/** Sign in or register; `remember` keeps the session after the browser closes (the original's "Stay logged in"). */
async function startSession(path: string, name: string, password: string, remember: boolean): Promise<Account> {
  const account = await request<Account>("POST", path, { name, password, remember });
  local.setItem(REMEMBER_KEY, remember ? "1" : "0");
  return account;
}

export const register = (name: string, password: string, remember: boolean): Promise<Account> =>
  startSession("/api/account/register", name, password, remember);

export const login = (name: string, password: string, remember: boolean): Promise<Account> =>
  startSession("/api/account/login", name, password, remember);

export const logout = (): Promise<void> => request<void>("POST", "/api/account/logout");

export const changePassword = (old: string, next: string): Promise<void> =>
  request<void>("POST", "/api/account/password", { old, new: next, remember: local.getItem(REMEMBER_KEY) === "1" });

export const deleteAccount = (password: string): Promise<void> =>
  request<void>("POST", "/api/account/delete", { password });

// Friends

export type FriendState = "friend" | "incoming" | "outgoing";

export interface FriendRoom {
  code: string;
  name: string;
}

export interface Friend {
  name: string;
  state: FriendState;
  online: boolean;
  room?: FriendRoom | null;
}

export const listFriends = (): Promise<Friend[]> => request<Friend[]>("GET", "/api/friends");

export const requestFriend = (name: string): Promise<void> => request<void>("POST", "/api/friends/request", { name });

export const acceptFriend = (name: string): Promise<void> => request<void>("POST", "/api/friends/accept", { name });

/** Removes a friend, declines an incoming request or cancels an outgoing one. */
export const removeFriend = (name: string): Promise<void> => request<void>("POST", "/api/friends/remove", { name });

// Library

export type Visibility = "public" | "unlisted" | "private";
export type MapStatus = "pending" | "approved" | "rejected";
export type LibrarySort = "new" | "hot" | "top" | "plays" | "picks";

export interface LibraryMap {
  id: number;
  name: string;
  author: string;
  votes: number;
  plays: number;
  created: string;
  visibility: Visibility;
  status: MapStatus;
  description: string;
  /** Staff picks are listed first under "Staff picks". */
  pick: boolean;
  my_vote?: number | null;
  favourite?: boolean;
}

/** GET /api/library/{id}: the list entry plus the map code. */
export interface LibraryDetail extends LibraryMap {
  code: string;
}

/** Maps per library page (the server's PAGE_SIZE); a shorter page is the last one. */
export const LIBRARY_PAGE_SIZE = 24;

export interface LibraryQuery {
  sort: LibrarySort;
  q: string;
  /** 0-based page number. */
  page: number;
}

export function listLibrary(query: LibraryQuery): Promise<LibraryMap[]> {
  const params = new URLSearchParams({ sort: query.sort, page: String(query.page) });
  const q = query.q.trim();
  if (q !== "") params.set("q", q);
  return request<LibraryMap[]>("GET", `/api/library?${params.toString()}`);
}

export const listMine = (): Promise<LibraryMap[]> => request<LibraryMap[]>("GET", "/api/library/mine");

export const listFavourites = (): Promise<LibraryMap[]> => request<LibraryMap[]>("GET", "/api/library/favourites");

/** One of this week's top map makers: votes and plays on their maps. */
export interface MakerScore {
  name: string;
  score: number;
}

export const listMakers = (): Promise<MakerScore[]> => request<MakerScore[]>("GET", "/api/library/makers");

export const getMap = (id: number): Promise<LibraryDetail> => request<LibraryDetail>("GET", `/api/library/${id}`);

export const uploadMap = (body: {
  name: string;
  description: string;
  code: string;
  visibility: Visibility;
}): Promise<void> => request<void>("POST", "/api/library", body);

export const updateMap = (
  id: number,
  patch: { name?: string; description?: string; visibility?: Visibility; code?: string },
): Promise<void> => request<void>("PATCH", `/api/library/${id}`, patch);

export const deleteMap = (id: number): Promise<void> => request<void>("DELETE", `/api/library/${id}`);

export const voteMap = (id: number, v: -1 | 0 | 1): Promise<void> => request<void>("POST", `/api/library/${id}/vote`, { v });

export const favouriteMap = (id: number, on: boolean): Promise<void> =>
  request<void>("POST", `/api/library/${id}/favourite`, { on });

export const playMap = (id: number): Promise<void> => request<void>("POST", `/api/library/${id}/play`);

/** One row of a library map's Fastest Times: a player's best time, in ticks at 30 per second. */
export interface MapRecord {
  rank: number;
  name: string;
  ticks: number;
  /** Unix seconds when the time was set. */
  date: number;
}

export const listRecords = (id: number): Promise<MapRecord[]> => request<MapRecord[]>("GET", `/api/library/${id}/records`);

// Players

/** Totals a player's finished games add up to (GET /api/players/{name}). */
export interface PlayerStats {
  games: number;
  wins: number;
  rounds_won: number;
  kills: number;
  deaths: number;
  play_seconds: number;
}

/** One of a player's best listed maps. */
export interface PlayerMap {
  id: number;
  name: string;
  plays: number;
  score: number;
}

/** A signed-in player's public profile. `joined` is an ISO time. */
export interface PlayerProfile {
  name: string;
  level: number;
  xp: number;
  joined: string;
  /** Appearance colour (0xRRGGBB) shown in rooms; null when the player never chose one. */
  color: number | null;
  stats: PlayerStats;
  friends: number;
  published: number;
  maps: PlayerMap[];
  records: number;
}

export const getPlayer = (name: string): Promise<PlayerProfile> =>
  request<PlayerProfile>("GET", `/api/players/${encodeURIComponent(name)}`);

// Prefs sync

const PUSH_DELAY_MS = 1000;

type Timer = ReturnType<typeof setTimeout>;

/** Pending debounced save. */
let pushTimer: Timer | undefined;
/** Pull from the server in flight: saves wait for it so a local edit never races it. */
let pulling: Promise<void> = Promise.resolve();
/** True while server prefs are being applied, so the subscription does not echo them back. */
let applying = false;

function queuePush(ctx: AppCtx): void {
  if (ctx.store.state.account === null) return;
  local.setItem(PREFS_PENDING_KEY, String(ctx.store.state.account.id));
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = undefined;
    void pushPrefs(ctx, false);
  }, PUSH_DELAY_MS);
}

async function pushPrefs(ctx: AppCtx, keepalive: boolean): Promise<void> {
  const accountId = ctx.store.state.account?.id;
  if (accountId === undefined) return;
  if (!keepalive) await pulling;
  if (ctx.store.state.account?.id !== accountId) return;
  // The page is leaving: a save started now would be cancelled by the navigation. Keep it queued (the pending mark
  // stays), so it runs again if the page is still here, or on the next sign-in if it is not.
  if (!keepalive && pageLeaving()) {
    queuePush(ctx);
    return;
  }
  try {
    await request<void>("PUT", "/api/account/prefs", prefs.value, keepalive);
    if (pushTimer === undefined) local.removeItem(PREFS_PENDING_KEY);
  } catch (err) {
    ctx.toast(`settings not saved to your account: ${errorText(err)}`, "error");
  }
}

/** On sign-in the server's copy wins when it has one; otherwise this device's copy is uploaded. */
async function pullPrefs(ctx: AppCtx, accountId: number): Promise<void> {
  try {
    let remote: unknown = null;
    try {
      remote = await request<unknown>("GET", "/api/account/prefs");
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 404)) throw err;
    }
    if (ctx.store.state.account?.id !== accountId) return;
    // A change made here that never reached the server (the page went away first) is newer than the server's copy.
    if (local.getItem(PREFS_PENDING_KEY) === String(accountId)) {
      queuePush(ctx);
      return;
    }
    const stored = typeof remote === "object" && remote !== null && Object.keys(remote).length > 0;
    if (stored) {
      local.removeItem(PREFS_PENDING_KEY);
      applying = true;
      try {
        prefs.set(sanitizePrefs(remote));
      } finally {
        applying = false;
      }
    } else {
      queuePush(ctx);
    }
  } catch (err) {
    ctx.toast(`could not load your settings: ${errorText(err)}`, "error");
  }
}

/**
 * Start account handling: look up the session once, then keep the signed-in
 * player's prefs in step with the server. Call once at boot. `ready` runs once the lookup has
 * settled, signed in or not.
 */
export function startAccountSync(ctx: AppCtx, ready: () => void): void {
  prefs.subscribe(() => {
    if (!applying) queuePush(ctx);
  });
  ctx.store.subscribe((state, prev) => {
    if (state.account?.id === prev.account?.id) return;
    clearTimeout(pushTimer);
    pushTimer = undefined;
    if (state.account) pulling = pullPrefs(ctx, state.account.id);
  });
  // Flush a pending save when the page goes away.
  window.addEventListener("pagehide", () => {
    if (pushTimer === undefined) return;
    clearTimeout(pushTimer);
    pushTimer = undefined;
    void pushPrefs(ctx, true);
  });
  // Offline the lookup cannot succeed; the `online` listener runs it again once the browser connects.
  if (navigator.onLine) void refreshAccount(ctx).then(ready);
  else ready();
  window.addEventListener("online", () => void refreshAccount(ctx));
}

/**
 * Look up the session now and store it. A failed lookup is silent offline (the browser already
 * says so); the menu's Retry calls this too.
 */
export async function refreshAccount(ctx: AppCtx): Promise<void> {
  try {
    setAccountState(ctx, await fetchMe());
  } catch (err) {
    if (navigator.onLine) ctx.toast(`could not check your account: ${errorText(err)}`, "error");
  }
}

/** The account name this device last saw signed in, for the menu while offline ("" when none). */
export function lastAccountName(): string {
  return local.getItem(ACCOUNT_NAME_KEY) ?? "";
}

/**
 * Store the signed-in account (null for a guest). The name is remembered for offline use and cleared on
 * sign-out. A player who leaves an account plays under their own guest name again, never the account's.
 */
function setAccountState(ctx: AppCtx, account: Account | null): void {
  if (account) local.setItem(ACCOUNT_NAME_KEY, account.name);
  else local.removeItem(ACCOUNT_NAME_KEY);
  const leaving = account === null && ctx.store.state.account !== null;
  ctx.store.set(leaving ? { account, name: readStoredName() } : { account });
}

/**
 * Store a new identity after sign-in, sign-out or deletion. A live connection keeps
 * the identity it was opened with, so an open connection is re-opened to pick it up
 * and the browser comes back. Inside a match the change waits for the next connect.
 */
export function applyAccount(ctx: AppCtx, account: Account | null): void {
  setAccountState(ctx, account);
  const { connection, inMatch, name } = ctx.store.state;
  if (connection === "closed") return;
  if (inMatch) {
    ctx.toast("this takes effect the next time you connect", "info");
    return;
  }
  const saved = name || readStoredName();
  ctx.disconnect();
  if (NAME_RE.test(saved)) ctx.play(saved);
  else ctx.toast("press Play to reconnect", "info");
}

function readStoredName(): string {
  try {
    return local.getItem(NAME_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

/** The screen a "back" control returns to: the room or browser when connected, else the menu. */
export function returnScreen(state: AppState): Screen {
  if (state.room) return "room";
  if (state.serverName !== "") return "browse";
  return "menu";
}
