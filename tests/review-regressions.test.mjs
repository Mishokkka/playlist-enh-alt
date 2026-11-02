import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import {
    nativeClass, NativePlaylistSound, playlist, reset, settings, picker, emit, Application,
} from "./helpers/foundry-v13.mjs";

const target = process.env.PE_REVIEW_TARGET
    ? pathToFileURL(resolve(process.env.PE_REVIEW_TARGET) + "/") : new URL("../", import.meta.url);
const { EnchantedPlaylist } = await import(new URL("modules/enchantedplaylist.js", target));
const { installAudioScheduler } = await import(new URL("modules/audio-scheduler.js", target));
const { setupHooks } = await import(new URL("modules/hooks.js", target));
const { EnchantmentPopup } = await import(new URL("modules/enchantmentpopup.js", target));
setupHooks();
beforeEach(reset);

test("crossfade must call the public playback and stop APIs used by other modules", async () => {
    const outgoing = playlist({ playing: true }); const incoming = playlist();
    let starts = 0; let stops = 0;
    const play = incoming.playAll; incoming.playAll = async function () { starts++; return play.call(this); };
    const stop = outgoing.stopAll; outgoing.stopAll = async function () { stops++; return stop.call(this); };
    globalThis.fromUuid = async () => incoming;
    await EnchantedPlaylist.crossFade("incoming");
    assert.equal(starts, 1, "playAll wrapper was bypassed");
    assert.equal(stops, 1, "stopAll cleanup wrapper was bypassed");
});

test("a failed incoming start must leave existing music running", async () => {
    const outgoing = playlist({ playing: true }); const incoming = playlist();
    incoming.update = async () => { throw new Error("Playback denied"); };
    globalThis.fromUuid = async () => incoming;
    await assert.rejects(EnchantedPlaylist.crossFade("incoming"), /denied/);
    assert.equal(outgoing.playing, true);
    assert.equal(outgoing.calls.length, 0);
});

test("a one-shot macro fade must not overwrite saved playlist fade settings", async () => {
    const outgoing = playlist({ playing: true, fade: 250 }); const incoming = playlist({ fade: 1500 });
    settings.alwaysFade = false; settings.fadeModifier = 800;
    globalThis.fromUuid = async () => incoming;
    await EnchantedPlaylist.crossFade("incoming");
    assert.equal(incoming.fade, 1500);
    assert.equal(outgoing.fade, 250);
});

test("resuming a partial simultaneous playlist must use its playSound wrapper", async () => {
    const group = playlist({ count: 3, mode: 2 });
    group.sounds.get("sound1").pausedTime = 25;
    let resumed;
    const play = group.playSound;
    group.playSound = async function (sound) { resumed = sound.id; return play.call(this, sound); };
    await EnchantedPlaylist._enchantStartAll.call(ui.playlists, {}, { closest: () => null });
    assert.equal(resumed, "sound1");
    assert.equal(group.sounds.get("sound0").playing, false);
    assert.equal(group.sounds.get("sound2").playing, false);
});

test("upload must distinguish file names which differ only by case", async () => {
    const target = playlist(); let uploads = 0;
    picker.browse = async () => ({ files: ["audio/battle.ogg"] });
    picker.upload = async () => { uploads++; return { path: "audio/BATTLE.ogg" }; };
    const node = { classList: { contains: () => true }, dataset: { entryId: target.id } };
    await EnchantedPlaylist.prototype.handleAudioFilesUpload.call(
        Object.create(EnchantedPlaylist.prototype), { target: { closest: () => node } }, [{ name: "BATTLE.ogg" }]
    );
    assert.equal(uploads, 1);
    assert.equal(target.created[0].path, "audio/BATTLE.ogg");
});

test("a literal percent-encoded file name is not the same asset as a space in its name", async () => {
    const target = playlist(); let uploads = 0;
    picker.browse = async () => ({ files: ["audio/song%20one.ogg"] });
    picker.upload = async () => { uploads++; return { path: "audio/song%2520one.ogg" }; };
    const node = { classList: { contains: () => true }, dataset: { entryId: target.id } };
    await EnchantedPlaylist.prototype.handleAudioFilesUpload.call(
        Object.create(EnchantedPlaylist.prototype), { target: { closest: () => node } }, [{ name: "song%20one.ogg" }]
    );
    assert.equal(uploads, 1);
    assert.equal(target.created[0].path, "audio/song%2520one.ogg");
});

test("two concurrent settings changes must both survive delayed persistence", async () => {
    const oldGet = game.settings.get; const oldSet = game.settings.set;
    let current = { ...settings };
    game.settings.get = () => current;
    game.settings.set = async (module, key, value) => { await Promise.resolve(); current = structuredClone(value); };
    try {
        const app = Object.create(EnchantedPlaylist.prototype);
        await Promise.all([
            app.updatePlaylistEnchantment({ normalize: true }),
            app.updatePlaylistEnchantment({ alwaysFade: true }),
        ]);
        assert.equal(current.normalize, true);
        assert.equal(current.alwaysFade, true);
    } finally { game.settings.get = oldGet; game.settings.set = oldSet; }
});

