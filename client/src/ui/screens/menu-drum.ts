// The home destinations as a drum: options on a vertical cylinder seen from the front, one of them centred and
// selected. The drum has two ends and does not wrap: rolling past the first or last option meets a small bump
// that springs back. The input moves a target at once (wheel, drag, keys, gamepad), and the drum eases toward
// it, so it follows a fast scroll with no pause; when the wheel stops it settles on the nearest option.
// A click on a neighbour rolls it to the centre; a click on the centred option, or Enter, opens it. Each option
// is placed with transform and opacity only (no layout per frame); the window size and the look come from menu.css.

import { reducedMotion } from "../a11y";
import { h } from "../dom";
import { type IconName, icon } from "../icons";
import { armedAxis } from "../../pad-axis";

export interface DrumItem {
  id: string;
  label: string;
  icon: IconName;
  /** The one-line description, shown under the drum while the option is centred. */
  hint: string;
  /** Opens the option. */
  run: () => void;
  /** Extra content inside the option (a badge or a dot). */
  extra?: HTMLElement;
}

export interface Drum {
  /** The listbox: the options, with aria-activedescendant naming the centred one. */
  listbox: HTMLElement;
  /** The description of the centred option; the listbox points at it. */
  hint: HTMLElement;
  setDisabled(id: string, disabled: boolean): void;
  destroy(): void;
}

/** Angle between neighbouring options on the cylinder, degrees. */
const STEP_DEG = 14;
const SIN_STEP = Math.sin((STEP_DEG * Math.PI) / 180);
/** Options turned past this from the front are on the far side of the cylinder and not drawn. */
const FRONT_DEG = 60;
/** A row shorter than this (px) is drawn as a peek but is not a click target: it is too small to hit. */
const MIN_HIT_PX = 24;
/** Wheel and trackpad travel that rolls one option, px. */
const WHEEL_PX_PER_OPTION = 100;
/** How far past an end the target may be pushed (in options): the bump that springs back once the input stops. */
const BUMP = 0.35;
/** Time constant of the ease from where the drum is drawn to its target, ms: the drum keeps up with fast input. */
const EASE_MS = 45;
/** The drum settles on its nearest option this long after the last wheel step or key step. */
const SETTLE_MS = 50;
/** Within this many options of the target the drum is at rest. */
const REST = 0.02;
/** A pointer must move this far before it is a drag rather than a click. */
const DRAG_SLOP_PX = 6;
/** Stick deflection that counts as a press, and the delays before a held stick repeats. */
const STICK_DEAD = 0.6;
const STICK_FIRST_MS = 400;
const STICK_REPEAT_MS = 220;
const HINT_ID = "home-drum-hint";
const PITCH_FALLBACK_PX = 40;

/** Connected pads; WebKit has no `navigator.getGamepads`, so there are none. */
function pads(): (Gamepad | null)[] {
  return typeof navigator.getGamepads === "function" ? Array.from(navigator.getGamepads()) : [];
}

