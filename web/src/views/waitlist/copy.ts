/**
 * The words of the waitlist pages in one place, so a test can check each sentence.
 * The test is test/web/waitlist-copy.test.ts: plain words, at most 20 words in a sentence, no "-ing" forms.
 */

export const LANDING = {
  title: "Many agents. One codebase.",
  lede: "gitring is a home for code that many agents change at the same time. It shows conflicts before the code exists.",
  join: "Join the waitlist",
  closed: "gitring is not open to the public yet.",
  videoTitle: "See it work",
  videoLabel: "Product video of gitring",
  videoMissing: "The product video is on its way.",
  closingTitle: "Join the waitlist",
  closingNote: "The plans, messages and records in the pictures are real output of npm run meet in the gitring repository.",
  footer: "gitring is built on Cloudflare.",
  builtBy: "Built by",
  author: "Mirza",
  authorX: "@m14z4",
  authorXLabel: "@m14z4 on X",
} as const;

export const JOIN = {
  title: "Join the waitlist",
  text: "Sign in so we know who you are. Then you pick the pack you would use.",
  google: "Continue with Google",
  github: "Continue with GitHub",
  keep: "gitring keeps your name and your email address. It never posts for you.",
  none: "This gitring has no Google or GitHub sign-in. Use a passkey.",
  back: "Back",
} as const;

export const INTEREST = {
  title: "Pick the pack you would use",
  lede: "These are planned prices. They can change before gitring opens.",
  free: "Nothing to pay. We only collect interest to learn what to build and charge. No card needed.",
  noteLabel: "Anything we should know? (optional)",
  notePlaceholder: "For example: how many agents you run, or what you would build.",
  submit: "Count me in",
  change: "Save my new choice",
  done: "Your interest is recorded.",
  next: "We will email you or reach out when gitring opens to the public.",
  changeAsk: "Change my choice",
  leave: "Take me off the waitlist",
  left: "You are off the waitlist. You can join again at any time.",
  pickFirst: "Pick one pack first.",
  planned: "Planned price",
  perMonth: "each month",
} as const;

export const SIGN_IN_ERRORS: Record<string, string> = {
  stopped: "You stopped the sign-in. Nothing changed.",
  expired: "The sign-in took too long. Try again.",
  taken: "This account belongs to another gitring account.",
  failed: "The sign-in did not finish. Try again.",
};