test("concurrent popup closes join the same lifecycle and retain ownership until teardown", async () => {
    const originalClose = Application.prototype.close;
    let finish;
    const gate = new Promise((resolve) => { finish = resolve; });
    Application.prototype.close = async function () { await gate; this.rendered = false; };
    const popup = new EnchantmentPopup("macro", "Music");
    ui.enchantmentPopup = popup;
    try {
        const first = popup.close({ animate: false });
        const second = popup.close({ animate: false });
        let secondFinished = false;
        second.then(() => { secondFinished = true; });
        await Promise.resolve(); await Promise.resolve();
        assert.equal(secondFinished, false, "second close resolved before native teardown");
        assert.equal(ui.enchantmentPopup, popup, "global ownership was released before teardown");
        finish(); await Promise.all([first, second]);
        assert.equal(ui.enchantmentPopup, null);
    } finally { finish(); await Promise.resolve(); Application.prototype.close = originalClose; }
});

function clockFixture() {
    CONFIG = globalThis.CONFIG = { PlaylistSound: { documentClass: NativePlaylistSound } };
    installAudioScheduler();
    const nodes = [];
    const context = { currentTime: 100, createConstantSource() {
        const node = { offset: { value: 0 }, onended: null, start() {}, stop() {}, disconnect() {} };
        nodes.push(node); return node;
    } };
    const doc = new CONFIG.PlaylistSound.documentClass();
    Object.assign(doc, { playing: true, repeat: false, parent: { fade: 500 }, volume: 0.5 });
    doc.sound = { context, duration: 300, currentTime: 0, playing: true, fade: async () => {} };
    return { doc, nodes, context };
}

test("a late stop event from the previous audio source must not cancel the new source's timer", async () => {
    const { doc, nodes } = clockFixture();
    const previous = doc.sound;
    doc._scheduleFadeOut();
    doc.sound = { ...previous };
    doc._scheduleFadeOut();
    await doc._onStop({ target: previous });
    assert.equal(typeof nodes[1].onended, "function");
    doc._cancelFadeOut();
});

test("Sound.unscheduleAll must also cancel the optimized end-of-track timer", () => {
    const { doc, nodes, context } = clockFixture();
    const Emitter = () => class {};
    const Sound = nativeClass("client/audio/sound.mjs", { EventEmitterMixin: Emitter, AudioTimeout: class {} });
    const source = new Sound("track.ogg", { context });
    Object.defineProperties(source, { duration: { value: 300 }, currentTime: { value: 0 }, playing: { value: true } });
    doc.sound = source;
    doc._scheduleFadeOut();
    source.unscheduleAll();
    assert.equal(nodes[0].onended, null);
    doc._cancelFadeOut();
});

test("an optimizer must not replace another module's wrapper installed on the native prototype", () => {
    const original = NativePlaylistSound.prototype._scheduleFadeOut;
    NativePlaylistSound.prototype._scheduleFadeOut = function () {};
    globalThis.CONFIG = { PlaylistSound: { documentClass: NativePlaylistSound } };
    const warn = console.warn; console.warn = () => {};
    try {
        installAudioScheduler();
        assert.equal(CONFIG.PlaylistSound.documentClass, NativePlaylistSound);
    } finally { NativePlaylistSound.prototype._scheduleFadeOut = original; console.warn = warn; }
});

test("a removed popup sound cannot dispatch stale playback or volume actions", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    const group = playlist({ playing: true });
    const popup = new EnchantmentPopup("macro", "Music");
    const root = { dataset: {}, querySelectorAll: () => [] };
    popup.element = root;
    const saved = { ...ui.playlists };
    let actions = 0; let volumes = 0;
    ui.playlists.activateSoundListeners = () => {};
    ui.playlists.options = { actions: { soundStop: () => { actions++; } } };
    ui.playlists._onSoundVolume = () => { volumes++; };
    try {
        await popup._onRender(await popup._prepareContext({}), {});
        group.sounds.delete("sound0");
        const row = { dataset: { playlistId: group.id, soundId: "sound0" } };
        const target = { dataset: { action: "soundStop" }, closest: () => row, matches: () => true };
        const click = [...root.handlers.values()].find((entry) => entry.selector === "[data-action]");
        const input = [...root.handlers.values()].find((entry) => entry.selector === ".sound-volume" && entry.name.startsWith("input"));
        await click.handler({ currentTarget: target, button: 0 });
        input.handler({ currentTarget: target, target });
        assert.equal(actions, 0);
        assert.equal(volumes, 0);
    } finally { await popup.close({ animate: false }); Object.assign(ui.playlists, saved); }
});
