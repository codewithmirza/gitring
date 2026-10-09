// The books on sale at Saltmarsh Books, and how to show their prices.
// Prices are in US cents. Keep one book on each line.

export const PRODUCTS = [
  { id: 1, title: "The Tidewater Almanac", author: "Mara Quill", cents: 1999, tags: ["nature", "reference"], staffPick: false },
  { id: 2, title: "Salt Marsh Sonnets", author: "Ines Calloway", cents: 1450, tags: ["poetry"], staffPick: false },
  { id: 3, title: "Birds of the Estuary", author: "Tomas Brandvold", cents: 2400, tags: ["nature", "birds"], staffPick: false },
  { id: 4, title: "The Lamplighter of Gull Rock", author: "Ada Penhallow", cents: 1699, tags: ["fiction"], staffPick: false },
  { id: 5, title: "Knots for Small Boats", author: "Wen Harlow", cents: 1250, tags: ["sailing", "how-to"], staffPick: false },
  { id: 6, title: "Fog over Marram Point", author: "Juniper Hale", cents: 1599, tags: ["mystery"], staffPick: false },
  { id: 7, title: "The Chartmaker's Apprentice", author: "Odile Marchetti", cents: 2199, tags: ["fiction", "maps"], staffPick: false },
  { id: 8, title: "A Small Book of Tides", author: "Sigrid Moss", cents: 999, tags: ["poetry", "nature"], staffPick: false },
];

export function formatPrice(cents) {
  return "$" + (cents / 100).toFixed(2);
}

// Books whose title or author contains the query. Case does not matter.
export function findProducts(query, list = PRODUCTS) {
  const needle = String(query ?? "").trim().toLowerCase();
  if (!needle) return list;
  return list.filter((book) => matchesQuery(book, needle));
}

function matchesQuery(book, needle) {
  return book.title.toLowerCase().includes(needle) || book.author.toLowerCase().includes(needle);
}
