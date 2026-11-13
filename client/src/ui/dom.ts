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
