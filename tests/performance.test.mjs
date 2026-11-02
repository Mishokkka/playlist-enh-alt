import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import {
    engine, NativeRangePicker, NativePlaylistSound, NativePlaylist, NativeDirectory,
    modes, playlist, reset, settings, emit, rowFor, jquery, picker, events, Collection,
} from "./helpers/foundry-v13.mjs";

const { EnchantedPlaylist } = await import("../modules/enchantedplaylist.js");
const { EnchantmentPopup } = await import("../modules/enchantmentpopup.js");
const { PlaybackRows, playbackSounds, playbackContext } = await import("../modules/playback.js");
const { setupHooks } = await import("../modules/hooks.js");
setupHooks();
beforeEach(reset);

function cacheFor(rows) { return new PlaybackRows({ querySelectorAll: () => rows }); }

test("v13 range-picker value setter dispatches both input and change", () => {
    const range = new NativeRangePicker({ min: 0, max: 1, step: 0.05 });
    const seen = [];
    for (const name of ["input", "change"]) range.addEventListener(name, () => seen.push(name));
    range.value = 0.63;
    assert.deepEqual(seen, ["input", "change"]);
    assert.equal(range.value, 0.65);
});

test("clock and volume refreshes never dispatch input or change", () => {
    const sound = playlist().sounds.get("sound0");
    const counts = { queries: 0, writes: 0 };
    const row = rowFor(sound, counts);
    let inputs = 0;
    const range = row.parts[".sound-volume"];
    range.addEventListener("input", () => inputs++);
    range.addEventListener("change", () => inputs++);
    const cache = cacheFor([row]);
    cache.update({ volumes: true });
    assert.equal(inputs, 0);
    const previousWrites = counts.writes;
    counts.queries = 0;
    for (let index = 0; index < 60; index++) cache.update({ volumes: true });
    assert.equal(inputs, 0);
    assert.equal(counts.queries, 0);
    assert.equal(counts.writes, previousWrites);
    sound.volume = 0;
    cache.update({ volumes: true });
    assert.equal(range.value, 0);
    assert.equal(sound.volume, 0);
    assert.equal(inputs, 0);
});

test("paused time wins over an audio source still fading out; unknown duration is retained", () => {
    const sound = playlist({ pausedTime: 73 }).sounds.get("sound0");
    sound.sound.currentTime = 999;
    sound.sound.duration = 0;
    const row = rowFor(sound);
    cacheFor([row]).update();
    assert.equal(row.parts["span.current"].textContent, "1:13");
    assert.equal(row.parts["span.duration"].textContent, "3:00");
});

test("clock does no work in a hidden browser tab", () => {
    const sound = playlist({ playing: true }).sounds.get("sound0");
    const row = rowFor(sound);
    Object.defineProperty(sound.sound, "currentTime", { get() { throw new Error("Hidden tick read audio"); } });
    document.hidden = true;
    cacheFor([row]).update({ volumes: true });
});

test("volume synchronization leaves a focused range-picker alone", () => {
    const sound = playlist().sounds.get("sound0");
    sound.volume = 0;
    const row = rowFor(sound);
    const range = row.parts[".sound-volume"];
    document.activeElement = range;
    const cache = cacheFor([row]);
    cache.update({ volumes: true });
    assert.equal(range.value, 0.5);
    document.activeElement = null;
    cache.update({ volumes: true });
    assert.equal(range.value, 0);
});

test("cached ticks perform zero selector queries for 1000 active rows", (t) => {
    const group = playlist({ count: 1000, playing: true });
    const counts = { queries: 0, writes: 0 };
    const rows = group.sounds.map((sound) => rowFor(sound, counts));
    const cache = cacheFor(rows);
    assert.equal(counts.queries, 4000);
    counts.queries = 0;
    cache.update({ volumes: true });
    counts.writes = 0;
    for (let index = 0; index < 30; index++) cache.update({ volumes: true });
    assert.equal(counts.queries, 0);
    assert.equal(counts.writes, 0);
    t.diagnostic("1000 rows × 30 unchanged ticks: 0 selector queries, 0 text writes, 0 application renders");
});

