import { test, expect } from "../harness/test.js";
import { formatPrice } from "../src/price.js";

test("formats cents as dollars", () => expect(formatPrice(1999)).toBe("$19.99"));
