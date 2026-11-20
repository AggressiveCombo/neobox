// The home destinations as a drum: options on a vertical cylinder seen from the front, one of them
// centred and selected. Scrolling (wheel, drag, keys, gamepad) rolls the drum by whole options: it
// eases in and settles on one, so no option ever stops between two. A click on a neighbour rolls
// it to the centre; a click on the centred option, or Enter, opens it. Each option is placed with
// transform and opacity only (no layout per frame); the window size and the look come from menu.css.

import { reducedMotion } from "../a11y";
import { h } from "../dom";
import { type IconName, icon } from "../icons";

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
const STEP_DEG = 20;
const SIN_STEP = Math.sin((STEP_DEG * Math.PI) / 180);
/** Options turned past this from the front are on the far side of the cylinder and not drawn. */
const FRONT_DEG = 90;
/** Neighbours never fade below this opacity, so their text keeps WCAG AA contrast (the depth is the tilt and the curve). */
const OPACITY_FLOOR = 0.65;
/** Wheel travel that rolls one option. */
const WHEEL_STEP_PX = 50;
/** A pointer must move this far before it is a drag rather than a click. */
const DRAG_SLOP_PX = 6;
/** Stick deflection that counts as a press, and the delays before a held stick repeats. */
const STICK_DEAD = 0.6;
const STICK_FIRST_MS = 400;
const STICK_REPEAT_MS = 220;
const HINT_ID = "home-drum-hint";
const PITCH_FALLBACK_PX = 60;

/** Connected pads; WebKit has no `navigator.getGamepads`, so there are none. */
function pads(): (Gamepad | null)[] {
  return typeof navigator.getGamepads === "function" ? Array.from(navigator.getGamepads()) : [];
}

/** Signed distance on a ring of `n` options, in (-n/2, n/2]. */
function ringDelta(x: number, n: number): number {
  return x - n * Math.round(x / n);
}

