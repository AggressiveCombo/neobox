// Checks one capture record against client/qa/thresholds.json. Returns the list of failures
// (empty when the capture passes). A record with `error` fails on that error alone.

import { readFileSync } from "node:fs";

export const THRESHOLDS = JSON.parse(readFileSync(new URL("./thresholds.json", import.meta.url), "utf8"));

export function validateRecord(record, thresholds = THRESHOLDS) {
  if (record.error) return [`error: ${record.error}`];
  const failures = [];
  for (const [key, rule] of Object.entries(thresholds)) {
    if (rule.skipFit && record.fit) continue;
    const value = record.metrics[key];
    if (value === undefined || value === null) continue;
    if (rule.max !== undefined && value > rule.max) failures.push(`${key}=${value} (max ${rule.max})`);
    if (rule.min !== undefined && value < rule.min) failures.push(`${key}=${value} (min ${rule.min})`);
  }
  return failures;
}
