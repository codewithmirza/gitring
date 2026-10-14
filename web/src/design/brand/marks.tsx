/**
 * The marks of the sign-in providers.
 * gitring uses them only on the "Continue with …" buttons and next to the provider name on the Account page.
 * It never uses one as its own mark, and it draws them smaller than the gitring name.
 */
import googleG from "./google-g.svg";

/*
 * GitHub mark ("mark-github", 16 px) from @primer/octicons 19.40.0, unchanged
 * (https://github.com/primer/octicons, build/svg/mark-github-16.svg).
 *
 * MIT License. Copyright (c) 2026 GitHub Inc.
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
 * associated documentation files (the "Software"), to deal in the Software without restriction,
 * including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense,
 * and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so,
 * subject to the following conditions: The above copyright notice and this permission notice shall be
 * included in all copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT
 * LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO
 * EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
 * IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR
 * THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 *
 * GitHub logo rules (https://github.com/logos): do not change the shape, the proportions or the color.
 * The mark is black on light buttons and white on dark buttons (the CSS sets fill to #000 or #fff).
 */
const GITHUB_MARK =
  "M6.766 11.328c-2.063-.25-3.516-1.734-3.516-3.656 0-.781.281-1.625.75-2.188-.203-.515-.172-1.609.063-2.062.625-.078 1.468.25 1.968.703.594-.187 1.219-.281 1.985-.281.765 0 1.39.094 1.953.265.484-.437 1.344-.765 1.969-.687.218.422.25 1.515.046 2.047.5.593.766 1.39.766 2.203 0 1.922-1.453 3.375-3.547 3.64.531.344.89 1.094.89 1.954v1.625c0 .468.391.734.86.547C13.781 14.359 16 11.53 16 8.03 16 3.61 12.406 0 7.984 0 3.563 0 0 3.61 0 8.031a7.88 7.88 0 0 0 5.172 7.422c.422.156.828-.125.828-.547v-1.25c-.219.094-.5.156-.75.156-1.031 0-1.64-.562-2.078-1.609-.172-.422-.36-.672-.719-.719-.187-.015-.25-.093-.25-.187 0-.188.313-.328.625-.328.453 0 .844.281 1.25.86.313.452.64.655 1.031.655s.641-.14 1-.5c.266-.265.47-.5.657-.656";

export function GitHubMark({ size = 18, className }: { size?: number; className?: string }) {
  return (
    <svg className={["brand-mark brand-mark--github", className].filter(Boolean).join(" ")} width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d={GITHUB_MARK} />
    </svg>
  );
}

/*
 * The standard-color Google "G" for custom sign-in buttons, from Google's branding assets
 * (https://developers.google.com/identity/branding-guidelines, signin-assets.zip). The file keeps the
 * official drawing; the button around it follows the light and dark button specs (see .provider-btn).
 * It loads as an image only when a sign-in button shows.
 */
export function GoogleG({ size = 18, className }: { size?: number; className?: string }) {
  return <img className={["brand-mark brand-mark--google", className].filter(Boolean).join(" ")} src={googleG} width={size} height={size} alt="" decoding="async" />;
}
