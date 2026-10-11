// Used as: node --import ./bench/register.mjs bench/coordination.ts
import { register } from "node:module";

register("./ts-resolve.mjs", import.meta.url);
