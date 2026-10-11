// SPDX-License-Identifier: GPL-3.0-or-later
export interface PreviewField { key: string; text: string }
const fields = new Set(['term', 'meaning', 'explanation', 'example', 'translation', 'text', 'transcript']);

/** Read display fields from a JSON prefix without treating a prefix as validated output. */
export function previewFields(input: string): PreviewField[] {
  const result: PreviewField[] = [];
  let key: string | undefined;
  const suppressed: boolean[] = [];
  for (let cursor = 0; cursor < input.length;) {
    if (input[cursor] !== '"') {
      const char = input[cursor];
      if (char === '{' || char === '[') suppressed.push(!!suppressed.at(-1) || key === 'words' || key === 'wordAnchors');
      else if (char === '}' || char === ']') suppressed.pop();
      if (!/\s|:/.test(char)) key = undefined;
      ++cursor; continue;
    }
    ++cursor;
    let text = '';
    let complete = false;
    while (cursor < input.length) {
      const char = input[cursor++];
      if (char === '"') { complete = true; break; }
      if (char !== '\\') { text += char; continue; }
      if (cursor >= input.length) break;
      const escape = input[cursor++];
      if (escape === 'u') {
        const hex = input.slice(cursor, cursor + 4);
        if (!/^[\da-f]{4}$/i.test(hex)) break;
        text += String.fromCharCode(parseInt(hex, 16)); cursor += 4;
      } else {
        const decoded: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' };
        if (!(escape in decoded)) break;
        text += decoded[escape];
      }
    }
    let next = cursor;
    while (/\s/.test(input[next] ?? '') && next < input.length) ++next;
    if (complete && input[next] === ':') { key = text; cursor = next + 1; continue; }
    if (key && fields.has(key) && !suppressed.at(-1)) {
      // A chunk may end between UTF-16 surrogate halves, including JSON escapes.
      text = text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
      if (text) result.push({ key, text });
    }
    key = undefined;
    if (!complete) break;
  }
  return result;
}
