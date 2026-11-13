import './setup';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { renderCitedMarkdown } from '../src/public/markdown.js';

const html = readFileSync(new URL('../src/public/index.html', import.meta.url), 'utf8');
const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)![1];

// Resolve names lexically, including imports and browser globals, rather than
// maintaining a whitelist that would miss the next removed UI helper.
function unresolvedNames(code: string): string[] {
  const filename = fileURLToPath(new URL('../src/public/index.inline.js', import.meta.url));
  const options: ts.CompilerOptions = {
    allowJs: true, checkJs: true, noEmit: true, types: [],
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
  };
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (path, languageVersion, onError, shouldCreateNewSourceFile) => path === filename
    ? ts.createSourceFile(path, code, languageVersion, true, ts.ScriptKind.JS)
    : getSourceFile(path, languageVersion, onError, shouldCreateNewSourceFile);
  const program = ts.createProgram([filename], options, host);
  return program.getSemanticDiagnostics(program.getSourceFile(filename))
    .filter((d) => [2304, 2552, 2305, 2307].includes(d.code))
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
}
assert.deepEqual(unresolvedNames(script), [], 'UI names and imports must resolve');
assert.ok(unresolvedNames(script + '\nmissingUiHelper();').some((m) => m.includes('missingUiHelper')),
  'the regression check must reject an undefined function call');
console.log('UI static check: names/imports resolve; undefined-call negative control rejected');

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

const parsed = ts.createSourceFile('index.js', script, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
const decorator = parsed.statements.find((s) => ts.isFunctionDeclaration(s) && s.name?.text === 'decorateVerdicts');
assert.ok(decorator, 'the verdict decorator must be defined');
const decorateVerdicts = vm.runInNewContext('(' + decorator.getText(parsed) + ')');
const canned = `| Claim | Verdict | Evidence |
| --- | --- | --- |
| A | Changed | Official page |
| B | Unchanged | Official page |
| C | Could not verify | No evidence |
| D | Unverified | Rejected evidence |
| E | Changed | Unknown source [99] |`;
// A small DOM double exercises the actual rendered td text and classList API.
const cells = [...renderCitedMarkdown(canned, [], []).matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((match) => {
  const classes = new Set<string>();
  return { textContent: match[1].replace(/<[^>]*>/g, ''), classes,
    classList: { add: (...names: string[]) => names.forEach((name) => classes.add(name)) } };
});
assert.doesNotThrow(() => decorateVerdicts({ querySelectorAll: (selector: string) => {
  assert.equal(selector, 'td');
  return cells;
} }));
const verdicts = cells.filter((_, i) => i % 3 === 1);
assert.deepEqual(verdicts.map((cell) => cell.textContent), ['Changed', 'Unchanged', 'Could not verify', 'Unverified', 'Unverified']);
assert.deepEqual(verdicts.map((cell) => [...cell.classes]), [
  ['verdict', 'verdict-changed'], ['verdict', 'verdict-same'], ['verdict'], [], [],
]);
console.log('canned verdict DOM double: Changed=verdict verdict-changed; Unchanged=verdict verdict-same; Could not verify=verdict; Unverified=no classes; no ReferenceError');