test("playback queries use live documents, include buffering, and distinguish embedded IDs", () => {
    const first = playlist({ playing: true });
    const second = playlist({ playing: true });
    first.sounds.get("sound0").sound = undefined;
    assert.equal(playbackSounds().length, 2);
    const context = playbackSounds().map(playbackContext);
    assert.notEqual(context[0].playlistId, context[1].playlistId);
    assert.match(context[0].pause.icon, /spinner/);
    assert.equal(context[0].pause.disabled, true);
    second.sounds.get("sound0").isOwner = false;
    second.sounds.get("sound0").playing = false;
    second.sounds.get("sound0").pausedTime = 20;
    assert.equal(playbackSounds().length, 1);
});

test("popup opens correctly when the sidebar render cache is empty", async () => {
    playlist({ playing: true });
    ui.playlists._playing = { sounds: [], context: [] };
    const popup = new EnchantmentPopup("macro", "Music");
    const context = await popup._prepareContext({});
    assert.equal(context.playingSounds.length, 1);
    assert.equal(context.showPlaying, true);
});

test("only three delegated sound handlers are attached regardless of library size", () => {
    const root = {};
    const receiver = Object.create(EnchantedPlaylist.prototype);
    for (let index = 0; index < 20; index++) receiver.activateSoundListeners(jquery(root));
    assert.equal(root.handlers.size, 3);
});

test("Pause All batches by playlist, preserves offsets, and skips already paused tracks", async () => {
    const group = playlist({ count: 100, playing: true, mode: modes.SIMULTANEOUS });
    const paused = group.sounds.get("sound99"); paused.playing = false; paused.pausedTime = 51;
    ui.playlists._playing = { sounds: [] };
    await EnchantedPlaylist._enchantStopAll.call(ui.playlists, {}, {});
    assert.equal(group.calls.length, 1);
    assert.equal(group.calls[0].sounds.length, 99);
    assert.equal(group.sounds.get("sound0").pausedTime, 10);
    assert.equal(paused.pausedTime, 51);
});

test("Resume All sends one update for 100 simultaneous tracks and no redundant writes for running tracks", async () => {
    const group = playlist({ count: 100, pausedTime: 45, mode: modes.SIMULTANEOUS });
    await EnchantedPlaylist._enchantStartAll.call(ui.playlists, {}, { closest: () => null });
    assert.equal(group.calls.length, 1);
    assert.equal(group.calls[0].sounds.length, 100);
    assert.ok(group.sounds.contents.every((sound) => sound.playing && sound.pausedTime === 45));
    await EnchantedPlaylist._enchantStartAll.call(ui.playlists, {}, { closest: () => null });
    assert.equal(group.calls.length, 1);
});

test("normalization applies to every simultaneous track, including true silence", async () => {
    const group = playlist({ count: 3, pausedTime: 20, mode: modes.SIMULTANEOUS });
    settings.normalize = true; settings.normalizeModifier = 0;
    await EnchantedPlaylist._enchantStartAll.call(ui.playlists, {}, { closest: () => null });
    assert.ok(group.sounds.contents.every((sound) => sound.volume === 0));
    const changes = { playing: true };
    await emit("preUpdatePlaylistSound", group.sounds.get("sound0"), changes);
    assert.equal(changes.volume, 0);
});

test("native Stop All clears stale pause entries and preserves explicit Pause offsets", async () => {
    const group = playlist({ count: 2, pausedTime: 45 });
    await group.stopAll();
    assert.ok(group.sounds.contents.every((sound) => sound.pausedTime === null));
    const update = { playing: false, sounds: [{ _id: "sound0", playing: false, pausedTime: 0 }] };
    await emit("preUpdatePlaylist", group, update);
    assert.equal(update.sounds[0].pausedTime, 0);
});

