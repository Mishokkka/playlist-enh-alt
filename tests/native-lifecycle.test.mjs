import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
    initializeNativePlayback, makePlaylist, replay, flush, AudioClock, AudioBuffer, Sound, PlaylistSound,
} from "./helpers/native-playback.mjs";
import { settings } from "./helpers/foundry-v13.mjs";

initializeNativePlayback();
const { installAudioScheduler } = await import("../modules/audio-scheduler.js");
const { installPlaybackLifecycle, withPlaybackOptions } = await import("../modules/playback-lifecycle.js");
const { EnchantedPlaylist } = await import("../modules/enchantedplaylist.js");
const { setupHooks } = await import("../modules/hooks.js");
setupHooks();
let clock;
beforeEach(() => {
    clock = initializeNativePlayback();
    installAudioScheduler();
    installPlaybackLifecycle();
});

const hasRamp = (clock, volume, time) => clock.ramps.some((event) =>
    event.kind === "linear" && event.value === volume && Math.abs(event.time - time) < 1e-8);
const activeClocks = (clock) => clock.nodes.filter((node) => node.offset && node.onended);

test("real Sound loading and callbacks apply one-shot fades without changing saved data or end fades", async () => {
    const outgoing = makePlaylist({ fade: 250 });
    await outgoing.playAll(); await clock.advance(1);
    const incoming = makePlaylist({ fade: 1500 });
    settings.fadeModifier = 800;
    globalThis.fromUuid = async () => incoming;
    const start = clock.currentTime;
    await EnchantedPlaylist.crossFade("incoming");
    assert.equal(incoming.fade, 1500);
    assert.equal(outgoing.fade, 250);
    assert.ok(hasRamp(clock, 0.5, start + 0.8), "incoming Sound did not receive the transient fade");
    assert.ok(hasRamp(clock, 0, start + 0.8), "outgoing Sound did not receive the transient fade");
    assert.equal(incoming.sounds.get("sound0").fadeDuration, 1500);
    assert.ok(activeClocks(clock).some((node) => node.ends === start + 300 - 1.5), "end fade was accidentally changed by the macro");
    assert.equal(incoming.transactions[0].changes.fade, undefined);
    assert.equal(incoming.transactions[0].options.playlistEnchantmentTransition.duration, 800);
});

test("a serialized update operation produces the same fade on a second client's native Sound", async () => {
    const local = makePlaylist({ id: "replicated", fade: 1200 });
    settings.fadeModifier = 600;
    globalThis.fromUuid = async () => local;
    await EnchantedPlaylist.crossFade("incoming");
    const message = local.transactions[0];
    const remoteClock = new AudioClock();
    const remote = makePlaylist({ id: "replicated", fade: 1200, context: remoteClock });
    await replay(remote, message.changes, message.options);
    assert.ok(remote.sounds.get("sound0").sound instanceof Sound);
    assert.ok(hasRamp(remoteClock, 0.5, 100.6));
    assert.equal(remote.fade, 1200);
    assert.equal(remote.sounds.get("sound0").fadeDuration, 1200);
});

test("core load waits for a pending fade-out before resuming the same Sound", async () => {
    const parent = makePlaylist({ fade: 200 });
    await parent.playAll(); await clock.advance(1);
    const source = parent.sounds.get("sound0").sound;
    await withPlaybackOptions(parent, { duration: 500 }, () => parent.stopAll());
    assert.equal(source._state, Sound.STATES.STOPPING);
    assert.equal(source.playing, false, "real v13 excludes STOPPING from playing");
    settings.fadeModifier = 800;
    globalThis.fromUuid = async () => parent;
    await EnchantedPlaylist.crossFade("resume");
    await clock.advance(0.5);
    await flush();
    assert.equal(source.playing, true);
    assert.equal(parent.sounds.get("sound0").sound, source);
    assert.ok(hasRamp(clock, 0.5, clock.currentTime + 0.8));
    assert.equal(parent.fade, 200);
});

test("a transition survives asynchronous audio loading, then returns to the saved fade", async () => {
    const originalCreate = game.audio.create;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    game.audio.create = (options) => {
        const source = originalCreate(options);
        const load = source._load;
        source._load = async function () { await gate; return load.call(this); };
        return source;
    };
    const parent = makePlaylist({ fade: 1500 });
    settings.fadeModifier = 900;
    globalThis.fromUuid = async () => parent;
    await EnchantedPlaylist.crossFade("delayed");
    assert.equal(parent.sounds.get("sound0").sound.loaded, false);
    release(); await flush();
    assert.ok(hasRamp(clock, 0.5, 100.9));
    assert.equal(parent.sounds.get("sound0").fadeDuration, 1500);
});

