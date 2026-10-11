/** Offline checks for the actual Panorama image transport, with a fake clock. */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const rootDir = path.resolve(__dirname, "..");
const sourcePath = path.join(rootDir, "mod", "panorama", "scripts", "dlchat.js");
const source = fs.readFileSync(sourcePath, "utf8");
const bootTail = '\ttry { $.Schedule(0.3, boot); } catch (e) {}\n})();';
assert.strictEqual(source.split(bootTail).length, 2, "Cannot identify the boot tail");
const instrumented = source.replace(bootTail,
  '\tglobalThis.__imageIpcTest = { bus: bus, channel: channel, imageChannel: imageChannel, boot: boot };\n})();');

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function packLzss(bytes) {
  const output = [], literals = [];
  function flush() {
    if (literals.length) { output.push(literals.length - 1, ...literals); literals.length = 0; }
  }
  for (let at = 0; at < bytes.length;) {
    let best = 0, distance = 0;
    for (let before = Math.max(0, at - 4096); before < at; before++) {
      let length = 0;
      while (length < 130 && at + length < bytes.length && bytes[before + length] === bytes[at + length]) length++;
      if (length > best && length >= 3) { best = length; distance = at - before; }
    }
    if (best >= 3) { flush(); output.push(0x80 | (best - 3), distance & 255, distance >>> 8); at += best; }
    else { literals.push(bytes[at++]); if (literals.length === 128) flush(); }
  }
  flush();
  return Buffer.from(output);
}

function frame(id, result, changes = {}) {
  const raw = Buffer.from(JSON.stringify({ id: changes.id || id, result }), "utf8");
  const packed = packLzss(raw);
  const header = Buffer.alloc(12);
  header.write("TYI1", 0, "ascii");
  header.writeUInt16LE(packed.length, 4);
  header.writeUInt16LE(raw.length, 6);
  header.writeUInt32LE((crc32(raw) ^ (changes.corruptCrc ? 1 : 0)) >>> 0, 8);
  return Buffer.concat([header, packed]);
}

class Clock {
  constructor() { this.time = 1000; this.queue = []; this.sequence = 0; }
  schedule(seconds, fn) { this.queue.push({ at: this.time + seconds, order: this.sequence++, fn }); }
  runUntil(done, limit = 180) {
    const deadline = this.time + limit;
    for (let iterations = 0; iterations < 100000; iterations++) {
      if (done()) return;
      this.queue.sort((a, b) => a.at - b.at || a.order - b.order);
      const task = this.queue.shift();
      if (!task || task.at > deadline) break;
      this.time = task.at;
      task.fn();
    }
    assert(done(), "Fake clock exhausted before the operation settled");
  }
  advance(seconds) { let done = false; this.schedule(seconds, () => { done = true; }); this.runUntil(() => done, seconds + 1); }
}