function easeInOut(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

export function mountDrum(items: DrumItem[], label: string): Drum {
  const n = items.length;
  // `target` is the option at the front (unwrapped; the index is target mod n). `pos` is where the
  // drum is right now: equal to `target` at rest, fractional while it rolls or is dragged.
  let pos = 0;
  let target = 0;
  let anim: { from: number; to: number; t0: number; dur: number } | null = null;
  let pitch = PITCH_FALLBACK_PX;
  let radius = pitch / SIN_STEP;
  let half = 0;
  let frame = 0;
  let wheelAcc = 0;
  let drag: { id: number; y: number; pos: number; moved: boolean } | null = null;
  let suppressClick = false;
  let padLive = false;
  let padUp = false;
  let padDown = false;
  let padA = false;
  let stickDir = 0;
  let stickAt = 0;

  const index = (): number => ((target % n) + n) % n;
  const blocked = new Set<number>();

  /** Runs the front option, unless it is disabled. */
  function open(): void {
    if (!blocked.has(index())) items[index()].run();
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
          if (i === index()) open();
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

  /** Roll so option `i` is at the front, by the shorter way round. */
  function select(i: number): void {
    glide(target + ringDelta(i - index(), n));
  }

  function roll(step: number): void {
    glide(target + step);
  }

  /** Make the front option the selected one: the listbox, the options and the hint say so. */
  function announce(): void {
    const i = index();
    for (let k = 0; k < n; k += 1) opts[k].setAttribute("aria-selected", k === i ? "true" : "false");
    listbox.setAttribute("aria-activedescendant", opts[i].id);
    hint.textContent = items[i].hint;
  }

  function glide(to: number): void {
    const from = pos;
    target = to;
    announce();
    if (reducedMotion()) {
      anim = null;
      listbox.dataset.settled = "true";
      pos = to;
      render();
      return;
    }
    const steps = Math.min(4, Math.max(1, Math.round(Math.abs(to - from))));
    anim = { from, to, t0: performance.now(), dur: 120 + 70 * steps };
    listbox.dataset.settled = "false";
    kick();
  }

  /** Place every option for the current `pos`: the cylinder, turned to face the viewer. */
  function render(): void {
    for (let i = 0; i < n; i += 1) {
      const deg = ringDelta(i - pos, n) * STEP_DEG;
      const rad = (deg * Math.PI) / 180;
      const y = radius * Math.sin(rad);
      const style = opts[i].style;
      if (Math.abs(deg) >= FRONT_DEG || Math.abs(y) > half) {
        // Off the window: invisible and inert, but not display:none or visibility:hidden, so screen readers still list it.
        style.opacity = "0";
        style.pointerEvents = "none";
        continue;
      }
      const z = radius * (Math.cos(rad) - 1);
      const a = Math.abs(deg) / STEP_DEG;
      style.pointerEvents = "";
      style.transform = `translate3d(0, ${y.toFixed(2)}px, ${z.toFixed(2)}px) rotateX(${(-deg / 2).toFixed(2)}deg)`;
      style.opacity = Math.max(OPACITY_FLOOR, 1 - 0.3 * a).toFixed(3);
    }
  }

  function layout(): void {
    const p = parseFloat(getComputedStyle(listbox).getPropertyValue("--drum-pitch"));
    pitch = Number.isFinite(p) && p > 0 ? p : PITCH_FALLBACK_PX;
    radius = pitch / SIN_STEP;
    half = listbox.clientHeight / 2;
    render();
  }

  function kick(): void {
    if (!frame) frame = requestAnimationFrame(tick);
  }

  function tick(now: number): void {
    frame = 0;
    if (anim) {
      const t = Math.min(1, (now - anim.t0) / anim.dur);
      pos = t >= 1 ? anim.to : anim.from + (anim.to - anim.from) * easeInOut(t);
      if (t >= 1) {
        anim = null;
        listbox.dataset.settled = "true";
      }
      render();
    }
    if (padLive) pollPad(now);
    if (anim || padLive) kick();
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
      const y = pad.axes[1] ?? 0;
      if (y < -STICK_DEAD) stick = -1;
      else if (y > STICK_DEAD) stick = 1;
    }
    if (up && !padUp) roll(-1);
    if (down && !padDown) roll(1);
    padUp = up;
    padDown = down;
    if (a && !padA) open();
    padA = a;
    if (stick === 0) stickDir = 0;
    else if (stick !== stickDir) {
      roll(stick);
      stickDir = stick;
      stickAt = now + STICK_FIRST_MS;
    } else if (now >= stickAt) {
      roll(stick);
      stickAt = now + STICK_REPEAT_MS;
    }
  }

  const padConnection = (): void => {
    padLive = pads().some((pad) => pad !== null);
    if (padLive) kick();
  };

  // The listbox keys: up and down roll it; Home and End go to the ends; Enter or Space opens the front option.
  listbox.addEventListener("keydown", (e) => {
    switch (e.key) {
      case "ArrowDown":
        roll(1);
        break;
      case "ArrowUp":
        roll(-1);
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

  // Arrow keys with nothing focused (the page background) roll the drum and take focus.
  const onDocKey = (e: KeyboardEvent): void => {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    const active = document.activeElement;
    if (active && active !== document.body && active !== document.documentElement) return;
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    listbox.focus({ preventScroll: true });
    roll(e.key === "ArrowDown" ? 1 : -1);
  };
  document.addEventListener("keydown", onDocKey);

  // Wheel and trackpad: one option per WHEEL_STEP_PX of travel. The page does not scroll under it.
  listbox.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const px = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * window.innerHeight : e.deltaY;
      wheelAcc += px;
      if (Math.abs(wheelAcc) < WHEEL_STEP_PX) return;
      roll(wheelAcc > 0 ? 1 : -1);
      wheelAcc = 0;
    },
    { passive: false },
  );

  // Touch and mouse drag: the drum follows the pointer, then settles on the nearest option.
  listbox.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    suppressClick = false;
    drag = { id: e.pointerId, y: e.clientY, pos, moved: false };
  });
  listbox.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dy = e.clientY - drag.y;
    if (!drag.moved) {
      if (Math.abs(dy) < DRAG_SLOP_PX) return;
      drag.moved = true;
      anim = null;
      listbox.dataset.settled = "false";
      listbox.setPointerCapture(e.pointerId);
    }
    pos = drag.pos - dy / pitch;
    render();
  });
  const endDrag = (e: PointerEvent): void => {
    if (!drag || e.pointerId !== drag.id) return;
    const moved = drag.moved;
    drag = null;
    if (!moved) return;
    // The release of a drag is not a click on whatever is under the pointer.
    suppressClick = true;
    glide(Math.round(pos));
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
      anim = null;
      padLive = false;
      resizeObserver.disconnect();
      document.removeEventListener("keydown", onDocKey);
      window.removeEventListener("gamepadconnected", padConnection);
      window.removeEventListener("gamepaddisconnected", padConnection);
    },
  };
}
