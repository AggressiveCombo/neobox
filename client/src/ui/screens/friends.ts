// Friends screen: add a friend by name, answer incoming requests, see sent ones, and the
// friend list with online state and the room each friend is in (Join). Refreshes every
// 15 seconds while open.

import {
  acceptFriend,
  errorText,
  listFriends,
  removeFriend,
  requestFriend,
  returnScreen,
  type Friend,
} from "../../account";
import type { AppCtx, ScreenFactory } from "../../ctx";
import { MAX_NAME_LEN, NAME_RE } from "../../protocol";
import type { AppState } from "../../state";
import { h, type Child } from "../dom";
import { icon, type IconName } from "../icons";
import { avatar, iconButton, page, pageHead } from "../kit";
import { showProfile } from "../profile";
import { signInPrompt } from "./account";

const REFRESH_MS = 15_000;
const NAME_ERROR = "Names are 1 to 15 letters, numbers, spaces or _.";

export const friendsScreen: ScreenFactory = (ctx) => {
  const { store } = ctx;
  let friends: Friend[] = [];
  let signedAs: number | null | undefined;
  let seq = 0;
  let timer: number | undefined;

  const status = h("p", { class: "status", role: "status", "aria-live": "polite" });
  const groups = h("div", { class: "friend-groups" });
  const nameInput = h("input", {
    type: "text",
    placeholder: "Friend's name",
    maxlength: MAX_NAME_LEN,
    autocomplete: "off",
    spellcheck: "false",
    "aria-label": "friend's name",
  });
  const body = h("div", { class: "friends-body" });

  function onAdd(e: Event): void {
    e.preventDefault();
    const who = nameInput.value.trim();
    if (!NAME_RE.test(who)) {
      status.textContent = NAME_ERROR;
      return;
    }
    void act(() => requestFriend(who), `Request sent to ${who}.`).then((done) => {
      if (done) nameInput.value = "";
    });
  }

  const addForm = h(
    "form",
    { class: "friend-add", onsubmit: onAdd },
    h("h2", null, icon("user-plus", 20), "Add a friend"),
    nameInput,
    h("button", { type: "submit", class: "primary" }, icon("send", 18), "Send request"),
    h("p", { class: "field-hint" }, "They need an account."),
  );

  /** Run a friend action, show its result, then reload the list. Resolves true on success. */
  async function act(run: () => Promise<void>, ok: string): Promise<boolean> {
    status.textContent = "";
    let done = false;
    try {
      await run();
      status.textContent = ok;
      done = true;
    } catch (err) {
      status.textContent = errorText(err);
    }
    await refresh();
    return done;
  }

  async function refresh(): Promise<void> {
    const req = ++seq;
    try {
      const list = await listFriends();
      if (req !== seq) return;
      friends = list;
      paint();
    } catch (err) {
      if (req === seq) status.textContent = errorText(err);
    }
  }

  /** A friend's avatar, with a green dot at its corner while they are online. */
  function presence(f: Friend): HTMLElement {
    const dot = f.online ? h("span", { class: "friend-presence", role: "img", "aria-label": "online" }) : null;
    return h("span", { class: "friend-avatar" }, avatar(f.name, null), dot);
  }

  function row(main: Child[], actions: Child[], online = false): HTMLElement {
    return h(
      "li",
      { class: online ? "friend-row online" : "friend-row" },
      h("div", { class: "row-main" }, main),
      h("div", { class: "row-actions" }, actions),
    );
  }

  function friendRow(f: Friend): HTMLElement {
    const room = f.room ?? null;
    const where = f.online ? (room ? `in ${room.name}` : "online") : "offline";
    const actions: Child[] = [];
    if (room) {
      actions.push(h("button", { type: "button", class: "ink friend-join", onclick: () => ctx.joinRoom(room.code) }, icon("door-open", 18), "Join"));
    }
    actions.push(iconButton("user-minus", "Remove friend", () => void act(() => removeFriend(f.name), `Removed ${f.name}.`), "friend-remove"));
    return row(
      [presence(f), h("span", { class: "friend-who" }, h("button", { type: "button", class: "friend-name", "aria-label": `${f.name} profile`, onclick: () => showProfile(ctx, f.name) }, f.name), h("span", { class: "row-sub" }, where))],
      actions,
      f.online,
    );
  }

  function requestRow(f: Friend): HTMLElement {
    if (f.state === "incoming") {
      return row(
        [presence(f), h("span", { class: "friend-who" }, h("strong", null, f.name), h("span", { class: "row-sub" }, "wants to be friends"))],
        [
          h("button", { type: "button", class: "friend-accept", onclick: () => void act(() => acceptFriend(f.name), `You are now friends with ${f.name}.`) }, icon("check", 18), "Accept"),
          iconButton("x", "Decline", () => void act(() => removeFriend(f.name), `Declined ${f.name}.`), "friend-remove"),
        ],
      );
    }
    return row(
      [presence(f), h("span", { class: "friend-who" }, h("strong", null, f.name), h("span", { class: "row-sub" }, "request sent"))],
      [iconButton("x", "Cancel request", () => void act(() => removeFriend(f.name), `Cancelled ${f.name}.`), "friend-remove")],
    );
  }

  /** Section containers, kept across paints so the rows inside keep their focus. */
  const sections = new Map<string, { el: HTMLElement; head: HTMLElement; list: HTMLElement; empty: HTMLElement }>();
  /** Rows built on an earlier paint, by key. A row is reused while its signature holds. */
  const built = new Map<string, { sig: string; el: HTMLElement }>();

  function sectionFor(title: string, name: IconName): { el: HTMLElement; head: HTMLElement; list: HTMLElement; empty: HTMLElement } {
    let s = sections.get(title);
    if (s === undefined) {
      const head = h("h2", null, icon(name, 18), title);
      const list = h("ul", { class: "friend-list", "aria-label": title });
      const empty = h("p", { class: "empty" });
      s = { el: h("section", { class: "section friend-section" }, head, list), head, list, empty };
      sections.set(title, s);
    }
    return s;
  }

  /** The row for `key`: the one built earlier while `sig` still holds, else a new one from `make`. */
  function rowFor(key: string, sig: string, make: () => HTMLElement): HTMLElement {
    const hit = built.get(key);
    if (hit !== undefined && hit.sig === sig) return hit.el;
    const el = make();
    built.set(key, { sig, el });
    return el;
  }

  /** Puts `items` into `parent` in order. A child already in place does not move, so its focus survives. */
  function order(parent: HTMLElement, items: HTMLElement[]): void {
    items.forEach((el, i) => {
      if (parent.children[i] !== el) parent.insertBefore(el, parent.children[i] ?? null);
    });
    while (parent.children.length > items.length) parent.lastElementChild?.remove();
  }

  /** The three groups. Rows are reconciled in place: a refresh that changes nothing touches no control. */
  function paint(): void {
    const incoming = friends.filter((f) => f.state === "incoming");
    const outgoing = friends.filter((f) => f.state === "outgoing");
    const mine = friends.filter((f) => f.state === "friend");
    const seen = new Set<string>();
    const shown: HTMLElement[] = [];
    const rows = (list: Friend[], build: (f: Friend) => HTMLElement): HTMLElement[] =>
      list.map((f) => {
        const key = `${f.state}:${f.name}`;
        seen.add(key);
        return rowFor(key, `${f.online}|${f.room?.code ?? ""}|${f.room?.name ?? ""}`, () => build(f));
      });
    const group = (title: string, name: IconName, items: HTMLElement[], empty: string): void => {
      const s = sectionFor(title, name);
      s.empty.textContent = empty;
      order(s.list, items);
      order(s.el, [s.head, items.length > 0 ? s.list : s.empty]);
      shown.push(s.el);
    };
    if (incoming.length > 0) group("Requests", "bell", rows(incoming, requestRow), "");
    if (outgoing.length > 0) group("Sent", "send", rows(outgoing, requestRow), "");
    group("Friends", "users", rows(mine, friendRow), "No friends yet. Add one by name.");
    order(groups, shown);
    el.classList.toggle("is-empty", friends.length === 0);
    for (const key of built.keys()) if (!seen.has(key)) built.delete(key);
  }

  /** Show the list for the current account (or the sign-in prompt) and start or stop polling. */
  function sync(state: AppState): void {
    const id = state.account?.id ?? null;
    if (id === signedAs) return;
    signedAs = id;
    clearInterval(timer);
    timer = undefined;
    friends = [];
    built.clear();
    if (state.account === null) {
      body.replaceChildren(signInPrompt(ctx, "Friends need an account. Sign in to add friends and see when they are online."));
      return;
    }
    body.replaceChildren(h("div", { class: "friends-main" }, addForm, status, groups));
    paint();
    void refresh();
    timer = window.setInterval(() => void refresh(), REFRESH_MS);
  }

  const el = page(
    "friends-page",
    pageHead({ title: "Friends", back: () => store.set({ screen: returnScreen(store.state) }) }),
    body,
  );

  sync(store.state);

  return {
    el,
    update(state) {
      sync(state);
    },
    destroy() {
      clearInterval(timer);
      el.remove();
    },
  };
};
