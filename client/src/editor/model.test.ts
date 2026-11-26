// Run: bun test client/src/editor/model.test.ts
import { expect, test } from "bun:test";
import { addBody, addJoint, addMarker, circleShape, copyRefs, copyShapes, getList, pasteClipboard, pasteShapes } from "./model";
import { BODY, GRAPPLE, JOINT, SHAPE, emptyDoc, num } from "./schema";

test("copy and paste bodies remaps body IDs, joints, and grapples with offset", () => {
  let doc = emptyDoc();
  const a = addBody(doc, [circleShape(2, 0xff0000)], { x: 0, y: 0 });
  doc = a.doc;
  const b = addBody(doc, [circleShape(2, 0x00ff00)], { x: 10, y: 0 });
  doc = b.doc;
  const idA = num(getList(doc, "body")[a.index]!, BODY.id, -1);
  const idB = num(getList(doc, "body")[b.index]!, BODY.id, -1);
  // Joint linking A and B (not explicitly selected — should copy automatically with both bodies).
  doc = addJoint(doc, { body: idA, p: { x: 1, y: 0 } }, { body: idB, p: { x: -1, y: 0 } }, 0).doc;
  // Grapple attached to body A.
  const gp = addMarker(doc, "grapple", 2, 3);
  doc = gp.doc;
  getList(doc, "grapple")[gp.index]![GRAPPLE.body] = idA;

  const clip = copyRefs(doc, [
    { kind: "body", i: a.index },
    { kind: "body", i: b.index },
    { kind: "grapple", i: gp.index },
  ], 0);
  expect(clip).not.toBeNull();
  const pasted = pasteClipboard(doc, clip!, 5, -3, true);
  const bodies = getList(pasted.doc, "body");
  expect(bodies.length).toBe(4);
  const newIdA = num(bodies[2]!, BODY.id, -1);
  const newIdB = num(bodies[3]!, BODY.id, -1);
  expect(newIdA).not.toBe(idA);
  expect(newIdB).not.toBe(idB);
  expect(newIdA).not.toBe(newIdB);
  expect(num(bodies[2]!, BODY.x, 0)).toBe(5);
  expect(num(bodies[2]!, BODY.y, 0)).toBe(-3);

  const joints = getList(pasted.doc, "joint");
  expect(joints.length).toBe(2);
  expect(num(joints[1]!, JOINT.bodyA, -1)).toBe(newIdA);
  expect(num(joints[1]!, JOINT.bodyB, -1)).toBe(newIdB);

  const grapples = getList(pasted.doc, "grapple");
  expect(grapples.length).toBe(2);
  expect(num(grapples[1]!, GRAPPLE.body, -1)).toBe(newIdA);
  expect(num(grapples[1]!, GRAPPLE.x, 0)).toBe(7);
  expect(num(grapples[1]!, GRAPPLE.y, 0)).toBe(0);
});

test("copy and paste shapes inside a body and outside as a new body", () => {
  const made = addBody(emptyDoc(), [circleShape(2, 0xff0000)], { x: 4, y: 6 });
  const clip = copyShapes(made.doc, made.index, [0]);
  expect(clip).not.toBeNull();

  const inBody = pasteShapes(made.doc, made.index, clip!, 2, 1);
  expect(inBody.shapes).toEqual([1]);
  const shapes = (getList(inBody.doc, "body")[made.index]![BODY.shapes] as Record<string, unknown>[]);
  expect(shapes.length).toBe(2);
  expect(shapes[1]![SHAPE.x]).toBe(2);
  expect(shapes[1]![SHAPE.y]).toBe(1);

  const asBody = pasteClipboard(made.doc, clip!, 3, 4, true);
  expect(getList(asBody.doc, "body").length).toBe(2);
  expect(asBody.refs).toEqual([{ kind: "body", i: 1 }]);
});
