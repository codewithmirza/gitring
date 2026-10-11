import { formatPrice } from "./price.js";

export function cartTotal(items) {
  return formatPrice(items.reduce((sum, item) => sum + item.cents, 0));
}
