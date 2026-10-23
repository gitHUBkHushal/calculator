import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const currentHtml = readFileSync(resolve(root, 'index.html'), 'utf8');
// Keep the pre-change source pinned so these formula regressions remain reproducible after commit.
const originalHtml = execFileSync('git', ['show', '5828fc0:index.html'], { cwd: root, encoding: 'utf8' });
const currency = value => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);

class FakeElement {
  constructor(value = '') {
    this.value = value;
    this.textContent = '';
    this.hidden = false;
    this.required = false;
    this.attributes = {};
    this.listeners = {};
    this.classes = new Set();
    this.classList = {
      toggle: (name, force) => {
        const enabled = force ?? !this.classes.has(name);
        if (enabled) this.classes.add(name); else this.classes.delete(name);
        return enabled;
      },
      contains: name => this.classes.has(name)
    };
  }
  addEventListener(type, callback) { (this.listeners[type] ??= []).push(callback); }
  dispatch(type) { for (const callback of this.listeners[type] ?? []) callback({ target: this }); }
  setAttribute(name, value) { this.attributes[name] = value; }
  querySelector(selector) { return selector === 'input' ? this.input : null; }
  focus() {}
}

class FakeCard extends FakeElement {
  constructor() {
    super();
    this.className = '';
    this.nodes = Object.fromEntries([
      '.name', '.sender', '.amount', '.rate', '.start', '.end', '.months'
    ].map(selector => [selector, new FakeElement()]));
    this.nodes['.duration-mode'] = new FakeElement('dates');
    this.nodes['.remove-button'] = new FakeElement();
    this.nodes['.entry-number'] = new FakeElement();
    this.nodes['.duration-label'] = new FakeElement();
    this.nodes['.days'] = new FakeElement();
    this.nodes['.interest'] = new FakeElement();
    this.nodes['.total'] = new FakeElement();
    this.nodes['.validation-message'] = new FakeElement();
    this.fields = Object.fromEntries([
      '.amount-field', '.rate-field', '.start-field', '.end-field', '.month-fields'
    ].map(selector => [selector, new FakeElement()]));
    for (const [fieldSelector, inputSelector] of [
      ['.amount-field', '.amount'], ['.rate-field', '.rate'], ['.start-field', '.start'],
      ['.end-field', '.end'], ['.month-fields', '.months']
    ]) this.fields[fieldSelector].input = this.nodes[inputSelector];
  }
  querySelector(selector) {
    if (this.nodes[selector]) return this.nodes[selector];
    if (this.fields[selector]) return this.fields[selector];
    return null;
  }
  querySelectorAll(selector) {
    if (selector === 'input') return ['.name', '.sender', '.amount', '.rate', '.start', '.end', '.months'].map(key => this.nodes[key]);
    if (selector === '.date-fields') return [this.fields['.start-field'], this.fields['.end-field']];
    if (selector === '.copy-calculation,.entry-screenshot') return [];
    return [];
  }
  remove() { this.parent?.removeChild(this); }
}

class FakeEntries extends FakeElement {
  constructor() { super(); this.children = []; }
  appendChild(card) { card.parent = this; this.children.push(card); return card; }
  removeChild(card) { this.children = this.children.filter(entry => entry !== card); card.parent = null; }
  replaceChildren() { for (const card of this.children) card.parent = null; this.children = []; }
  querySelectorAll(selector) { return selector === '.entry-number' ? this.children.map(card => card.nodes['.entry-number']) : []; }
}

function createCalculator(html, registerServiceWorker = async () => ({})) {
  const entries = new FakeEntries();
  const elements = {
    entries,
    emptyState: new FakeElement(),
    addButton: new FakeElement(),
    clearButton: new FakeElement(),
    principalTotal: new FakeElement(),
    interestTotal: new FakeElement(),
    grandTotal: new FakeElement()
  };
  const document = {
    getElementById: id => elements[id],
    createElement: tag => tag === 'article' ? new FakeCard() : new FakeElement()
  };
  const windowListeners = {};
  const window = { confirm: () => true, addEventListener: (type, callback) => { windowListeners[type] = callback; } };
  const navigator = { serviceWorker: { register: registerServiceWorker } };
  const context = vm.createContext({ document, window, navigator });
  const script = html.match(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/i)?.[1];
  assert.ok(script, 'main app script exists');
  vm.runInContext(script, context, { filename: 'index.html#app-script' });
  return { context, entries, elements, windowListeners };
}

