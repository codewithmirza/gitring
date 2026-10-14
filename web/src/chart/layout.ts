/**
 * Chart layout: the repo as an archipelago.
 *   Island  = a top-level directory (root files form the "/" island).
 *   Parcel  = a file, laid out inside its island with a squarified treemap (d3-hierarchy),
 *             area by file size (sub-linear, so one large file does not drown the rest).
 * Islands are placed on an elliptical spiral with open water between them. The layout is
 * deterministic for a file list and memoized by its signature.
 */
import { hierarchy, treemap, treemapSquarify } from "d3-hierarchy";
import type { FileNode } from "../../../src/core/types";

/* ───────────── types ───────────── */

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface Parcel extends Rect {
  path: string;
  name: string;
  island: string;
  cx: number;
  cy: number;
  size: number;
  lang: string;
}

export interface Island extends Rect {
  id: string;
  label: string;
  parcels: Parcel[];
  bytes: number;
}

export interface ChartLayout {
  islands: Island[];
  parcels: Map<string, Parcel>;
  islandById: Map<string, Island>;
  bounds: Rect;
  rose: { x: number; y: number; r: number };
  signature: string;
}

/* ───────────── constants ───────────── */

const SCALE = 40; // world units² per weight unit
const GAP = 46; // open water between islands
const PAD = 8; // inner padding of an island
const LABEL = 24; // label band at the top of an island
const MARGIN = 44;

const weight = (size: number) => Math.max(320, size) ** 0.9;

/* ───────────── helpers ───────────── */

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

export function islandOf(path: string): string {
  const i = path.indexOf("/");
  return i === -1 ? "/" : path.slice(0, i);
}

interface TreeNode {
  name: string;
  path?: string;
  size?: number;
  lang?: string;
  children?: TreeNode[];
}

function buildTree(files: FileNode[], island: string): TreeNode {
  const root: TreeNode = { name: island, children: [] };
  for (const f of files) {
    const rel = island === "/" ? f.path : f.path.slice(island.length + 1);
    const parts = rel.split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      let next = node.children!.find((c) => c.name === parts[i] && c.children);
      if (!next) {
        next = { name: parts[i], children: [] };
        node.children!.push(next);
      }
      node = next;
    }
    node.children!.push({ name: parts[parts.length - 1], path: f.path, size: f.size, lang: f.lang });
  }
  return root;
}

const overlaps = (a: Rect, b: Rect, gap: number) =>
  a.x0 < b.x1 + gap && a.x1 + gap > b.x0 && a.y0 < b.y1 + gap && a.y1 + gap > b.y0;

/* ───────────── the layout ───────────── */