/** `initial` is the option selected at mount (centred, with options above and below it when the list has them). */
export function mountDrum(
  items: DrumItem[],
  label: string,
  initial = 0,
  onStep?: () => void,
  onOpen?: () => void,
): Drum {
  const n = items.length;
  // `raw` is the travel the input has put the drum at: a wheel step adds to it, and only a discrete input (a key, a
  // click, a drag) or a settle changes it. `target` is where the drum eases to, `pos` where it is drawn now.
  // `front` is the selected option: the target rounded and kept on the list.
  const start = Math.min(n - 1, Math.max(0, initial));
  let pos = start;
  let target = start;
  let raw = start;
  let front = start;
  let pitch = PITCH_FALLBACK_PX;
  let radius = pitch / SIN_STEP;
  let half = 0;
  let optH = 0;
  let frame = 0;
  let last = 0;
  let settleTimer = 0;
  let drag: { id: number; y: number; start: number; moved: boolean } | null = null;
  let suppressClick = false;
  let padLive = false;
  let padUp = false;
  let padDown = false;
  let padA = false;
  let stickDir = 0;
  let stickAt = 0;

  const blocked = new Set<number>();

  /** Runs the front option, unless it is disabled. */
  function open(): void {
    if (blocked.has(front)) return;
    onOpen?.();
    items[front].run();
  }

  const opts: HTMLElement[] = items.map((item, i) =>
    h(
      "div",
      {
        class: "drum-opt",
        id: `home-drum-${item.id}`,
        role: "option",
        "aria-selected": "false",
        onclick: () => {
          if (i === front) open();
          else select(i);
        },
      },
      icon(item.icon, 22),
      h("span", { class: "drum-label" }, item.label),
      item.extra,
    ),
  );
  const hint = h("p", { class: "drum-hint", id: HINT_ID });
  const listbox = h(
    "div",
    {
      class: "drum",
      role: "listbox",
      "data-settled": "true",
      tabindex: "0",
      "aria-label": label,
      "aria-describedby": HINT_ID,
    },
    ...opts,
  );

  /** The option nearest `x`, on the list. */
  function nearestTo(x: number): number {
    return Math.min(n - 1, Math.max(0, Math.round(x)));
  }

  /** Make the front option the selected one: the listbox, the options and the hint say so. */
  function announce(): void {
    for (let k = 0; k < n; k += 1) opts[k].setAttribute("aria-selected", k === front ? "true" : "false");
    listbox.setAttribute("aria-activedescendant", opts[front].id);
    hint.textContent = items[front].hint;
  }

  /** Points the drum at `x`, held within the ends and their bump: the front option follows and the drum eases there. */
  function point(x: number): void {
    target = Math.min(n - 1 + BUMP, Math.max(-BUMP, x));
    const f = nearestTo(target);
    if (f !== front) {
      front = f;
      announce();
      onStep?.();
    }
    listbox.dataset.settled = "false";
    kick();
  }

  /** Moves where the input has put the drum (`raw`, within the ends and their bump) and points the drum at it. */
  function aim(x: number): void {
    raw = Math.min(n - 1 + BUMP, Math.max(-BUMP, x));
    point(raw);
  }

  function cancelSettle(): void {
    clearTimeout(settleTimer);
    settleTimer = 0;
  }

  /** Settles on the nearest option once the input has been still for SETTLE_MS. The snap rounds the target, not `raw`:
   * the travel is kept, so a pause mid-gesture (a slow frame) does not throw away the steps after it. */
  function scheduleSettle(): void {
    cancelSettle();
    settleTimer = window.setTimeout(() => {
      settleTimer = 0;
      point(nearestTo(raw));
    }, SETTLE_MS);
  }

  /** Centre option `i`. */
  function select(i: number): void {
    cancelSettle();
    aim(i);
  }

  /** One option up or down, from the front. At an end the drum bumps and springs back. */
  function step(dir: number): void {
    const base = Math.round(raw);
    const next = base + dir;
    aim(next < 0 || next > n - 1 ? base + dir * BUMP : next);
    scheduleSettle();
  }

  /** Where option i sits on the cylinder, px from the window centre. */
  function yAt(i: number): number {
    return radius * Math.sin(((i - pos) * STEP_DEG * Math.PI) / 180);
  }

  /** Place every option for the current `pos`: the cylinder, turned to face the viewer. */
  function render(): void {
    for (let i = 0; i < n; i += 1) {
      const deg = (i - pos) * STEP_DEG;
      const rad = (deg * Math.PI) / 180;
      const y = yAt(i);
      const style = opts[i].style;
      const front = Math.abs(deg) < FRONT_DEG;
      // The box is as tall as its projected share of the cylinder: the gap to the nearer neighbour, undone for the
      // foreshortening of the turn. Boxes then never overlap, and a row's hit area is the part that is drawn.
      let gap = Infinity;
      if (i > 0) gap = Math.min(gap, Math.abs(y - yAt(i - 1)));
      if (i < n - 1) gap = Math.min(gap, Math.abs(y - yAt(i + 1)));
      const h = front ? Math.min(optH, gap / Math.cos(rad / 2)) : 0;
      // How far the box pokes past the window edge on its side: 0 or less while it sits fully inside.
      const over = Math.abs(y) + h / 2 - half;
      if (!front || over >= h) {
        // Off the window: invisible and inert, but not display:none or visibility:hidden, so screen readers still list it.
        style.opacity = "0";
        style.pointerEvents = "none";
        continue;
      }
      const z = radius * (Math.cos(rad) - 1);
      style.pointerEvents = h < MIN_HIT_PX ? "none" : "";
      style.height = `${h.toFixed(2)}px`;
      style.marginTop = `${(-h / 2).toFixed(2)}px`;
      style.transform = `translate3d(0, ${y.toFixed(2)}px, ${z.toFixed(2)}px) rotateX(${(-deg / 2).toFixed(2)}deg)`;
      // Fully inside: full label contrast. A row the window edge cuts fades with the share still visible: "more below", not disabled.
      style.opacity = over <= 0 ? "1" : (1 - over / h).toFixed(3);
    }
  }

  function layout(): void {
    // --drum-pitch is in rem (it scales with the text size); the layout works in px.
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
    const p = parseFloat(getComputedStyle(listbox).getPropertyValue("--drum-pitch")) * rem;
    pitch = Number.isFinite(p) && p > 0 ? p : PITCH_FALLBACK_PX;
    radius = pitch / SIN_STEP;
    half = listbox.clientHeight / 2;
    const full = parseFloat(getComputedStyle(listbox).getPropertyValue("--drum-opt-h")) * rem;
    optH = Number.isFinite(full) && full > 0 ? full : 0;
    render();
  }

  function kick(): void {
    if (!frame) frame = requestAnimationFrame(tick);
  }

  function tick(now: number): void {
    frame = 0;
    const dt = last ? now - last : 16;
    last = now;
    if (reducedMotion()) pos = target;
    else pos += (target - pos) * (1 - Math.exp(-dt / EASE_MS));
    if (Math.abs(target - pos) < REST) pos = target;
    render();
    if (padLive) pollPad(now);
    if (pos !== target) {
      kick();
      return;
    }
    last = 0;
    if (!settleTimer) listbox.dataset.settled = "true";
    // A connected pad is polled every frame, so the loop keeps going; the drum still reports that it has settled.
    if (padLive) kick();
  }

  function pollPad(now: number): void {
    // Typing in the name field keeps its keys: the pad does nothing there.
    if (document.activeElement instanceof HTMLInputElement) return;
    let up = false;
    let down = false;
    let a = false;
    let stick = 0;
    for (const pad of pads()) {
      if (!pad) continue;
      if (pad.buttons[12]?.pressed === true) up = true;
      if (pad.buttons[13]?.pressed === true) down = true;
      if (pad.buttons[0]?.pressed === true) a = true;
      // The stick counts only once armed (pad-axis.ts): a pedal or wheel axis that rests at ±1 must not roll the drum.
      const y = armedAxis(pad, 1);
      if (y < -STICK_DEAD) stick = -1;
      else if (y > STICK_DEAD) stick = 1;
    }
    if (up && !padUp) step(-1);
    if (down && !padDown) step(1);
    padUp = up;
    padDown = down;
    if (a && !padA) open();
    padA = a;
    if (stick === 0) stickDir = 0;
    else if (stick !== stickDir) {
      step(stick);
      stickDir = stick;
      stickAt = now + STICK_FIRST_MS;
    } else if (now >= stickAt) {
      step(stick);
      stickAt = now + STICK_REPEAT_MS;
    }
  }

  const padConnection = (): void => {
    padLive = pads().some((pad) => pad !== null);
    if (padLive) kick();
  };

  // The listbox keys: up and down roll it one option; Home and End go to the ends; Enter or Space opens the front option.
  listbox.addEventListener("keydown", (e) => {
    switch (e.key) {
      case "ArrowDown":
        step(1);
        break;
      case "ArrowUp":
        step(-1);
        break;
      case "Home":
        select(0);
        break;
      case "End":
        select(n - 1);
        break;
      case "Enter":
      case " ":
        open();
        break;
      default:
        return;
    }
    e.preventDefault();
  });

  // Arrow keys roll the drum from wherever focus is, except a text field or an open dialog: a focused button or link
  // must not swallow them (the drum then looks stuck, and Enter activates that control instead of the option).
  // Enter with nothing focused (the page itself, as after load or a click on the background) opens the front option.
  const onDocKey = (e: KeyboardEvent): void => {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    const active = document.activeElement;
    if (document.querySelector("dialog[open]")) return;
    if (e.key === "Enter") {
      if (active !== null && active !== document.body && active !== document.documentElement) return;
      e.preventDefault();
      listbox.focus({ preventScroll: true });
      open();
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const typing = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || active instanceof HTMLSelectElement || (active instanceof HTMLElement && active.isContentEditable);
    if (typing) return;
    e.preventDefault();
    listbox.focus({ preventScroll: true });
    step(e.key === "ArrowDown" ? 1 : -1);
  };
  document.addEventListener("keydown", onDocKey);

  // Wheel and trackpad: the drum moves with the travel, one option per WHEEL_PX_PER_OPTION, and settles when it stops.
  // The page does not scroll under it.
  listbox.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const px = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * window.innerHeight : e.deltaY;
      cancelSettle();
      aim(raw + px / WHEEL_PX_PER_OPTION);
      scheduleSettle();
    },
    { passive: false },
  );

  // Touch and mouse drag: the drum follows the pointer, then settles on the nearest option.
  listbox.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    suppressClick = false;
    drag = { id: e.pointerId, y: e.clientY, start: raw, moved: false };
  });
  listbox.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dy = e.clientY - drag.y;
    if (!drag.moved) {
      if (Math.abs(dy) < DRAG_SLOP_PX) return;
      drag.moved = true;
      cancelSettle();
      listbox.setPointerCapture(e.pointerId);
    }
    aim(drag.start - dy / pitch);
    pos = target;
    render();
  });
  const endDrag = (e: PointerEvent): void => {
    if (!drag || e.pointerId !== drag.id) return;
    const moved = drag.moved;
    drag = null;
    if (!moved) return;
    // The release of a drag is not a click on whatever is under the pointer.
    suppressClick = true;
    aim(nearestTo(target));
  };
  listbox.addEventListener("pointerup", endDrag);
  listbox.addEventListener("pointercancel", endDrag);
  listbox.addEventListener(
    "click",
    (e) => {
      if (!suppressClick) return;
      suppressClick = false;
      e.stopPropagation();
    },
    true,
  );

  padLive = pads().some((pad) => pad !== null);
  window.addEventListener("gamepadconnected", padConnection);
  window.addEventListener("gamepaddisconnected", padConnection);
  const resizeObserver = new ResizeObserver(layout);
  resizeObserver.observe(listbox);
  // An option's box is in rem: a live text-size change resizes it, so the drum lays out again.
  for (const o of opts) resizeObserver.observe(o);

  layout();
  announce();
  kick();

  return {
    listbox,
    hint,
    setDisabled(id, disabled) {
      const i = items.findIndex((item) => item.id === id);
      if (i < 0) return;
      opts[i].setAttribute("aria-disabled", disabled ? "true" : "false");
      opts[i].classList.toggle("is-disabled", disabled);
      if (disabled) blocked.add(i);
      else blocked.delete(i);
    },
    destroy() {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      cancelSettle();
      padLive = false;
      resizeObserver.disconnect();
      document.removeEventListener("keydown", onDocKey);
      window.removeEventListener("gamepadconnected", padConnection);
      window.removeEventListener("gamepaddisconnected", padConnection);
    },
  };
}