function addConfiguredEntry(app, { amount, rate, start = '', end = '', months = '', mode = 'dates' }) {
  app.context.addEntry();
  const card = app.entries.children.at(-1);
  card.nodes['.amount'].value = amount;
  card.nodes['.rate'].value = rate;
  card.nodes['.start'].value = start;
  card.nodes['.end'].value = end;
  card.nodes['.months'].value = months;
  if (mode === 'months') {
    card.nodes['.duration-mode'].value = 'months';
    card.nodes['.duration-mode'].dispatch('change');
  } else app.context.recalculate();
  return card;
}

function assertResult(app, card, { interest, total, principalTotal = null, interestTotal = null, grandTotal = null }) {
  if (interest !== undefined) assert.equal(card.nodes['.interest'].textContent, interest === null ? '—' : currency(interest));
  if (total !== undefined) assert.equal(card.nodes['.total'].textContent, total === null ? '—' : currency(total));
  if (principalTotal !== null) assert.equal(app.elements.principalTotal.textContent, currency(principalTotal));
  if (interestTotal !== null) assert.equal(app.elements.interestTotal.textContent, currency(interestTotal));
  if (grandTotal !== null) assert.equal(app.elements.grandTotal.textContent, currency(grandTotal));
}

const validFixtures = [
  { amount: '100000', rate: '12', months: '6', mode: 'months', interest: 6000, total: 106000 },
  { amount: '100000', rate: '12', months: '12', mode: 'months', interest: 12000, total: 112000 },
  { amount: '100000', rate: '12', start: '2026-01-01', end: '2026-01-31', interest: 100000 * 30 * 0.12 / 365 },
  { amount: '50000', rate: '10', months: '3', mode: 'months', interest: 1250, total: 51250 },
  { amount: '0', rate: '12', months: '6', mode: 'months', interest: 0, total: 0 },
  { amount: '100000', rate: '0', months: '6', mode: 'months', interest: 0, total: 100000 }
];

for (const [label, html] of [['original formulas', originalHtml], ['modified calculator', currentHtml]]) {
  test(`${label}: required calculation regressions`, async t => {
    for (const fixture of validFixtures) await t.test(`${fixture.mode === 'months' ? `${fixture.months} months` : '30 days'}: ${fixture.amount} at ${fixture.rate}%`, () => {
      const app = createCalculator(html);
      const card = addConfiguredEntry(app, fixture);
      const total = fixture.total ?? fixture.amount * 1 + fixture.interest;
      assertResult(app, card, { interest: fixture.interest, total });
    });
  });
}

test('modified calculator: equal dates are valid with zero days and zero interest', () => {
  const app = createCalculator(currentHtml);
  const card = addConfiguredEntry(app, { amount: '2500', rate: '12', start: '2026-01-01', end: '2026-01-01' });
  assert.equal(card.nodes['.days'].textContent, '0');
  assertResult(app, card, { interest: 0, total: 2500, principalTotal: 2500, interestTotal: 0, grandTotal: 2500 });
  assert.equal(card.nodes['.validation-message'].hidden, true);
});

test('modified calculator: missing, malformed, impossible, and reversed dates are rejected', () => {
  for (const dates of [
    { start: '', end: '' },
    { start: '2026-02-30', end: '2026-03-01' },
    { start: '2026-02-02', end: '2026-02-01' }
  ]) {
    const app = createCalculator(currentHtml);
    const card = addConfiguredEntry(app, { amount: '1000', rate: '10', ...dates });
    assertResult(app, card, { interest: null, total: null, principalTotal: 0, interestTotal: 0, grandTotal: 0 });
    assert.equal(card.nodes['.validation-message'].hidden, false);
    assert.equal(card.classList.contains('invalid'), true);
  }
});