class FakeServer {
  constructor(clock, options = {}) { this.clock = clock; this.options = options; this.jobs = new Map(); this.requests = []; this.firstId = null; }
  request(url, complete) {
    const parsed = new URL(url), query = parsed.searchParams;
    this.requests.push({ time: this.clock.time, path: parsed.pathname, query: Object.fromEntries(query), url });
    if (parsed.pathname.endsWith("probe.png")) { complete({ width: 17, height: 29 }); return; }
    const id = query.get("id");
    if (!this.firstId) this.firstId = id;
    if (parsed.pathname.endsWith("start.png")) {
      let job = this.jobs.get(id);
      if (!job) {
        const op = query.get("op"), payload = JSON.parse(query.get("d") || "{}");
        const result = op === "health" ? { ok: true, provider: "offline-image-test" }
          : op === "settings" ? { ok: true, marker: payload.marker || "settings" }
            : { ok: true, translation: payload.text || "推进中路，keep pushing 👋" };
        job = { id, op, payload, result, starts: 0, rounds: 0 };
        this.jobs.set(id, job);
      }
      job.starts++;
      if (this.options.blackholeFirst && id === this.firstId) return;
      complete({ width: 1, height: 1 }); return;
    }
    if (parsed.pathname.endsWith("read.png")) {
      const job = this.jobs.get(id);
      assert(job, "read.png must reference a submitted job");
      const part = Number(query.get("part"));
      assert(Number.isInteger(part) && part >= 0, "Invalid PNG part index");
      if (part === 0) job.rounds++;
      const first = id === this.firstId;
      if (first && this.options.failOnce && !job.failed) { job.failed = true; complete({ failed: true }); return; }
      if (first && this.options.failManyData && job.rounds <= 1 && part >= 6 && part < 14) {
        job.parallelFailures = (job.parallelFailures || 0) + 1; complete({ failed: true }); return;
      }
      const changes = { id: first && this.options.wrongId ? "old-unrelated-job" : id,
        corruptCrc: first && (this.options.corruptAlways || (this.options.corruptOnce && job.rounds <= 1)) };
      const bytes = first && this.options.replayOldFrame
        ? frame("prior-completed-job-17", { ok: true, translation: "old cached success" })
        : frame(id, job.result, changes);
      const offset = part * 2;
      if (offset >= bytes.length + 1) { job.outOfRange = (job.outOfRange || 0) + 1; complete({ failed: true }); return; }
      complete({ width: (bytes[offset] || 0) + 1, height: (bytes[offset + 1] || 0) + 1 }); return;
    }
    throw new Error("Unexpected network route: " + parsed.pathname);
  }
}

function makeSurface(clock, server, options = {}, sharedHud) {
  const serial = options.serial || 1, handlers = new WeakMap(), messages = [], created = [];
  function panel(type, parent, id) {
    const attrs = {}, classes = new Set();
    const value = { id, type, visible: true, text: "", style: {}, Children: [], _parent: parent, _deleted: false,
      contentwidth: type === "Image" ? 0 : 1280, contentheight: type === "Image" ? 0 : 720,
      desiredlayoutwidth: type === "Image" ? 0 : 1280, desiredlayoutheight: type === "Image" ? 0 : 720,
      actuallayoutwidth: type === "Image" ? 0 : 1280, actuallayoutheight: type === "Image" ? 0 : 720,
      actualuiscale_x: options.scale || 1, actualuiscale_y: options.scale || 1,
      IsValid() { return !this._deleted; }, IsVisible() { return this.visible; }, GetParent() { return this._parent; },
      GetChildCount() { return this.Children.length; }, GetChild(index) { return this.Children[index] || null; },
      FindChildTraverse(wanted) { for (const child of this.Children) { if (child.id === wanted) return child; const nested = child.FindChildTraverse(wanted); if (nested) return nested; } return null; },
      FindChildrenWithClassTraverse(wanted) { let found = []; for (const child of this.Children) { if (child.HasClass(wanted)) found.push(child); found = found.concat(child.FindChildrenWithClassTraverse(wanted)); } return found; },
      GetAttributeString(name, fallback) { return Object.hasOwn(attrs, name) ? attrs[name] : fallback; }, SetAttributeString(name, text) { attrs[name] = text; },
      SetHasClass(name, on) { if (on) classes.add(name); else classes.delete(name); }, AddClass(name) { classes.add(name); }, RemoveClass(name) { classes.delete(name); }, HasClass(name) { return classes.has(name); }, BHasClass(name) { return classes.has(name); },
      SetPanelEvent() {}, SetFocus() {}, ApplyStyles() {}, GetWidth() { return this.actuallayoutwidth; }, GetHeight() { return this.actuallayoutheight; },
      SetParent(next) { if (this._parent) this._parent.Children = this._parent.Children.filter(x => x !== this); this._parent = next; next.Children.push(this); },
      DeleteAsync() { this._deleted = true; },
      SetURL() { throw new Error("Image mode must not navigate the HTML panel"); },
      SetImage(url) {
        if (!url || url.startsWith("s2r://")) return;
        const generation = this._generation = (this._generation || 0) + 1;
        server.request(url, response => {
          const delay = typeof options.loadDelay === "function" ? options.loadDelay(url) : (options.loadDelay || 0.01);
          clock.schedule(delay, () => {
            if (this._deleted) return;
            const current = this._generation === generation;
            function emit(name) { const map = handlers.get(value) || {}; for (const callback of map[name] || []) callback(value, { width: response.width, height: response.height, url }); }
            if (response.failed) { emit("ImageFailedLoad"); return; }
            if (current) clock.schedule(options.layoutDelay === undefined ? 0.2 : options.layoutDelay, () => {
              if (this._generation !== generation || this._deleted) return;
              const w = /^\d+px$/.test(this.style.width || "") ? parseInt(this.style.width, 10) : response.width;
              const h = /^\d+px$/.test(this.style.height || "") ? parseInt(this.style.height, 10) : response.height;
              this.contentwidth = this.desiredlayoutwidth = this.actuallayoutwidth = w;
              this.contentheight = this.desiredlayoutheight = this.actuallayoutheight = h;
            });
            emit("ImageLoaded");
            if (options.lateDuplicate) clock.schedule(0.6, () => emit("ImageLoaded"));
          });
        });
      },
    };
    if (parent) parent.Children.push(value);
    return value;
  }
  const hud = sharedHud || panel("Panel", null, "HUD");
  const contextPanel = panel("Panel", hud, options.scope === "bubble" ? "CitadelHudTopBarChat" : "CitadelChat");
  contextPanel.visible = !options.closedChat;
  if (options.scope !== "bubble") panel("TextEntry", contextPanel, "ChatInput");
  else panel("Panel", contextPanel, "Messages");
  panel("HTML", contextPanel, "DLChatBridge");
  panel("Label", contextPanel, "DLChatStatus"); panel("Panel", contextPanel, "DLChatDot");
  const $ = { GetContextPanel: () => contextPanel, Schedule: (seconds, fn) => clock.schedule(seconds, fn), Msg: text => messages.push(String(text)),
    CreatePanel(type, parent, id) { const existing = parent.Children.find(x => x.id === id && !x._deleted); if (existing) return existing; const value = panel(type, parent, id); created.push(value); return value; },
    RegisterEventHandler(name, target, fn) { let map = handlers.get(target); if (!map) { map = {}; handlers.set(target, map); } (map[name] ||= []).push(fn); },
    RegisterForUnhandledEvent() {}, AsyncWebRequest() { throw new Error("AsyncWebRequest has been removed"); }, DispatchEvent() {},
  };
  const math = Object.create(Math); math.random = () => serial / 10;
  const context = { $, Math: math, Date: { now: () => Math.round(clock.time * 1000) }, JSON, String, Number, encodeURIComponent, decodeURIComponent };
  vm.createContext(context); vm.runInContext(instrumented, context, { filename: sourcePath });
  const state = context.__imageIpcTest;
  state.channel.mode = "image";
  return { state, hud, contextPanel, created, messages };
}

