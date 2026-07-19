import { cpSync } from "node:fs";

cpSync(new URL("../src/public/", import.meta.url), new URL("../dist/public/", import.meta.url), { recursive: true });