test('modified calculator: negative and missing amounts or rates are rejected but zero is accepted', () => {
  for (const fixture of [
    { amount: '-1', rate: '10' }, { amount: '100', rate: '-1' },
    { amount: 'Infinity', rate: '10' }, { amount: '100', rate: 'NaN' },
    { amount: '', rate: '10' }, { amount: '100', rate: '' }
  ]) {
    const app = createCalculator(currentHtml);
    const card = addConfiguredEntry(app, { ...fixture, start: '2026-01-01', end: '2026-01-02' });
    assertResult(app, card, { interest: null, total: null, principalTotal: 0, interestTotal: 0, grandTotal: 0 });
    assert.equal(card.nodes['.validation-message'].hidden, false);
  }
});

test('modified calculator: only positive whole finite month values calculate', () => {
  for (const months of ['0', '-1', '1.5', 'Infinity', '']) {
    const app = createCalculator(currentHtml);
    const card = addConfiguredEntry(app, { amount: '1000', rate: '12', months, mode: 'months' });
    assertResult(app, card, { interest: null, total: null, principalTotal: 0, interestTotal: 0, grandTotal: 0 });
  }
  const app = createCalculator(currentHtml);
  const card = addConfiguredEntry(app, { amount: '1000', rate: '12', months: '1', mode: 'months' });
  assertResult(app, card, { interest: 10, total: 1010, principalTotal: 1000, interestTotal: 10, grandTotal: 1010 });
});

test('modified calculator: updates, valid-only totals, remove, and add preserve other entries', () => {
  const app = createCalculator(currentHtml);
  const first = addConfiguredEntry(app, { amount: '100000', rate: '12', months: '6', mode: 'months' });
  const second = addConfiguredEntry(app, { amount: '-5', rate: '10', months: '3', mode: 'months' });
  assertResult(app, first, { interest: 6000, total: 106000, principalTotal: 100000, interestTotal: 6000, grandTotal: 106000 });

  second.nodes['.amount'].value = '50000';
  second.nodes['.amount'].dispatch('input');
  assertResult(app, second, { interest: 1250, total: 51250, principalTotal: 150000, interestTotal: 7250, grandTotal: 157250 });

  first.nodes['.months'].value = '12';
  first.nodes['.months'].dispatch('change');
  assertResult(app, first, { interest: 12000, total: 112000, principalTotal: 150000, interestTotal: 13250, grandTotal: 163250 });

  const third = addConfiguredEntry(app, { amount: '100000', rate: '12', start: '2026-01-01', end: '2026-01-31' });
  assertResult(app, first, { interest: 12000, total: 112000, principalTotal: 250000, interestTotal: 14236.301369863013, grandTotal: 264236.301369863 });
  first.nodes['.rate'].value = '10';
  first.nodes['.rate'].dispatch('input');
  assertResult(app, first, { interest: 10000, total: 110000, principalTotal: 250000, interestTotal: 12236.301369863013, grandTotal: 262236.301369863 });
  third.nodes['.end'].value = '2026-02-02';
  third.nodes['.end'].dispatch('change');
  assertResult(app, third, { interest: 100000 * 32 * 0.12 / 365, total: 100000 + 100000 * 32 * 0.12 / 365, principalTotal: 250000, interestTotal: 10000 + 1250 + 100000 * 32 * 0.12 / 365, grandTotal: 250000 + 10000 + 1250 + 100000 * 32 * 0.12 / 365 });
  second.nodes['.remove-button'].dispatch('click');
  assert.equal(app.entries.children.length, 2);
  assert.equal(app.entries.children[0].nodes['.entry-number'].textContent, 1);
  assertResult(app, third, { interest: 100000 * 32 * 0.12 / 365, total: 100000 + 100000 * 32 * 0.12 / 365, principalTotal: 200000, interestTotal: 10000 + 100000 * 32 * 0.12 / 365, grandTotal: 210000 + 100000 * 32 * 0.12 / 365 });
});

