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

  function section(title: string, name: IconName, items: HTMLElement[], empty: string): HTMLElement {
    const list =
      items.length > 0
        ? h("ul", { class: "friend-list", "aria-label": title }, items)
        : h("p", { class: "empty" }, empty);
    return h("section", { class: "section friend-section" }, h("h2", null, icon(name, 18), title), list);
  }

  function paint(): void {
    const incoming = friends.filter((f) => f.state === "incoming");
    const outgoing = friends.filter((f) => f.state === "outgoing");
    const mine = friends.filter((f) => f.state === "friend");
    groups.replaceChildren(
      ...(incoming.length > 0 ? [section("Requests", "bell", incoming.map(requestRow), "")] : []),
      ...(outgoing.length > 0 ? [section("Sent", "send", outgoing.map(requestRow), "")] : []),
      section("Friends", "users", mine.map(friendRow), "No friends yet. Add one by name."),
    );
  }

  /** Show the list for the current account (or the sign-in prompt) and start or stop polling. */
  function sync(state: AppState): void {
    const id = state.account?.id ?? null;
    if (id === signedAs) return;
    signedAs = id;
    clearInterval(timer);
    timer = undefined;
    friends = [];
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
