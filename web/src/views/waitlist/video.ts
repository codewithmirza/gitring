/** The product video: it plays when /media/gitring-product.mp4 exists, else a placeholder shows the poster. */
export const VIDEO_URL = "/media/gitring-product.mp4";
/** The poster of the playing video (a picture of the real product), and the drawing that shows when there is no video. */
export const POSTER_URL = "/media/gitring-product-poster.jpg";
export const PLACEHOLDER_URL = "/media/gitring-poster.svg";

/**
 * Does the file exist? The static assets answer unknown paths with the app page (status 200), so the answer
 * must have a video type. A failed request means no video.
 */
export async function videoExists(url = VIDEO_URL): Promise<boolean> {
  try {
    const res = await fetch(url, { method: "HEAD" });
    return res.ok && /^video\//i.test(res.headers.get("content-type") ?? "");
  } catch {
    return false;
  }
}
