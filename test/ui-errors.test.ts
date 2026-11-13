import './setup';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../src/public/index.html', import.meta.url), 'utf8');
const start = html.indexOf('function renderNotice(');
const end = html.indexOf('\n      }', start) + 8;
class Element {
  children: Element[] = []; attrs: Record<string,string> = {}; listeners: Record<string, () => void> = {};
  textContent = ''; removed = false;
  constructor(readonly tag: string) {}
  appendChild(child: Element) { this.children.push(child); }
  setAttribute(key: string, value: string) { this.attrs[key] = value; }
  addEventListener(event: string, callback: () => void) { this.listeners[event] = callback; }
  remove() { this.removed = true; }
}
const sent: string[] = [];
const context = {
  document: { createElement: (tag: string) => new Element(tag) },
  lastMessage: 'Neon price?', send: (message: string) => sent.push(message),
};
const renderNotice = vm.runInNewContext('(' + html.slice(start, end) + ')', context);
const notice = renderNotice('Unable to answer', 'All models unavailable. Please retry.', true) as Element;
assert.equal(notice.attrs.role, 'alert');
const button = notice.children.find((c) => c.tag === 'button'); assert.ok(button);
assert.equal(button.textContent, 'Retry');
context.lastMessage = 'A later question';
button.listeners.click();
assert.equal(notice.removed, true); assert.deepEqual(sent, ['Neon price?']);
assert.match(html, /event === 'error'[\s\S]*?renderNotice\([\s\S]*?true,/);
assert.match(html, /event === 'citations'[\s\S]*?citationChecks = payload.checks/);
console.log('mock UI: error notice exposes Retry, resends failed question; citation updates render independently');
