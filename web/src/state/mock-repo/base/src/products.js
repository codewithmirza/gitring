// The shelf. Prices are integer cents, in pounds sterling.
export const books = [
  {
    id: "tidewater-almanac",
    title: "Tidewater Almanac",
    author: "Ines Calloway",
    cents: 1899,
  },
  {
    id: "notes-from-the-marsh",
    title: "Notes from the Marsh",
    author: "Tomas Reed",
    cents: 1450,
  },
  {
    id: "the-quiet-harbour",
    title: "The Quiet Harbour",
    author: "Hana Moreau",
    cents: 2200,
  },
  {
    id: "estuary-birds",
    title: "A Field Guide to Estuary Birds",
    author: "Priya Natarajan",
    cents: 2650,
  },
  {
    id: "charts-and-currents",
    title: "Charts and Currents",
    author: "Olu Adebayo",
    cents: 1999,
  },
  {
    id: "winter-on-the-mudflats",
    title: "Winter on the Mudflats",
    author: "Signe Larsen",
    cents: 1275,
  },
];

export function formatPrice(cents) {
  return "£" + (cents / 100).toFixed(2);
}