export function layoutChart(files: FileNode[]): ChartLayout {
  const groups = new Map<string, FileNode[]>();
  for (const f of files) {
    const id = islandOf(f.path);
    const list = groups.get(id) ?? [];
    list.push(f);
    groups.set(id, list);
  }

  type Pending = { id: string; files: FileNode[]; w: number; h: number; weight: number };
  const pending: Pending[] = [];
  for (const [id, list] of groups) {
    const wsum = list.reduce((s, f) => s + weight(f.size), 0);
    const area = wsum * SCALE;
    const ar = 1.2 + (hash(id) % 1000) / 1000 * 0.55;
    const iw = Math.sqrt(area * ar);
    const ih = area / iw;
    pending.push({ id, files: list, w: iw + PAD * 2, h: ih + PAD + LABEL, weight: wsum });
  }
  // Big code islands first; the root island and dot-directories (metadata) last.
  const rank = (p: Pending) => (p.id === "/" ? 1 : p.id.startsWith(".") ? 2 : 0);
  pending.sort((a, b) => rank(a) - rank(b) || b.weight - a.weight || a.id.localeCompare(b.id));

  const placed: (Rect & { id: string })[] = [];
  for (const p of pending) {
    if (!placed.length) {
      placed.push({ id: p.id, x0: -p.w / 2, y0: -p.h / 2, x1: p.w / 2, y1: p.h / 2 });
      continue;
    }
    const phase = ((hash(p.id) % 360) * Math.PI) / 180;
    let done = false;
    for (let i = 1; i < 20000 && !done; i++) {
      const theta = i * 0.045 + phase;
      const r = 4 * i * 0.045 * 6;
      const cx = Math.cos(theta) * r * 1.3;
      const cy = Math.sin(theta) * r * 0.92;
      const rect = { id: p.id, x0: cx - p.w / 2, y0: cy - p.h / 2, x1: cx + p.w / 2, y1: cy + p.h / 2 };
      if (!placed.some((q) => overlaps(rect, q, GAP))) {
        placed.push(rect);
        done = true;
      }
    }
    if (!done) {
      const maxX = Math.max(...placed.map((q) => q.x1));
      placed.push({ id: p.id, x0: maxX + GAP, y0: -p.h / 2, x1: maxX + GAP + p.w, y1: p.h / 2 });
    }
  }

  const islands: Island[] = [];
  const parcels = new Map<string, Parcel>();
  for (const rect of placed) {
    const p = pending.find((x) => x.id === rect.id)!;
    const iw = p.w - PAD * 2;
    const ih = p.h - PAD - LABEL;
    const root = hierarchy<TreeNode>(buildTree(p.files, p.id))
      .sum((d) => (d.path ? weight(d.size ?? 0) : 0))
      .sort((a, b) => (b.value ?? 0) - (a.value ?? 0) || a.data.name.localeCompare(b.data.name));
    const tm = treemap<TreeNode>().tile(treemapSquarify.ratio(1.25)).size([iw, ih]).paddingInner(3).paddingOuter(0).round(false);
    const laid = tm(root);
    const ox = rect.x0 + PAD;
    const oy = rect.y0 + LABEL;
    const list: Parcel[] = [];
    for (const leaf of laid.leaves()) {
      if (!leaf.data.path) continue;
      const parcel: Parcel = {
        path: leaf.data.path,
        name: leaf.data.name,
        island: p.id,
        x0: ox + leaf.x0,
        y0: oy + leaf.y0,
        x1: ox + leaf.x1,
        y1: oy + leaf.y1,
        cx: ox + (leaf.x0 + leaf.x1) / 2,
        cy: oy + (leaf.y0 + leaf.y1) / 2,
        size: leaf.data.size ?? 0,
        lang: leaf.data.lang ?? "text",
      };
      parcels.set(parcel.path, parcel);
      list.push(parcel);
    }
    islands.push({
      id: p.id,
      label: p.id === "/" ? "/ root" : `${p.id}/`,
      x0: rect.x0,
      y0: rect.y0,
      x1: rect.x1,
      y1: rect.y1,
      parcels: list,
      bytes: p.files.reduce((s, f) => s + f.size, 0),
    });
  }

  const bounds: Rect = islands.length
    ? {
        x0: Math.min(...islands.map((i) => i.x0)) - MARGIN,
        y0: Math.min(...islands.map((i) => i.y0)) - MARGIN,
        x1: Math.max(...islands.map((i) => i.x1)) + MARGIN,
        y1: Math.max(...islands.map((i) => i.y1)) + MARGIN,
      }
    : { x0: -400, y0: -260, x1: 400, y1: 260 };

  // Compass rose in open water: try the corners, else extend the chart to the right.
  const R = 46;
  // Prefer corners that the chart overlays do not cover (title block top-left, zoom bottom-right).
  const corners = [
    { x: bounds.x0 + R + 12, y: bounds.y1 - R - 12 },
    { x: bounds.x1 - R - 12, y: bounds.y0 + R + 12 },
    { x: bounds.x1 - R - 70, y: bounds.y1 - R - 12 },
    { x: bounds.x0 + R + 12, y: bounds.y0 + R + 12 },
  ];
  let rose = corners.find((c) => !islands.some((i) => overlaps({ x0: c.x - R, y0: c.y - R, x1: c.x + R, y1: c.y + R }, i, 18)));
  if (!rose) {
    bounds.x1 += R * 2 + 48;
    rose = { x: bounds.x1 - R - 24, y: bounds.y1 - R - 24 };
  }

  const signature = islands.map((i) => `${i.id}:${i.parcels.length}`).join("|");
  return { islands, parcels, islandById: new Map(islands.map((i) => [i.id, i])), bounds, rose: { ...rose, r: R }, signature };
}

/* ───────────── anchors ───────────── */

/** Where a file sits on the chart; files not on main yet sit at their island's label band. */
export function anchorOf(layout: ChartLayout, path: string): { x: number; y: number; onMain: boolean } | null {
  const p = layout.parcels.get(path);
  if (p) return { x: p.cx, y: p.cy, onMain: true };
  const island = layout.islandById.get(islandOf(path));
  if (island) return { x: island.x1 - 16, y: island.y0 + LABEL / 2, onMain: false };
  return null;
}