function send(surface, op, payload, timeout = 20) {
  const result = { done: false, count: 0, value: null };
  surface.state.bus.send(op, payload, timeout, value => { result.count++; result.done = true; result.value = value; });
  return result;
}

const checks = [];
function check(name, test) { test(); checks.push(name); }
if (process.argv.includes("--prepare")) { console.log("image_ipc_check: fake-clock/PNG framing harness prepared"); process.exit(0); }

check("Python golden frames decode with the real JavaScript codec", () => {
  const clock = new Clock(), server = new FakeServer(clock), surface = makeSurface(clock, server);
  const golden = [
    { id: "g1", translation: "hello", wire: "545949313700360045324760357b226964223a226731222c22726573756c74223a7b226f6b223a747275652c227472616e736c6174696f6e223a2268656c6c6f227d7d" },
    { id: "g2", translation: "你好，世界🌍", wire: "5459493145004400859d80fc437b226964223a226732222c22726573756c74223a7b226f6b223a747275652c227472616e736c6174696f6e223a22e4bda0e5a5bdefbc8ce4b896e7958cf09f8c8d227d7d" },
    { id: "g3", translation: "abc".repeat(48), wire: "545949313c00c100a1974f0a307b226964223a226733222c22726573756c74223a7b226f6b223a747275652c227472616e736c6174696f6e223a22616263ff030088030002227d7d" },
  ];
  for (const item of golden) {
    const bytes = Buffer.from(item.wire, "hex"), packedLength = bytes.readUInt16LE(4), rawLength = bytes.readUInt16LE(6);
    assert.strictEqual(bytes.length, 12 + packedLength);
    const raw = surface.state.imageChannel.unpack(Array.from(bytes.subarray(12)), rawLength);
    assert.strictEqual(surface.state.imageChannel.crc32(raw), bytes.readUInt32LE(8));
    assert.deepStrictEqual(JSON.parse(Buffer.from(raw).toString("utf8")), { id: item.id, result: { ok: true, translation: item.translation } });
  }
});