test("crossfade delegates playlist and track selection to the native API in every playback mode", async () => {
    for (const mode of [modes.SEQUENTIAL, modes.SHUFFLE, modes.SIMULTANEOUS]) {
        const group = playlist({ count: 3, mode });
        group.sounds.get("sound1").pausedTime = 42;
        let plays = 0; let tracks = 0;
        const playAll = group.playAll; const playSound = group.playSound;
        group.playAll = async function () { plays++; return playAll.call(this); };
        group.playSound = async function (sound) { tracks++; return playSound.call(this, sound); };
        globalThis.fromUuid = async () => group;
        await EnchantedPlaylist.crossFade("playlist");
        assert.equal(plays, 1);
        globalThis.fromUuid = async () => group.sounds.get("sound2");
        await EnchantedPlaylist.crossFade("track");
        assert.equal(tracks, 1);
        assert.equal(group.sounds.get("sound2").playing, true);
    }
});

test("crossfade updates every active layer on its channel while retaining ambience and soundboards", async () => {
    const outgoing = playlist({ count: 3, playing: true, mode: modes.SIMULTANEOUS });
    outgoing.sounds.get("sound2").channel = "environment";
    const ambience = playlist({ playing: true, channel: "environment" });
    const board = playlist({ playing: true, mode: modes.DISABLED });
    const incoming = playlist({ count: 2, mode: modes.SIMULTANEOUS });
    globalThis.fromUuid = async () => incoming;
    settings.normalize = true; settings.normalizeModifier = 0;
    await EnchantedPlaylist.crossFade("incoming");
    assert.equal(outgoing.calls.length, 2); // Public stopSound preserves mixed-channel integrations.
    assert.equal(outgoing.calls.flatMap((call) => call.sounds).length, 2);
    assert.equal(outgoing.fade, 0);
    assert.equal(outgoing.sounds.get("sound2").playing, true);
    assert.equal(ambience.calls.length, 0);
    assert.equal(board.calls.length, 0);
    assert.ok(incoming.sounds.contents.every((sound) => sound.playing && sound.volume === 0));

    // Actual local/remote Sound lifecycle coverage is in native-lifecycle.test.mjs.
});

test("zero fade is preserved and does not fall back to 500ms", async () => {
    const incoming = playlist();
    globalThis.fromUuid = async () => incoming;
    settings.fadeModifier = 0;
    let operation;
    const update = incoming.update;
    incoming.update = async function (data, options = {}) {
        const result = await update.call(this, data, options); operation = options; return result;
    };
    await EnchantedPlaylist.crossFade("incoming");
    assert.equal(operation.playlistEnchantmentTransition.duration, 0);
    assert.equal(incoming.calls[0].fade, undefined);
});

test("empty target cannot stop an existing playlist", async () => {
    const outgoing = playlist({ playing: true });
    const incoming = playlist({ count: 0 });
    globalThis.fromUuid = async () => incoming;
    await EnchantedPlaylist.crossFade("empty");
    assert.equal(outgoing.calls.length, 0);
    assert.equal(incoming.calls.length, 0);
});

test("rapid macro requests honor the newest selection without stale stop timers", async () => {
    const first = playlist(); const second = playlist(); const third = playlist();
    const targets = { first, second, third };
    globalThis.fromUuid = async (uuid) => targets[uuid];
    await Promise.all([EnchantedPlaylist.crossFade("first"), EnchantedPlaylist.crossFade("second"), EnchantedPlaylist.crossFade("third")]);
    assert.equal(first.calls.length, 0);
    assert.equal(second.calls.length, 0);
    assert.equal(third.calls.length, 1);
});

test("a rejected crossfade does not block subsequent macro playback", async () => {
    const incoming = playlist();
    globalThis.fromUuid = async () => { throw new Error("Simulated lookup failure"); };
    await assert.rejects(EnchantedPlaylist.crossFade("broken"), /lookup failure/);
    globalThis.fromUuid = async () => incoming;
    await EnchantedPlaylist.crossFade("working");
    assert.equal(incoming.playing, true);
});

