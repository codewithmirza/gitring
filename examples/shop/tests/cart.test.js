import { test, expect } from "../harness/test.js";
import { cartTotal } from "../src/cart.js";

test("adds up the cart", () => expect(cartTotal([{ cents: 500 }, { cents: 250 }])).toBe("$7.50"));
