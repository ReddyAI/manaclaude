/**
 * A tiny XML reader for provider reports (IBKR Flex). Workers have no DOMParser,
 * and these documents are flat: elements with attributes, nested a few levels,
 * no mixed content. Returns a tree of { name, attrs, children, text }.
 */

export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e.startsWith('#x') || e.startsWith('#X'))
      return String.fromCodePoint(parseInt(e.slice(2), 16));
    if (e.startsWith('#')) return String.fromCodePoint(parseInt(e.slice(1), 10));
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

export class XmlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XmlError';
  }
}

export function parseXml(source: string): XmlNode {
  const root: XmlNode = { name: '#document', attrs: {}, children: [], text: '' };
  const stack: XmlNode[] = [root];
  const tag =
    /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/([A-Za-z_][\w:.-]*)\s*>|<([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  const attr = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = tag.exec(source)) !== null) {
    const top = stack[stack.length - 1] as XmlNode;
    if (m[1] !== undefined) {
      top.text += m[1];
    } else if (m[2] !== undefined) {
      if (stack.length === 1 || top.name !== m[2]) throw new XmlError(`unexpected </${m[2]}>`);
      stack.pop();
    } else if (m[3] !== undefined) {
      const node: XmlNode = { name: m[3], attrs: {}, children: [], text: '' };
      let a: RegExpExecArray | null;
      attr.lastIndex = 0;
      while ((a = attr.exec(m[4] ?? '')) !== null)
        node.attrs[a[1] as string] = decodeEntities((a[2] ?? a[3]) as string);
      top.children.push(node);
      if (m[5] !== '/') stack.push(node);
    } else if (m[6] !== undefined && m[6].trim() !== '') {
      top.text += decodeEntities(m[6]);
    }
  }
  if (stack.length !== 1)
    throw new XmlError(`unclosed <${(stack[stack.length - 1] as XmlNode).name}>`);
  if (root.children.length === 0) throw new XmlError('empty document');
  return root.children[0] as XmlNode;
}

/** All descendants with this element name. */
export function findAll(node: XmlNode, name: string): XmlNode[] {
  const out: XmlNode[] = [];
  const walk = (n: XmlNode): void => {
    for (const c of n.children) {
      if (c.name === name) out.push(c);
      walk(c);
    }
  };
  walk(node);
  return out;
}

export function firstText(node: XmlNode, name: string): string | undefined {
  const found = findAll(node, name)[0];
  return found ? found.text.trim() : undefined;
}