test("Pause All supersedes an unresolved macro selection", async () => {
    const incoming = playlist();
    let resolve;
    globalThis.fromUuid = () => new Promise((done) => { resolve = done; });
    const pending = EnchantedPlaylist.crossFade("incoming");
    while (!resolve) await Promise.resolve();
    const pause = EnchantedPlaylist._enchantStopAll.call(ui.playlists, {}, {});
    resolve(incoming);
    await Promise.all([pending, pause]);
    assert.equal(incoming.calls.length, 0);
    assert.equal(incoming.playing, false);
});

test("ordinary Fade playback batches duplicate hooks and preserves other audio channels", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const outgoing = playlist({ count: 2, playing: true, mode: modes.SIMULTANEOUS });
    const incoming = playlist({ playing: true });
    const ambience = playlist({ playing: true, channel: "environment" });
    const board = playlist({ playing: true, mode: modes.DISABLED });
    settings.alwaysFade = true;
    const changes = { sounds: [{ _id: "sound0", playing: true }] };
    await emit("updatePlaylistSound", incoming.sounds.get("sound0"), { playing: true }, {}, "gm");
    await emit("updatePlaylist", incoming, changes, {}, "gm");
    t.mock.timers.tick(0);
    await new Promise(setImmediate);
    assert.equal(outgoing.calls.length, 1);
    assert.equal(outgoing.calls[0].sounds.length, 2);
    assert.equal(ambience.calls.length, 0);
    assert.equal(board.calls.length, 0);
});

test("Resume All retains multiple playlists even when exclusive Fade is enabled", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const first = playlist({ pausedTime: 20 }); const second = playlist({ pausedTime: 30 });
    settings.alwaysFade = true;
    await EnchantedPlaylist._enchantStartAll.call(ui.playlists, {}, { closest: () => null });
    t.mock.timers.tick(0);
    await Promise.resolve();
    assert.equal(first.playing, true);
    assert.equal(second.playing, true);
    assert.equal(first.calls.length, 1);
    assert.equal(second.calls.length, 1);
});

test("a remote update never triggers duplicate exclusive writes on this client", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const outgoing = playlist({ playing: true }); const incoming = playlist({ playing: true });
    settings.alwaysFade = true;
    await emit("updatePlaylist", incoming, { playing: true }, {}, "another-user");
    t.mock.timers.tick(0);
    await Promise.resolve();
    assert.equal(outgoing.calls.length, 0);
});

test("popup Play button plays its own assigned macro even when other music is active", async () => {
    const outgoing = playlist({ playing: true }); const incoming = playlist();
    game.macros.set("macro", { id: "macro", command: 'CONFIG.ui.playlists.hotbarPlaylist("Playlist.incoming")' });
    globalThis.fromUuid = async () => incoming;
    await EnchantedPlaylist._enchantStartAll.call(ui.playlists, {}, { closest: () => ({ dataset: { macroId: "macro" } }) });
    assert.equal(incoming.playing, true);
    assert.equal(outgoing.playing, false);
});

test("popup lifecycle owns only one timestamp timer and coalesces structural renders", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    const group = playlist({ playing: true });
    const popup = new EnchantmentPopup("macro", "Music");
    popup.element = { dataset: {}, querySelectorAll: () => [] };
    ui.playlists.activateSoundListeners = () => {};
    const context = await popup._prepareContext({});
    await popup._onRender(context, {});
    const initialTimer = popup._timestampTimer;
    await popup._onRender(context, {});
    assert.notEqual(popup._timestampTimer, initialTimer);
    let updates = 0; popup.updateTimestamps = () => updates++;
    t.mock.timers.tick(1000);
    assert.equal(updates, 1);
    let renders = 0;
    popup.render = async () => { renders++; popup._lastStateKey = popup._getStateKey(); };
    group.sounds.get("sound0").repeat = true;
    for (let index = 0; index < 50; index++) popup.scheduleSync();
    t.mock.timers.tick(50);
    await Promise.resolve(); await Promise.resolve();
    assert.equal(renders, 1);
    popup.scheduleClose(); popup._scheduleVolumeSync();
    await popup.close();
    assert.equal(popup._timestampTimer, null);
    assert.equal(popup._closeTimer, null);
    assert.equal(popup._volumeSyncTimer, null);
    t.mock.timers.tick(2000);
    assert.equal(updates, 1);
});