test('modified calculator: overflowing dashboard totals exclude the entry that would overflow them', () => {
  const app = createCalculator(currentHtml);
  const first = addConfiguredEntry(app, { amount: '1e308', rate: '0', months: '1', mode: 'months' });
  const second = addConfiguredEntry(app, { amount: '1e308', rate: '0', months: '1', mode: 'months' });
  assert.equal(first.classList.contains('invalid'), false);
  assert.equal(second.classList.contains('invalid'), true);
  assertResult(app, second, { interest: null, total: null, principalTotal: 1e308, interestTotal: 0, grandTotal: 1e308 });
  assert.equal(second.nodes['.validation-message'].hidden, false);
  assert.equal(app.elements.principalTotal.textContent.includes('Infinity'), false);
});

test('copy and screenshot controls remain independent in the existing scripts', () => {
  assert.match(currentHtml, /const addCopyButton\s*=\s*card\s*=>/);
  assert.match(currentHtml, /className="entry-screenshot"/);
  assert.doesNotMatch(currentHtml, /querySelector\("\.copy-calculation"\)\?\.remove\(\)/);
});

test('screenshot script renders a PNG download while preserving the copy control', async () => {
  const scripts = [...currentHtml.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)].map(match => match[1]);
  const screenshotScript = scripts.at(-1);
  const downloads = [];
  const revokedUrls = [];
  const entries = { querySelectorAll: () => [card] };
  const copyButton = {};
  const head = { append: button => { card.screenshotButton = button; button.isConnected = true; } };
  const card = {
    screenshotButton: null,
    classList: { contains: () => false },
    querySelector(selector) {
      if (selector === '.entry-screenshot') return this.screenshotButton;
      if (selector === '.copy-calculation') return copyButton;
      if (selector === '.entry-head') return head;
      if (selector === '.entry-number') return { textContent: '3' };
      const values = {
        '.amount': { value: '100000' }, '.rate': { value: '12' },
        '.duration-mode': { value: 'months' }, '.months': { value: '6' },
        '.sender': { value: 'Asha' }, '.name': { value: 'Ravi' },
        '.days': { textContent: '6' }, '.interest': { textContent: '₹6,000.00' },
        '.total': { textContent: '₹1,06,000.00' }
      };
      return values[selector];
    }
  };
  class FakeButton {
    constructor() { this.listeners = {}; this.style = {}; this.isConnected = true; }
    addEventListener(type, callback) { this.listeners[type] = callback; }
    setAttribute() {}
  }
  const drawingContext = new Proxy({}, { get: (target, key) => target[key] ?? (() => {}) , set: (target, key, value) => { target[key] = value; return true; } });
  const canvas = {
    getContext: () => drawingContext,
    toBlob: callback => callback({ type: 'image/png' })
  };
  const anchors = [];
  const document = {
    body: { append: element => anchors.push(element) },
    getElementById: () => entries,
    querySelectorAll: () => [card],
    createElement(tag) {
      if (tag === 'button') return new FakeButton();
      if (tag === 'canvas') return canvas;
      if (tag === 'a') {
        const anchor = { click: () => downloads.push({ href: anchor.href, name: anchor.download }), remove() {} };
        return anchor;
      }
      throw new Error(`Unexpected element: ${tag}`);
    }
  };
  const URLApi = { createObjectURL: () => 'blob:test-image', revokeObjectURL: url => revokedUrls.push(url) };
  class FakeFile { constructor(parts, name, options) { this.parts = parts; this.name = name; this.type = options.type; } }
  class FakeMutationObserver { constructor(callback) { this.callback = callback; } observe() {} }
  const context = vm.createContext({ document, navigator: {}, URL: URLApi, File: FakeFile, MutationObserver: FakeMutationObserver, setTimeout: () => 1 });
  vm.runInContext(screenshotScript, context, { filename: 'index.html#screenshot-script' });
  assert.ok(card.screenshotButton);
  assert.ok(card.querySelector('.copy-calculation'));
  await card.screenshotButton.listeners.click();
  assert.deepEqual(downloads, [{ href: 'blob:test-image', name: 'interest-calculation-entry-3.png' }]);
  assert.equal(card.screenshotButton.textContent, 'Screenshot ready');
  assert.equal(card.screenshotButton.disabled, false);
  assert.deepEqual(revokedUrls, []);
});

