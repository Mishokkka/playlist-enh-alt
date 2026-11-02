import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { initializeNativePlayback, makePlaylist, flush, Sound } from "./helpers/native-playback.mjs";
import { settings } from "./helpers/foundry-v13.mjs";

// Run these independent scenarios against the immutable PR-head backup as well
// as the working sources. The native engine loader stays outside that target.
const target = process.env.PE_PR_REVIEW_TARGET
    ? pathToFileURL(resolve(process.env.PE_PR_REVIEW_TARGET) + "/") : new URL("../", import.meta.url);
initializeNativePlayback();
const { EnchantedPlaylist } = await import(new URL("modules/enchantedplaylist.js", target));
const { playbackSounds } = await import(new URL("modules/playback.js", target));
const { installAudioScheduler } = await import(new URL("modules/audio-scheduler.js", target));
const { installPlaybackLifecycle, withPlaybackOptions } = await import(new URL("modules/playback-lifecycle.js", target));
const { setupHooks } = await import(new URL("modules/hooks.js", target));
const { EnchantmentPopup } = await import(new URL("modules/enchantmentpopup.js", target));
setupHooks();
let clock;
beforeEach(async () => {
    await delay(5);
    clock = initializeNativePlayback();
    installAudioScheduler();
    installPlaybackLifecycle();
});
afterEach(async () => { await delay(5); });

for (const [action, next] of [["enchPlaylistForward", "sound1"], ["enchPlaylistBackward", "sound2"]]) {
    test(`global ${action} preserves every resumed playlist with exclusive Fade enabled`, async () => {
        const first = makePlaylist({ count: 3 });
        const second = makePlaylist({ count: 3 });
        await first.playAll(); await second.playAll();
        settings.alwaysFade = true;
        await EnchantedPlaylist._enchantAllSkip({}, { dataset: { action } });
        await delay(5);
        for (const parent of [first, second]) {
            assert.equal(parent.playing, true, "a grouped skip stopped another playlist");
            assert.equal(parent.sounds.get(next).playing, true);
            assert.equal(parent.transactions.at(-1).options.playlistEnchantmentSkipExclusive, true);
        }
    });
}

test("a natural next-track transition preserves other intentionally concurrent playlists", async () => {
    const first = makePlaylist({ count: 2 });
    const second = makePlaylist({ count: 2 });
    await first.playAll(); await clock.advance(1); await second.playAll();
    settings.alwaysFade = true;
    await clock.advance(299);
    await delay(5);
    assert.equal(first.sounds.get("sound1").playing, true);
    assert.equal(second.playing, true, "an automatic continuation was treated as a new exclusive selection");
});

for (const remove of [false, true]) {
    test(`a pending load finishing after ${remove ? "deletion" : "Stop"} ends fully stopped`, async () => {
        const create = game.audio.create;
        let release;
        const gate = new Promise((resolve) => { release = resolve; });
        game.audio.create = (options) => {
            const source = create(options);
            const load = source._load;
            source._load = async function () { await gate; return load.call(this); };
            return source;
        };
        const parent = makePlaylist();
        const doc = parent.sounds.get("sound0");
        await parent.playAll();
        const source = doc.sound;
        if (remove) doc._onDelete({}, game.user.id);
        else await parent.stopAll();
        release(); await flush();
        assert.equal(source._state, Sound.STATES.STOPPED, "play event raced Sound's operation promise");
        assert.equal(source.sourceNode, undefined, "a cancelled load retained a connected source");
        assert.equal(game.audio.playing.has(source.id), false);
    });
}

test("a pause at zero seconds remains visible and Resume All can restart it", async () => {
    const parent = makePlaylist();
    const doc = parent.sounds.get("sound0");
    await parent.playAll();
    await doc.update({ playing: false, pausedTime: 0 });
    assert.ok(playbackSounds().includes(doc), "zero was mistaken for an absent pause offset");
    await EnchantedPlaylist._enchantStartAll({}, { closest: () => null });
    assert.equal(doc.playing, true);
    assert.equal(doc.sound.playing, true);
});

test("a pause at zero uses an immediate stop even when the saved fade is positive", async () => {
    const parent = makePlaylist({ fade: 900 });
    const doc = parent.sounds.get("sound0");
    await withPlaybackOptions(parent, { duration: 0 }, () => parent.playAll());
    await doc.update({ playing: false, pausedTime: 0 });
    await flush();
    assert.equal(doc.sound._state, Sound.STATES.STOPPED, "pause at zero incorrectly faded out");
    assert.equal(parent.fade, 900);
});

test("sidebar render context includes a track paused at exactly zero", async () => {
    const parent = makePlaylist();
    const doc = parent.sounds.get("sound0");
    await parent.playAll();
    await doc.update({ playing: false, pausedTime: 0 });
    const sidebar = Object.create(EnchantedPlaylist.prototype);
    sidebar._playing = { playlists: [], sounds: [], context: [] };
    sidebar._expanded = new Set();
    const context = sidebar._preparePlaylistContext({}, parent);
    assert.ok(sidebar._playing.sounds.includes(doc));
    assert.equal(context.sounds[0].currentTime, "0:00");
    assert.match(context.sounds[0].play.icon, /play-circle/);
});

