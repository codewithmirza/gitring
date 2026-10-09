// One stylesheet for every page.
export const css = `
* { box-sizing: border-box; }
body {
  margin: 0;
  font: 16px/1.5 Georgia, "Times New Roman", serif;
  background: #fbfaf7;
  color: #1f2933;
}
.masthead {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 24px;
  align-items: baseline;
  padding: 20px 24px;
  border-bottom: 1px solid #e3e0d8;
}
.brand { font-size: 22px; color: #1f2933; text-decoration: none; }
.tagline { margin: 0; color: #5f6b76; font-style: italic; }
.nav { margin-left: auto; display: flex; gap: 16px; }
.nav a { color: #24577a; }
.shelf {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
  gap: 16px;
  padding: 24px;
}
.book { border: 1px solid #e3e0d8; border-radius: 6px; padding: 16px; background: #fff; }
.book-title { font-size: 18px; line-height: 1.3; margin: 0 0 4px; }
.book-author { margin: 0; color: #5f6b76; }
.book-price { margin: 12px 0 0; font-weight: 600; }
.prose { max-width: 60ch; padding: 24px; }
.colophon { padding: 20px 24px; color: #5f6b76; border-top: 1px solid #e3e0d8; }
`;
