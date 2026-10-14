/**
 * Registers the module hook of bench/ts-resolve.mjs, so that Node finds imports that have no file extension.
 * Used as: node --import ./bench/register.mjs bench/coordination.ts (npm run bench does this).
 * Never import it from other code. Read next: bench/ts-resolve.mjs, then bench/coordination.ts.
 */
import { register } from "node:module";

register("./ts-resolve.mjs", import.meta.url);
