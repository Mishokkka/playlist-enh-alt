import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { nativeClass, NativePlaylistSound, reset } from "./helpers/foundry-v13.mjs";
import { installAudioScheduler } from "../modules/audio-scheduler.js";

beforeEach(reset);

function fixture({ duration = 300, elapsed = 0, fade = 500, repeat = false, ...values } = {}) {
    globalThis.CONFIG = { PlaylistSound: { documentClass: NativePlaylistSound } };
    installAudioScheduler();
    const nodes = [];
    const context = {
        currentTime: 100, sampleRate: 48000,
        createConstantSource() {
            const source = {
                offset: { value: 1 }, onended: null, disconnected: false, starts: 0, stops: [],
                start(when) { this.starts++; this.started = when; },
                stop(when) { this.stops.push(when); this.ends = when; },
                disconnect() { this.disconnected = true; },
            };
            nodes.push(source);
            return source;
        },
    };
    const fades = []; const scheduled = []; const cancelled = [];
    const sound = Object.assign(new EventTarget(), {
        context, duration, currentTime: elapsed, playing: true, loop: repeat,
        fade: async (volume, options) => fades.push([volume, options]),
        stop: () => {},
        schedule(fn, time) { const handle = { fn, time }; scheduled.push(handle); return handle; },
        unschedule: (handle) => cancelled.push(handle),
    });
    const doc = new CONFIG.PlaylistSound.documentClass();
    Object.assign(doc, { sound, playing: true, repeat, volume: 0.5, parent: { fade, isOwner: false }, ...values });
    return { doc, sound, nodes, fades, scheduled, cancelled, context };
}

test("native v13 five-minute timer requests about 55 MiB of silent PCM", async (t) => {
    let bytes = 0;
    class AudioBuffer { constructor(options) { bytes += options.length * 4; } }
    class AudioBufferSourceNode { start() {} stop() {} }
    const AudioTimeout = nativeClass("client/audio/timeout.mjs", { AudioBuffer, AudioBufferSourceNode });
    const timer = new AudioTimeout(300_000, { context: { sampleRate: 48000 } });
    assert.equal(bytes, 57_600_000);
    timer.cancel();
    await timer.complete;
    t.diagnostic("Native AudioTimeout requested 57,600,000 bytes; the allocation was counted without allocating that memory in this test.");
});

test("replacement schedules the fade using one silent unconnected clock source", async () => {
    const { doc, context, nodes, fades, scheduled } = fixture();
    doc._scheduleFadeOut();
    assert.equal(nodes.length, 1);
    assert.equal(nodes[0].offset.value, 0);
    assert.equal(nodes[0].started, 100);
    assert.equal(nodes[0].ends, 399.5);
    assert.equal(scheduled.length, 0);
    context.currentTime = nodes[0].ends;
    nodes[0].onended();
    await Promise.resolve();
    assert.deepEqual(fades, [[0, { duration: 500 }]]);
    assert.equal(nodes[0].disconnected, true);
    assert.equal(nodes[0].onended, null);
});

test("zero fade does not schedule a timer or allocate an audio buffer", () => {
    const { doc, nodes, scheduled } = fixture({ fade: 0 });
    doc._scheduleFadeOut();
    assert.equal(nodes.length, 0);
    assert.equal(scheduled.length, 0);
});

test("looping tracks and unknown durations do not schedule end fades", () => {
    for (const options of [{ repeat: true }, { duration: Infinity }, { duration: undefined }]) {
        const { doc, nodes, scheduled } = fixture(options);
        if ("duration" in options) doc.sound.duration = options.duration;
        doc._scheduleFadeOut();
        assert.equal(nodes.length, 0);
        assert.equal(scheduled.length, 0);
    }
});

test("resumed tracks schedule against remaining playback time", () => {
    const { doc, nodes } = fixture({ elapsed: 120 });
    doc._scheduleFadeOut();
    assert.equal(nodes[0].ends, 279.5);
});

test("native half-track fade cap is preserved", () => {
    const { doc, nodes } = fixture({ duration: 10, fade: 50_000 });
    doc._scheduleFadeOut();
    assert.equal(doc.fadeDuration, 5000);
    assert.equal(nodes[0].ends, 105);
});