test("a queued channel stop evaluates the live layers when it actually runs", async () => {
    const parent = makePlaylist({ mode: 2, count: 2 });
    const music = parent.sounds.get("sound0");
    const environment = parent.sounds.get("sound1");
    environment.channel = "environment";
    await parent.playSound(music);
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const startEnvironment = withPlaybackOptions(parent, {}, async () => {
        await gate; return parent.playSound(environment);
    });
    await flush();
    const stopMusic = EnchantedPlaylist._stopChannels(parent, new Set(["music"]), 500);
    release(); await Promise.all([startEnvironment, stopMusic]);
    assert.equal(music.playing, false);
    assert.equal(environment.playing, true, "queued stopAll used an obsolete channel snapshot");
    assert.equal(environment.sound.playing, true);
});

test("ordinary selection still stops another playlist on the same channel", async () => {
    const first = makePlaylist();
    await first.playAll();
    const second = makePlaylist();
    settings.alwaysFade = true;
    await second.playAll();
    await delay(5);
    assert.equal(first.playing, false);
    assert.equal(second.playing, true);
});

test("stopping music retains a zero-second pause on another channel", async () => {
    const parent = makePlaylist({ mode: 2, count: 2 });
    const music = parent.sounds.get("sound0");
    const environment = parent.sounds.get("sound1");
    environment.channel = "environment";
    environment.pausedTime = 0;
    await parent.playSound(music);
    await EnchantedPlaylist._stopChannels(parent, new Set(["music"]), 500);
    assert.equal(music.playing, false);
    assert.equal(environment.playing, false);
    assert.equal(environment.pausedTime, 0, "unrelated paused layer was cleared by stopAll");
});

test("large transition metadata is matched in linear work", (t) => {
    const count = 512;
    const parent = makePlaylist({ mode: 2, count });
    let reads = 0;
    const sounds = parent.sounds.map((sound) => ({
        get id() { reads++; return sound.id; }, playing: true,
    }));
    const changes = { sounds: parent.sounds.map((sound) => ({ _id: sound.id, playing: true })) };
    game.audio.locked = true; // Isolate document matching from device work.
    parent._onUpdate(changes, {
        playlistEnchantmentTransition: { playlistId: parent.id, duration: 150, sounds },
    }, game.user.id);
    assert.ok(reads <= count * 2, `metadata matching read ${reads} IDs for ${count} tracks`);
    t.diagnostic(`${count} tracks: ${reads} metadata ID reads; this counts work, not elapsed time or FPS.`);
    assert.equal(parent.sounds.get("sound511").fadeDuration, 150);
});

test("malformed optional transition entries cannot abort a valid native update", () => {
    const parent = makePlaylist();
    game.audio.locked = true;
    assert.doesNotThrow(() => parent._onUpdate({ sounds: [{ _id: "sound0", playing: true }] }, {
        playlistEnchantmentTransition: {
            playlistId: parent.id, duration: 150,
            sounds: [null, false, "sound0", { id: "sound0", playing: "true" }],
        },
    }, game.user.id));
    assert.equal(parent.sounds.get("sound0").fadeDuration, 0);
});

test("a hidden popup defers structural rendering, refreshes on return, and removes its listener on close", async () => {
    const parent = makePlaylist();
    await parent.playAll();
    const popup = new EnchantmentPopup("macro", "Music");
    popup.element = {};
    const visibility = new EventTarget();
    const oldAdd = document.addEventListener; const oldRemove = document.removeEventListener;
    let attached = 0;
    document.addEventListener = (name, callback) => { attached++; visibility.addEventListener(name, callback); };
    document.removeEventListener = (name, callback) => { attached--; visibility.removeEventListener(name, callback); };
    let renders = 0;
    popup.render = async () => { renders++; popup._lastStateKey = popup._getStateKey(); return popup; };
    try {
        popup._startTimestampUpdates();
        document.hidden = true;
        await popup.syncFromPlaylistDirectory();
        assert.equal(renders, 0, "a hidden popup still built a structural render");
        popup.scheduleSync();
        assert.equal(popup._syncTimer, null, "a hidden popup still scheduled background refresh work");
        document.hidden = false;
        visibility.dispatchEvent(new Event("visibilitychange"));
        await delay(65);
        assert.equal(renders, 1, "visibility return did not flush the deferred state");
        await popup.close();
        assert.equal(attached, 0, "closed popup retained its visibility listener");
    } finally {
        await popup.close();
        document.hidden = false;
        if (oldAdd) document.addEventListener = oldAdd; else delete document.addEventListener;
        if (oldRemove) document.removeEventListener = oldRemove; else delete document.removeEventListener;
    }
});