check("early zero layout and UTF-8/LZSS round-trip", () => {
  const clock = new Clock(), server = new FakeServer(clock), surface = makeSurface(clock, server);
  const text = "推进中路，keep pushing 👋 " + "中路推进 ".repeat(12);
  const pending = send(surface, "translate", { text });
  clock.runUntil(() => pending.done);
  assert(pending.value.ok, JSON.stringify(pending.value)); assert.strictEqual(pending.value.translation, text); assert.strictEqual(pending.count, 1);
  assert(surface.created.filter(x => x.type === "Image").length <= 18, "Image pool must remain bounded");
  const reads = server.requests.filter(x => x.path.endsWith("read.png"));
  assert(reads.every(x => x.query.nonce), "Every image read needs a cache-busting nonce");
  assert.strictEqual(new Set(reads.map(x => x.query.nonce)).size, reads.length, "Image read nonces must be unique");
});
check("delayed and duplicate ImageLoaded events", () => {
  const clock = new Clock(), server = new FakeServer(clock), surface = makeSurface(clock, server, { lateDuplicate: true, loadDelay: url => url.includes("part=1&") ? 0.4 : 0.01 });
  const pending = send(surface, "translate", { text: "晚到的图片事件" }); clock.runUntil(() => pending.done);
  clock.advance(2);
  assert(pending.value.ok, JSON.stringify(pending.value)); assert.strictEqual(pending.value.translation, "晚到的图片事件"); assert.strictEqual(pending.count, 1);
});
check("400 ms layout publication with old nonzero dimensions recovers", () => {
  const clock = new Clock(), server = new FakeServer(clock), surface = makeSurface(clock, server, { layoutDelay: 0.4 });
  const pending = send(surface, "translate", { text: "慢布局保留旧尺寸 " + "abcd".repeat(12) });
  clock.runUntil(() => pending.done);
  assert(pending.value.ok, JSON.stringify(pending.value));
  assert.strictEqual(pending.value.translation, "慢布局保留旧尺寸 " + "abcd".repeat(12));
  assert(surface.state.imageChannel.layoutGrace >= 0.6, "Slow geometry should activate the longer read grace");
  assert.strictEqual(server.jobs.size, 1); assert.strictEqual(pending.count, 1);
});
check("wrong response id cannot become success", () => {
  const clock = new Clock(), server = new FakeServer(clock, { wrongId: true }), surface = makeSurface(clock, server);
  const bad = send(surface, "translate", { text: "first" }), next = send(surface, "settings", { marker: "next" });
  clock.runUntil(() => bad.done && next.done); assert(!bad.value.ok); assert(next.value.ok, JSON.stringify(next.value)); assert.strictEqual(next.value.marker, "next");
  assert(server.jobs.get(server.firstId).starts <= 2, "Retry budget must be bounded");
});
check("a complete valid old frame cannot impersonate the current job", () => {
  const clock = new Clock(), server = new FakeServer(clock, { replayOldFrame: true }), surface = makeSurface(clock, server);
  const stale = send(surface, "translate", { text: "new result" }), next = send(surface, "settings", { marker: "after-old-frame" });
  clock.runUntil(() => stale.done && next.done);
  assert(!stale.value.ok); assert.strictEqual(stale.value.error, "image_bad_identity");
  assert.strictEqual(next.value.marker, "after-old-frame"); assert.strictEqual(stale.count, 1);
  assert.strictEqual(server.jobs.get(server.firstId).rounds, 2, "An old frame may be retried only once");
});
check("parallel packet failures trigger one full-frame retry", () => {
  const clock = new Clock(), server = new FakeServer(clock, { failManyData: true }), surface = makeSurface(clock, server);
  const pending = send(surface, "translate", { text: "parallel-data-failures-abcdefghijk".repeat(3) });
  clock.runUntil(() => pending.done);
  assert(pending.value.ok, JSON.stringify(pending.value));
  const job = server.jobs.get(server.firstId);
  assert(job.parallelFailures >= 8, "The fixture must fail multiple concurrent packets");
  assert.strictEqual(job.rounds, 2, "Concurrent failures must share the single retry budget");
  assert.strictEqual(job.starts, 1, "Frame retries must not execute the operation again");
  assert.strictEqual(pending.count, 1);
});
for (const mode of ["corruptOnce", "failOnce"]) check(mode + " retry preserves the same job", () => {
  const clock = new Clock(), server = new FakeServer(clock, { [mode]: true }), surface = makeSurface(clock, server);
  const pending = send(surface, "translate", { text: "重试同一条" }); clock.runUntil(() => pending.done);
  assert(pending.value.ok, JSON.stringify(pending.value)); assert.strictEqual(pending.value.translation, "重试同一条"); assert.strictEqual(server.jobs.size, 1);
  assert(server.jobs.get(server.firstId).starts <= 2);
});
check("persistent CRC failure settles and releases queue", () => {
  const clock = new Clock(), server = new FakeServer(clock, { corruptAlways: true }), surface = makeSurface(clock, server);
  const bad = send(surface, "translate", { text: "bad" }), next = send(surface, "settings", { marker: "after-crc" });
  clock.runUntil(() => bad.done && next.done); assert(!bad.value.ok); assert.strictEqual(next.value.marker, "after-crc");
  assert(server.jobs.get(server.firstId).starts <= 2);
});
check("long request timeout releases queue", () => {
  const clock = new Clock(), server = new FakeServer(clock, { blackholeFirst: true }), surface = makeSurface(clock, server);
  const bad = send(surface, "health", null, 1), next = send(surface, "settings", { marker: "after-timeout" });
  clock.runUntil(() => bad.done && next.done); assert(!bad.value.ok); assert.strictEqual(next.value.marker, "after-timeout"); assert.strictEqual(bad.count, 1);
});
check("two script contexts have isolated request ids", () => {
  const clock = new Clock(), server = new FakeServer(clock), chat = makeSurface(clock, server, { serial: 1 }), bubble = makeSurface(clock, server, { serial: 2, scope: "bubble" }, chat.hud);
  const a = send(chat, "translate", { text: "chat-result" }), b = send(bubble, "translate", { text: "bubble-result" });
  clock.runUntil(() => a.done && b.done); assert.strictEqual(a.value.translation, "chat-result"); assert.strictEqual(b.value.translation, "bubble-result"); assert.strictEqual(server.jobs.size, 2);
});
check("closed chat uses a visible ancestor", () => {
  const clock = new Clock(), server = new FakeServer(clock), surface = makeSurface(clock, server, { closedChat: true });
  const pending = send(surface, "health", null); clock.runUntil(() => pending.done); assert(pending.value.ok, JSON.stringify(pending.value));
  const images = surface.created.filter(x => x.type === "Image");
  assert(images.length); for (const image of images) { for (let node = image; node; node = node.GetParent()) assert(node.visible !== false, "Transport image is under a closed chat panel"); }
});
check("pool stays bounded across repeated jobs and a fractional UI scale", () => {
  const clock = new Clock(), server = new FakeServer(clock), surface = makeSurface(clock, server, { scale: 0.4444444477558136 });
  for (let index = 0; index < 8; index++) {
    const pending = send(surface, "translate", { text: "pool-job-" + index }); clock.runUntil(() => pending.done);
    assert.strictEqual(pending.value.translation, "pool-job-" + index, JSON.stringify(pending.value));
  }
  assert(surface.created.filter(x => x.type === "Image").length <= 18, "Repeated jobs must reuse the fixed image pool");
});
console.log("image_ipc_check: " + checks.length + " checks passed\n" + checks.map(x => "  ✓ " + x).join("\n"));
