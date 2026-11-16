// Map documents as files and as the editor's autosaved draft. A document is
// the map JSON the sim reads; the engine validates it when it is tested or
// encoded, so this module only checks the outer shape.

import { type Obj, LIST_KEYS, asObj } from "./schema";
import { DRAFT_KEY } from "../storage-keys";


/** Check the outer shape of a map and keep every other key and the key order. */
export function normalise(value: unknown): Obj {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("The map is not a JSON object");
  const src = value as Obj;
  for (const key of LIST_KEYS) {
    const v = src[key];
    if (v === undefined) continue;
    if (!Array.isArray(v) || v.some((x) => x === null || typeof x !== "object" || Array.isArray(x))) {
      throw new Error(`"${key}" must be a list of objects`);
    }
  }
  const set = src.set;
  if (set !== undefined && (set === null || typeof set !== "object" || Array.isArray(set))) {
    throw new Error('"set" must be an object');
  }
  return { ...src, set: asObj(set) };
}

/** Parse map JSON text (a file or the engine's decoded map) into a document. */
export function parseMap(text: string): Obj {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("That is not valid JSON");
  }
  return normalise(value);
}

/** The document as file text. Parsing it back with `parseMap` gives the same document. */
export function mapText(doc: Obj): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/** The saved draft, or null when there is none or it cannot be read. */
export function loadDraft(): Obj | null {
  try {
    const text = localStorage.getItem(DRAFT_KEY);
    return text === null ? null : parseMap(text);
  } catch {
    return null;
  }
}

/** Save the document as the draft. Returns false when storage is full or unavailable. */
export function saveDraft(doc: Obj): boolean {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(doc));
    return true;
  } catch {
    return false;
  }
}

export function clearDraft(): void {
  try {
    localStorage.removeItem(DRAFT_KEY);
  } catch {
    // Storage unavailable: nothing was saved.
  }
}

export function downloadMap(doc: Obj): void {
  const url = URL.createObjectURL(new Blob([mapText(doc)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = "neobox-map.json";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function readMapFile(file: File): Promise<Obj> {
  return parseMap(await file.text());
}