test('service worker precaches only the scoped app shell and serves navigation from cache', async () => {
  const workerSource = readFileSync(resolve(root, 'sw.js'), 'utf8');
  const listeners = {};
  const cached = new Map();
  const opened = [];
  const caches = {
    open: async name => {
      opened.push(name);
      return {
        addAll: async urls => { for (const url of urls) cached.set(url, { url, cached: true }); },
        match: async url => cached.get(url) ?? null
      };
    },
    keys: async () => ['interest-calculator-shell-old', 'unrelated-cache', 'interest-calculator-shell-v2'],
    delete: async name => name !== 'unrelated-cache'
  };
  const deleted = [];
  caches.delete = async name => { deleted.push(name); return true; };
  let skippedWaiting = false, clientsClaimed = false;
  const self = {
    registration: { scope: 'https://example.test/calculator/' },
    clients: { claim: async () => { clientsClaimed = true; } },
    addEventListener: (name, callback) => { listeners[name] = callback; },
    skipWaiting: async () => { skippedWaiting = true; }
  };
  const context = vm.createContext({ self, caches, URL, Set, Response, fetch: async () => { throw new Error('offline'); } });
  vm.runInContext(workerSource, context, { filename: 'sw.js' });

  let installPromise;
  listeners.install({ waitUntil: promise => { installPromise = promise; } });
  await installPromise;
  assert.equal(skippedWaiting, true);
  assert.deepEqual([...cached.keys()], [
    'https://example.test/calculator/',
    'https://example.test/calculator/index.html',
    'https://example.test/calculator/manifest.webmanifest',
    'https://example.test/calculator/apple-touch-icon.png'
  ]);
  assert.ok(opened.every(name => name === 'interest-calculator-shell-v2'));

  let activatePromise;
  listeners.activate({ waitUntil: promise => { activatePromise = promise; } });
  await activatePromise;
  assert.deepEqual(deleted, ['interest-calculator-shell-old']);
  assert.equal(clientsClaimed, true);

  let navigationResponse;
  listeners.fetch({
    request: { method: 'GET', url: 'https://example.test/calculator/', mode: 'navigate' },
    respondWith: promise => { navigationResponse = promise; }
  });
  assert.equal((await navigationResponse).url, 'https://example.test/calculator/index.html');

  let arbitraryRequestIntercepted = false;
  listeners.fetch({
    request: { method: 'GET', url: 'https://example.test/calculator/user-input.json', mode: 'cors' },
    respondWith: () => { arbitraryRequestIntercepted = true; }
  });
  assert.equal(arbitraryRequestIntercepted, false);
});

test('service-worker installation failure removes its partial cache', async () => {
  const workerSource = readFileSync(resolve(root, 'sw.js'), 'utf8');
  const listeners = {};
  const deleted = [];
  const caches = {
    open: async () => ({ addAll: async () => { throw new Error('network unavailable'); } }),
    delete: async name => { deleted.push(name); return true; }
  };
  const self = {
    registration: { scope: 'https://example.test/calculator/' },
    clients: { claim: async () => {} },
    addEventListener: (name, callback) => { listeners[name] = callback; },
    skipWaiting: async () => {}
  };
  const context = vm.createContext({ self, caches, URL, Set, Response, fetch: async () => { throw new Error('offline'); } });
  vm.runInContext(workerSource, context, { filename: 'sw.js' });

  let installPromise;
  listeners.install({ waitUntil: promise => { installPromise = promise; } });
  await assert.rejects(installPromise, /network unavailable/);
  assert.deepEqual(deleted, ['interest-calculator-shell-v2']);
});

test('service-worker registration rejection is swallowed so the online page remains initialized', async () => {
  const app = createCalculator(currentHtml, () => Promise.reject(new Error('service workers unavailable')));
  assert.equal(typeof app.windowListeners.load, 'function');
  assert.doesNotThrow(() => app.windowListeners.load());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.elements.grandTotal.textContent, currency(0));
  assert.equal(app.entries.children.length, 0);
});