test("native unscheduleAll cancels both normal callbacks and the optimized fade timer", async () => {
    const parent = makePlaylist({ fade: 500 });
    await parent.playAll();
    const source = parent.sounds.get("sound0").sound;
    let fired = false;
    const scheduled = source.schedule(() => { fired = true; }, 10);
    const endTimer = activeClocks(clock)[0];
    source.unscheduleAll();
    await scheduled;
    assert.equal(endTimer.onended, null);
    await clock.advance(20);
    assert.equal(fired, false);
});

test("raw native Sound.pause cancels the optimized timer and play rearms it", async () => {
    const parent = makePlaylist({ fade: 500 });
    await parent.playAll(); await clock.advance(1);
    const source = parent.sounds.get("sound0").sound;
    const endTimer = activeClocks(clock)[0];
    source.pause();
    assert.equal(endTimer.onended, null);
    await source.play();
    assert.equal(activeClocks(clock).length, 1);
});

test("a previous native Sound's delayed stop cannot cancel the replacement Sound's timer", async () => {
    const parent = makePlaylist({ fade: 250 });
    await parent.playAll(); await clock.advance(1);
    const doc = parent.sounds.get("sound0");
    const previous = doc.sound;
    const stopping = previous.stop({ fade: 500 });
    await doc.update({ path: "replacement.ogg", playing: true });
    const replacement = doc.sound;
    assert.notEqual(replacement, previous);
    const newTimer = activeClocks(clock).at(-1);
    await clock.advance(0.5); await stopping; await flush();
    assert.equal(typeof newTimer.onended, "function");
    assert.equal(replacement.playing, true);
});

test("zero saved fade avoids long buffers while a macro still supplies its one-shot fade", async () => {
    const parent = makePlaylist({ fade: 0 });
    settings.fadeModifier = 750;
    globalThis.fromUuid = async () => parent;
    await EnchantedPlaylist.crossFade("incoming");
    assert.equal(activeClocks(clock).length, 0);
    assert.ok(hasRamp(clock, 0.5, 100.75));
    assert.ok(AudioBuffer.requestedBytes < 1_000_000, "a long AudioTimeout buffer was allocated");
    assert.equal(parent.fade, 0);
});

test("turning off timer optimization retains native audio scheduling and transient fades", async () => {
    clock = initializeNativePlayback();
    installPlaybackLifecycle();
    const parent = makePlaylist({ fade: 250 });
    settings.fadeModifier = 700;
    globalThis.fromUuid = async () => parent;
    await EnchantedPlaylist.crossFade("incoming");
    assert.ok(hasRamp(clock, 0.5, 100.7));
    assert.equal(parent.fade, 250);
    assert.ok(AudioBuffer.requestedBytes > 50_000_000, "native long timer was not exercised");
});

test("an outgoing transition is replicated through the native stop lifecycle on another client", async () => {
    const local = makePlaylist({ id: "outgoing", fade: 250 });
    await local.playAll(); await clock.advance(1);
    const initial = local.transactions[0];
    const remoteClock = new AudioClock();
    const remote = makePlaylist({ id: "outgoing", fade: 250, context: remoteClock });
    await replay(remote, initial.changes, initial.options);
    await remoteClock.advance(1);
    await withPlaybackOptions(local, { duration: 800 }, () => local.stopAll());
    const stop = local.transactions.at(-1);
    await replay(remote, stop.changes, stop.options);
    assert.ok(hasRamp(remoteClock, 0, 101.8));
    assert.equal(remote.sounds.get("sound0").sound._state, Sound.STATES.STOPPING);
    assert.equal(remote.fade, 250);
    await remoteClock.advance(0.8);
    assert.equal(remote.sounds.get("sound0").sound.playing, false);
});

test("simultaneous normalization preserves true silence on both clients' actual audio graphs", async () => {
    const local = makePlaylist({ id: "silent", mode: 2, count: 2 });
    settings.normalize = true; settings.normalizeModifier = 0; settings.fadeModifier = 500;
    globalThis.fromUuid = async () => local;
    await EnchantedPlaylist.crossFade("incoming");
    const remoteClock = new AudioClock();
    const remote = makePlaylist({ id: "silent", mode: 2, count: 2, context: remoteClock });
    const message = local.transactions[0];
    await replay(remote, message.changes, message.options);
    for (const parent of [local, remote]) {
        for (const doc of parent.sounds) {
            assert.equal(doc.volume, 0);
            assert.equal(doc.sound.volume, 0);
            assert.equal(doc.sound.playing, true);
        }
    }
    assert.ok(hasRamp(remoteClock, 0, 100.5));
});

