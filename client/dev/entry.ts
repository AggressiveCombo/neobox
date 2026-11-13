// Dev-only entry: the real app with the fake engine (see dev/server.ts).
import { start } from "../src/app";
import { createFakeEngine } from "./fake-engine";

void start({ loadEngine: async () => createFakeEngine() });