test("pause and stop cancel the pending fade before native playback sync", () => {
    const { doc, nodes, fades } = fixture();
    doc._scheduleFadeOut();
    const stale = nodes[0].onended;
    doc.playing = false;
    doc.sync();
    assert.equal(nodes[0].onended, null);
    assert.equal(nodes[0].disconnected, true);
    assert.equal(nodes[0].stops.at(-1), undefined);
    stale();
    assert.equal(fades.length, 0);
});

test("cancelling or replacing a timer cannot fade a newly resumed sound", () => {
    const { doc, nodes, fades } = fixture();
    doc._scheduleFadeOut();
    const stale = nodes[0].onended;
    doc._scheduleFadeOut();
    assert.equal(nodes[0].disconnected, true);
    assert.equal(nodes.length, 2);
    stale();
    assert.equal(fades.length, 0);
    nodes[1].onended();
    assert.equal(fades.length, 1);
});

test("native _cancelFadeOut remains callable by other audio modules", () => {
    const { doc, nodes, fades } = fixture();
    doc._scheduleFadeOut();
    const callback = nodes[0].onended;
    doc._cancelFadeOut(); doc._cancelFadeOut();
    callback();
    assert.equal(fades.length, 0);
    assert.equal(nodes[0].disconnected, true);
});

test("an already queued callback cannot fade a deleted or replaced audio source", () => {
    const { doc, nodes, fades } = fixture();
    doc._scheduleFadeOut();
    doc.sound = { playing: true };
    nodes[0].onended();
    assert.equal(fades.length, 0);
});

test("raw audio stop events also release the pending clock source", async () => {
    const { doc, sound, nodes } = fixture();
    doc._scheduleFadeOut();
    sound.dispatchEvent(new Event("stop"));
    assert.equal(nodes[0].onended, null);
    assert.equal(nodes[0].disconnected, true);
});

test("unsupported audio contexts fall back to the native cancellable scheduler", () => {
    const { doc, context, scheduled, cancelled } = fixture();
    delete context.createConstantSource;
    doc._scheduleFadeOut();
    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0].time, 299.5);
    doc._cancelFadeOut();
    assert.equal(cancelled.length, 1);
});

test("another module's custom scheduler is retained", () => {
    class Custom extends NativePlaylistSound { _scheduleFadeOut() {} }
    globalThis.CONFIG = { PlaylistSound: { documentClass: Custom } };
    const old = console.warn; console.warn = () => {};
    try { installAudioScheduler(); } finally { console.warn = old; }
    assert.equal(CONFIG.PlaylistSound.documentClass, Custom);
});

test("installer is idempotent and leaves v14 document classes alone", () => {
    fixture();
    const installed = CONFIG.PlaylistSound.documentClass;
    installAudioScheduler();
    assert.equal(CONFIG.PlaylistSound.documentClass, installed);
    game.release.generation = 14;
    CONFIG.PlaylistSound.documentClass = NativePlaylistSound;
    try { installAudioScheduler(); } finally { game.release.generation = 13; }
    assert.equal(CONFIG.PlaylistSound.documentClass, NativePlaylistSound);
});

test("client setting can retain the unmodified native scheduler", () => {
    const original = game.settings.get;
    CONFIG.PlaylistSound.documentClass = NativePlaylistSound;
    game.settings.get = () => false;
    try { installAudioScheduler(); } finally { game.settings.get = original; }
    assert.equal(CONFIG.PlaylistSound.documentClass, NativePlaylistSound);
});

test("a failed cancellation binding restores the source API and removes partial listeners before fallback", () => {
    const { doc, sound, scheduled, cancelled } = fixture();
    const original = sound.unscheduleAll = () => {};
    sound.addEventListener = function (name, callback) {
        if (name === "stop") throw new Error("Unsupported custom stop event");
        return EventTarget.prototype.addEventListener.call(this, name, callback);
    };
    const warn = console.warn; console.warn = () => {};
    try { doc._scheduleFadeOut(); } finally { console.warn = warn; }
    assert.equal(sound.unscheduleAll, original);
    assert.equal(scheduled.length, 1);
    sound.dispatchEvent(new Event("pause"));
    assert.equal(cancelled.length, 0, "partial listener survived fallback");
    doc._cancelFadeOut();
});