test("concurrent commands on one playlist cannot exchange transient options or leave stale context", async () => {
    const parent = makePlaylist();
    let release; const gate = new Promise((resolve) => { release = resolve; });
    let firstStarted;
    const started = new Promise((resolve) => { firstStarted = resolve; });
    let secondStarted = false;
    const first = withPlaybackOptions(parent, { duration: 200 }, async () => {
        firstStarted(); await gate; return parent.playAll();
    });
    await started;
    const second = withPlaybackOptions(parent, { duration: 900 }, () => {
        secondStarted = true; return parent.stopAll();
    });
    await flush();
    assert.equal(secondStarted, false);
    release(); await Promise.all([first, second]);
    assert.equal(parent.transactions[0].options.playlistEnchantmentTransition.duration, 200);
    assert.equal(parent.transactions[1].options.playlistEnchantmentTransition.duration, 900);
    await parent.playAll();
    assert.equal(parent.transactions[2].options.playlistEnchantmentTransition, undefined);
});

test("failed public playback releases transient options and does not block the next command", async () => {
    const parent = makePlaylist();
    await assert.rejects(withPlaybackOptions(parent, { duration: 200 }, async () => { throw new Error("veto"); }), /veto/);
    await withPlaybackOptions(parent, { duration: 900 }, () => parent.playAll());
    assert.equal(parent.transactions[0].options.playlistEnchantmentTransition.duration, 900);
});

test("a superseded file finishing its load cannot play or consume the new file's transition", async () => {
    const create = game.audio.create;
    let finishOld; let finishNew;
    const oldGate = new Promise((resolve) => { finishOld = resolve; });
    const newGate = new Promise((resolve) => { finishNew = resolve; });
    game.audio.create = (options) => {
        const sound = create(options);
        const load = sound._load;
        sound._load = async function () {
            await (this.src === "replacement.ogg" ? newGate : oldGate);
            return load.call(this);
        };
        return sound;
    };
    const parent = makePlaylist({ fade: 1500 });
    const doc = parent.sounds.get("sound0");
    settings.fadeModifier = 500; globalThis.fromUuid = async () => parent;
    await EnchantedPlaylist.crossFade("old");
    const oldSource = doc.sound;
    await parent.stopAll();
    await doc.update({ path: "replacement.ogg" });
    settings.fadeModifier = 900;
    await EnchantedPlaylist.crossFade("new");
    const newSource = doc.sound;
    finishOld(); await flush();
    assert.equal(oldSource.sourceNode, undefined, "obsolete file retained a connected playback source");
    assert.equal(oldSource._state, Sound.STATES.STOPPED, "stop inside the play event raced core's play operation");
    assert.equal(newSource.loaded, false);
    finishNew(); await flush();
    assert.ok(hasRamp(clock, 0.5, 100.9), "the old play event consumed the new transition");
    assert.equal(newSource.playing, true);
    assert.equal(doc.fadeDuration, 1500);
    let completed = false;
    parent._onSoundEnd = () => { completed = true; };
    doc._onEnd({ target: oldSource });
    assert.equal(completed, false, "obsolete end event advanced the replacement track");
});

test("an asynchronous playback wrapper retains the transition until its native start handler completes", async () => {
    const nativeStart = PlaylistSound.prototype._onStart;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    PlaylistSound.prototype._onStart = async function (event) { await gate; return nativeStart.call(this, event); };
    try {
        const parent = makePlaylist({ fade: 1500 });
        settings.fadeModifier = 800; globalThis.fromUuid = async () => parent;
        await EnchantedPlaylist.crossFade("incoming");
        const doc = parent.sounds.get("sound0");
        assert.equal(doc.fadeDuration, 800, "transition was discarded while a wrapper was still starting playback");
        release(); await flush();
        const ramps = clock.ramps.filter((event) => event.kind === "linear");
        assert.equal(ramps.at(-1).time, 100.8);
        assert.equal(doc.fadeDuration, 1500);
        assert.ok(activeClocks(clock).some((node) => node.ends === 398.5));
    } finally { release(); await flush(); PlaylistSound.prototype._onStart = nativeStart; }
});
