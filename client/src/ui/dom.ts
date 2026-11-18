// Tiny DOM builder: h("button", { class: "x", onclick: fn, disabled: true }, "label", child).
// Null, undefined and false props are skipped; `on<event>` props add listeners;
// `value`/`checked` set properties (for live form state); other values become attributes.

export type Child = Node | string | number | false | null | undefined | readonly Child[];
export type Props = Record<string, string | number | boolean | EventListener | null | undefined>;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props | null = null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) setProp(el, k, v);
  }
  append(el, children);
  return el;
}

function setProp(el: HTMLElement, k: string, v: Props[string]): void {
  if (v === null || v === undefined || v === false) return;
  if (typeof v === "function") {
    el.addEventListener(k.replace(/^on/, ""), v);
    return;
  }
  if (k === "class") {
    el.className = String(v);
    return;
  }
  if (k === "value" && (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement)) {
    el.value = String(v);
    return;
  }
  if (k === "checked" && el instanceof HTMLInputElement) {
    el.checked = v === true;
    return;
  }
  el.setAttribute(k, v === true ? "" : String(v));
}

function append(el: Node, children: readonly Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else if (typeof c === "string" || typeof c === "number") el.appendChild(document.createTextNode(String(c)));
    else el.appendChild(c as Node);
  }
}

/** Remove all children of a node. */
export function clear(el: Element): void {
  el.replaceChildren();
}

/**
 * A control's content with labels that swap in place (Invite / Link copied, Pause clip / Play clip). The states share one
 * grid cell, so the control is as wide as its widest state and nothing beside it moves. The inactive state is hidden with
 * visibility, so it keeps its space and is out of the accessibility tree. `active` is the state shown first.
 */
export function labelSwap(states: readonly (readonly Child[])[], active = 0): HTMLSpanElement {
  const el = h("span", { class: "label-swap" }, ...states.map((children) => h("span", { class: "label-swap-state" }, ...children)));
  showLabel(el, active);
  return el;
}

/** Shows state `index` of a labelSwap element; the others keep their space. */
export function showLabel(swap: Element, index: number): void {
  [...swap.children].forEach((child, i) => child.classList.toggle("label-swap-off", i !== index));
}