test("upload failures never create a phantom playlist or announce success", async () => {
    let created = 0;
    foundry.documents.Playlist = { create: async () => { created++; } };
    picker.browse = async () => ({ files: [] });
    picker.upload = async () => null;
    const app = Object.create(EnchantedPlaylist.prototype);
    const previous = console.error; console.error = () => {};
    try { await app.handleAudioFilesUpload({ target: { closest: () => null } }, [{ name: "missing.ogg" }]); }
    finally { console.error = previous; }
    assert.equal(created, 0);
    assert.ok(events.some(([type]) => type === "error"));
    assert.ok(!events.some(([type, message]) => type === "info" && message === "PLAYLISTENCHANTMENT.uploadDone"));
});

test("a document update during popup rendering is refreshed after that render", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    const group = playlist({ playing: true });
    const sound = group.sounds.get("sound0");
    const popup = new EnchantmentPopup("macro", "Music");
    popup.element = { dataset: {}, querySelectorAll: () => [] };
    ui.playlists.activateSoundListeners = () => {};
    await popup._onRender(await popup._prepareContext({}), {});
    sound.repeat = true;
    let finish;
    const gate = new Promise((resolve) => { finish = resolve; });
    let renders = 0;
    popup.render = async () => {
        renders++;
        popup.rendered = false;
        const context = await popup._prepareContext({});
        await gate;
        popup.rendered = true;
        await popup._onRender(context, {});
    };
    const first = popup.syncFromPlaylistDirectory();
    await Promise.resolve(); await Promise.resolve();
    sound.name = "Changed during render";
    await popup.syncFromPlaylistDirectory();
    assert.equal(popup._syncRequested, true);
    finish();
    await first;
    t.mock.timers.tick(50);
    for (let index = 0; index < 10; index++) await Promise.resolve();
    assert.equal(renders, 2);
    assert.equal(popup._lastStateKey, popup._getStateKey());
    await popup.close();
});

test("upload reuses existing files and sends new sounds to the actual drop target", async () => {
    const target = playlist();
    picker.browse = async () => ({ files: ["audio/existing%20track.ogg"] });
    picker.upload = async () => { throw new Error("Existing file was uploaded again"); };
    const node = { classList: { contains: () => true }, dataset: { entryId: target.id } };
    const app = Object.create(EnchantedPlaylist.prototype);
    await app.handleAudioFilesUpload({ target: { closest: () => node } }, [{ name: "existing track.ogg" }]);
    assert.equal(target.created.length, 1);
    assert.equal(target.created[0].path, "audio/existing%20track.ogg");
});

test("upload uses the S3 source, key and bucket, and keeps successful files after a partial failure", async () => {
    const target = playlist();
    const oldGet = game.settings.get;
    game.settings.get = (module, key) => key === "soundUploadFolder" ? "https://bucket.s3.us-east-1.amazonaws.com/audio" : settings;
    picker.browse = async () => ({ files: [] });
    const requests = [];
    picker.upload = async (...args) => {
        requests.push(args);
        return args[2].name === "bad.ogg" ? {} : { path: "https://bucket.s3.us-east-1.amazonaws.com/audio/good.ogg" };
    };
    const node = { classList: { contains: () => true }, dataset: { entryId: target.id } };
    const previous = console.error; console.error = () => {};
    try { await EnchantedPlaylist.prototype.handleAudioFilesUpload.call(
        Object.create(EnchantedPlaylist.prototype), { target: { closest: () => node } }, [{ name: "bad.ogg" }, { name: "good.ogg" }]
    ); } finally { game.settings.get = oldGet; console.error = previous; }
    assert.equal(requests[0][0], "s3");
    assert.equal(requests[0][1], "audio");
    assert.deepEqual(requests[0][3], { bucket: "bucket" });
    assert.equal(target.created.length, 1);
    assert.equal(target.created[0].name, "good");
});

