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
import { field, page, pageHead } from "../kit";
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
    { class: "panel friend-add", onsubmit: onAdd },
    h("h2", null, "Add a friend"),
    field("Friend's name", nameInput, "They need an account. Their name, as they signed up with it."),
    h("div", { class: "actions" }, h("button", { type: "submit", class: "primary" }, "Send request")),
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
    if (room) actions.push(h("button", { type: "button", class: "ink", onclick: () => ctx.joinRoom(room.code) }, "Join"));
    actions.push(h("button", { type: "button", onclick: () => void act(() => removeFriend(f.name), `Removed ${f.name}.`) }, "Remove"));
    return row(
      [
        h("span", { class: f.online ? "dot online" : "dot", "aria-label": f.online ? "online" : "offline", role: "img" }),
        h("strong", null, f.name),
        h("span", { class: "row-sub" }, where),
      ],
      actions,
      f.online,
    );
  }

  function requestRow(f: Friend): HTMLElement {
    if (f.state === "incoming") {
      return row(
        [h("strong", null, f.name), h("span", { class: "row-sub" }, "wants to be friends")],
        [
          h("button", { type: "button", onclick: () => void act(() => acceptFriend(f.name), `You are now friends with ${f.name}.`) }, "Accept"),
          h("button", { type: "button", onclick: () => void act(() => removeFriend(f.name), `Declined ${f.name}.`) }, "Decline"),
        ],
      );
    }
    return row(
      [h("strong", null, f.name), h("span", { class: "row-sub" }, "request sent")],
      [h("button", { type: "button", onclick: () => void act(() => removeFriend(f.name), `Cancelled ${f.name}.`) }, "Cancel")],
    );
  }

  function section(title: string, items: HTMLElement[], empty: string): HTMLElement {
    const list =
      items.length > 0
        ? h("ul", { class: "friend-list", "aria-label": title }, items)
        : h("p", { class: "empty" }, empty);
    return h("section", { class: "section friend-section" }, h("h2", null, title), list);
  }

  function paint(): void {
    const incoming = friends.filter((f) => f.state === "incoming");
    const outgoing = friends.filter((f) => f.state === "outgoing");
    const mine = friends.filter((f) => f.state === "friend");
    groups.replaceChildren(
      ...(incoming.length > 0 ? [section("Requests", incoming.map(requestRow), "")] : []),
      ...(outgoing.length > 0 ? [section("Sent", outgoing.map(requestRow), "")] : []),
      section("Friends", mine.map(friendRow), "No friends yet. Add someone by their name to get started."),
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
    body.replaceChildren(h("div", { class: "friends-layout" }, addForm, h("div", { class: "friends-main" }, status, groups)));
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
