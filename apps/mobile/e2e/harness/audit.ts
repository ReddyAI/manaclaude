import type { Locator, Page } from '@playwright/test';

/**
 * Layout, contrast and labelling checks run inside the page. Used by
 * audit.spec.ts (every screen and sheet, every look) and by the regular
 * suite for the screens block U fixed.
 */

export type FindingKind = 'overflow-x' | 'cut-off' | 'overlap' | 'contrast' | 'no-label';

export interface Finding {
  kind: FindingKind;
  /** Short text or label of the element, for a person to find it. */
  what: string;
  detail: string;
}

/**
 * Runs every check on the page, or inside `scope` (a sheet) when given.
 * Thresholds: WCAG AA (4.5:1, or 3:1 for large text and disabled controls
 * are skipped); overlap counts only when two text boxes share more than 4 px
 * in both directions.
 */
export async function auditPage(page: Page, scope?: Locator): Promise<Finding[]> {
  const handle = scope ? await scope.elementHandle() : null;
  return page.evaluate<Finding[], unknown>((arg) => {
    const root = arg as Element | null;
    const out: Finding[] = [];
    const base = root ?? document.body;
    const vw = window.innerWidth;

    const visible = (el: Element) => {
      const s = getComputedStyle(el);
      if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) === 0)
        return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const label = (el: Element) =>
      (el.getAttribute('aria-label') || el.textContent || el.getAttribute('data-testid') || '')
        .trim()
        .replace(/\s+/g, ' ')
        .slice(0, 60);
    const testIdOf = (el: Element | null) => {
      let e: Element | null = el;
      while (e && e !== document.body) {
        const id = e.getAttribute('data-testid');
        if (id) return id;
        e = e.parentElement;
      }
      return '';
    };
    const inScroller = (el: Element) => {
      let e = el.parentElement;
      while (e && e !== document.body) {
        const s = getComputedStyle(e);
        if (/(auto|scroll)/.test(s.overflowX) && e.scrollWidth > e.clientWidth + 1) return true;
        e = e.parentElement;
      }
      return false;
    };

    // Something else drawn on top at the element's centre (a fixed tab bar,
    // a row covering its own swipe actions): not visible, so not checked.
    const covered = (el: Element) => {
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      if (x < 0 || y < 0 || x >= vw || y >= window.innerHeight) return false;
      const top = document.elementFromPoint(x, y);
      return top !== null && !el.contains(top) && !top.contains(el);
    };

    // Text leaves: elements with their own non-blank text.
    const texts = [...base.querySelectorAll('*')].filter(
      (el) =>
        !(el instanceof SVGElement) &&
        [...el.childNodes].some((n) => n.nodeType === 3 && (n.textContent ?? '').trim() !== '') &&
        visible(el) &&
        !covered(el),
    );

    // 1. The page scrolls sideways.
    if (!root && document.documentElement.scrollWidth > vw + 1) {
      out.push({
        kind: 'overflow-x',
        what: 'page',
        detail: `content is ${document.documentElement.scrollWidth}px wide on a ${vw}px screen`,
      });
    }

    // 2. Text cut off: wider than its box without an ellipsis, or past the screen edge.
    for (const el of texts) {
      const s = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      const clamped = s.textOverflow === 'ellipsis' || s.webkitLineClamp !== 'none';
      if (!clamped && el.scrollWidth > el.clientWidth + 1 && s.overflowX !== 'visible') {
        out.push({
          kind: 'cut-off',
          what: label(el),
          detail: `text ${el.scrollWidth}px in a ${el.clientWidth}px box (${testIdOf(el)})`,
        });
      } else if ((r.right > vw + 1 || r.left < -1) && !inScroller(el)) {
        out.push({
          kind: 'cut-off',
          what: label(el),
          detail: `runs past the screen edge (${Math.round(r.left)} to ${Math.round(r.right)}) (${testIdOf(el)})`,
        });
      }
    }

    // 3. Text boxes on top of each other.
    const boxes = texts
      .filter((el) => !inScroller(el))
      .map((el) => ({ el, r: el.getBoundingClientRect() }));
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        const a = boxes[i]!;
        const b = boxes[j]!;
        if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
        const w = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
        const h = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
        if (w > 4 && h > 4) {
          out.push({
            kind: 'overlap',
            what: `${label(a.el)} / ${label(b.el)}`,
            detail: `${Math.round(w)}x${Math.round(h)}px shared (${testIdOf(a.el)} / ${testIdOf(b.el)})`,
          });
        }
      }
    }

    // 4. Contrast of text against what is behind it.
    type RGBA = [number, number, number, number];
    const parse = (c: string): RGBA => {
      const m = c.match(/rgba?\(([^)]+)\)/);
      if (!m) return [0, 0, 0, 0];
      const p = m[1]!.split(',').map((x) => Number(x.trim()));
      return [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0, p[3] ?? 1];
    };
    const over = (top: RGBA, under: RGBA): RGBA => {
      const a = top[3] + under[3] * (1 - top[3]);
      if (a === 0) return [0, 0, 0, 0];
      const mix = (i: number) => (top[i]! * top[3] + under[i]! * under[3] * (1 - top[3])) / a;
      return [mix(0), mix(1), mix(2), a];
    };
    const background = (el: Element): RGBA => {
      const layers: RGBA[] = [];
      let e: Element | null = el;
      while (e) {
        const c = parse(getComputedStyle(e).backgroundColor);
        if (c[3] > 0) {
          layers.push(c);
          if (c[3] >= 1) break;
        }
        e = e.parentElement;
      }
      let result: RGBA = parse(getComputedStyle(document.body).backgroundColor);
      if (result[3] === 0) result = [255, 255, 255, 1];
      for (let i = layers.length - 1; i >= 0; i -= 1) result = over(layers[i]!, result);
      return result;
    };
    const lum = (c: RGBA) => {
      const ch = (v: number) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * ch(c[0]) + 0.7152 * ch(c[1]) + 0.0722 * ch(c[2]);
    };
    for (const el of texts) {
      if (el.closest('[aria-disabled="true"],[disabled]')) continue;
      const s = getComputedStyle(el);
      const bg = background(el);
      const fg = over(parse(s.color), bg);
      const l1 = lum(fg);
      const l2 = lum(bg);
      const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      const size = parseFloat(s.fontSize);
      const bold = Number(s.fontWeight) >= 700;
      const need = size >= 24 || (bold && size >= 18.66) ? 3 : 4.5;
      if (ratio < need) {
        out.push({
          kind: 'contrast',
          what: label(el),
          detail: `${ratio.toFixed(2)}:1, needs ${need}:1 (${s.color} on rgb(${bg
            .slice(0, 3)
            .map(Math.round)
            .join(',')}), ${size}px) (${testIdOf(el)})`,
        });
      }
    }

    // 5. Buttons and other controls with no name a screen reader can read.
    const controls = base.querySelectorAll(
      '[role=button],[role=link],[role=radio],[role=checkbox],[role=switch],[role=tab],button,a[href],input,textarea',
    );
    for (const el of controls) {
      if (!visible(el)) continue;
      const name =
        el.getAttribute('aria-label') ||
        (el.getAttribute('aria-labelledby') &&
          document.getElementById(el.getAttribute('aria-labelledby')!)?.textContent) ||
        el.textContent ||
        el.getAttribute('placeholder') ||
        el.getAttribute('title') ||
        '';
      if (name.trim() === '') {
        out.push({
          kind: 'no-label',
          what: el.getAttribute('data-testid') || el.tagName.toLowerCase(),
          detail: `${el.getAttribute('role') ?? el.tagName.toLowerCase()} with no accessible name (${testIdOf(el)})`,
        });
      }
    }
    return out;
  }, handle);
}