test("custom sound template renders the v13 UUID, timer and volume context correctly", () => {
    const require = createRequire(engine + "/package.json");
    const Handlebars = require("handlebars").create();
    Handlebars.registerHelper("localize", (key) => key);
    Handlebars.registerHelper("ifThen", (condition, yes, no) => condition ? yes : no);
    Handlebars.registerHelper("disabled", (disabled) => disabled ? "disabled" : "");
    Handlebars.registerHelper("formInput", (field, options) => new Handlebars.SafeString('<range-picker class="sound-volume" value="' + options.hash.value + '"></range-picker>'));
    const sound = playlist({ playing: true }).sounds.get("sound0");
    const context = playbackContext(sound);
    const source = readFileSync(new URL("../templates/playlist/sound-partial.hbs", import.meta.url), "utf8");
    const html = Handlebars.compile(source)({ ...context, playback: true });
    assert.ok(html.includes('data-sound-uuid="' + sound.uuid + '"'));
    assert.ok(html.includes('<span class="current">0:10</span>'));
    assert.ok(html.includes('<span class="duration">3:00</span>'));
    assert.ok(html.includes("<range-picker"));
    const native = NativeDirectory.prototype._preparePlaylistContext.call({
        constructor: NativeDirectory, _playing: { playlists: [], sounds: [], context: [] }, _expanded: new Set(),
    }, {}, sound.parent);
    assert.equal(native.sounds[0].currentTime, context.currentTime);
    assert.equal(native.sounds[0].durationTime, context.durationTime);
});

test("module entry point registers v13 controls and preserves the selected S3 bucket", async () => {
    const registered = new Map(); const once = new Map();
    const savedPicker = foundry.applications.apps.FilePicker.implementation;
    const savedRegister = game.settings.register; const savedOnce = Hooks.once;
    const savedConfig = globalThis.CONFIG; const savedRender = ui.playlists.render;
    class Picker {
        async _prepareContext() { return { isFolderPicker: true, selected: this.source.target }; }
    }
    try {
        foundry.applications.apps.FilePicker.implementation = Picker;
        globalThis.CONFIG = { ui: {}, ux: { FilePicker: Picker }, PlaylistSound: { documentClass: NativePlaylistSound }, Playlist: { documentClass: NativePlaylist } };
        Hooks.once = (name, callback) => once.set(name, callback);
        game.settings.register = (module, key, definition) => registered.set(key, definition);
        await import("../bundle/modules/init.js");
        once.get("init")();
        assert.equal(CONFIG.ui.playlists, EnchantedPlaylist);
        assert.equal(CONFIG.PlaylistSound.documentClass, NativePlaylistSound);
        once.get("setup")();
        assert.equal(CONFIG.PlaylistSound.documentClass._playlistEnchantmentScheduler, true);
        assert.equal(CONFIG.Playlist.documentClass._playlistEnchantmentTransitions, true);
        assert.ok(registered.has("settings"));
        assert.ok(registered.has("soundUploadFolder"));
        let options;
        ui.playlists.render = (value) => { options = value; };
        registered.get("settings").onChange();
        assert.deepEqual(options, { parts: ["controls"] });
        const dialog = new CONFIG.ux.FilePicker();
        dialog.activeSource = "s3"; dialog.source = { target: "audio", bucket: "test" };
        const context = await dialog._prepareContext({});
        assert.equal(context.selected, "https://test.s3.us-east-1.amazonaws.com/audio");
        assert.equal(typeof once.get("setup"), "function");
    } finally {
        foundry.applications.apps.FilePicker.implementation = savedPicker;
        game.settings.register = savedRegister; Hooks.once = savedOnce;
        globalThis.CONFIG = savedConfig; ui.playlists.render = savedRender;
    }
});
