import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { initializeNativePlayback, Playlist, PlaylistSound, flush } from "./helpers/native-playback.mjs";
import { engine, nativeClass, hooks } from "./helpers/foundry-v13.mjs";

// Keep core's strict collection check and full client backend, including its
// private update handler. Only data validation, transport and UI/device edges
// are simulated. The previous playback fixture used an unchecked Map here.
const CoreCollection = Function(readFileSync(resolve(engine, "common/utils/collection.mjs"), "utf8")
    .replace("export default Collection;", "return Collection;"))();
Array.prototype.findSplice ??= function (predicate, replacement) {
    const index = this.findIndex(predicate);
    return index < 0 ? undefined : this.splice(index, 1, replacement)[0];
};
const DocumentCollection = nativeClass("client/documents/abstract/document-collection.mjs", {
    Collection: CoreCollection, Hooks,
});
const WorldCollection = nativeClass("client/documents/abstract/world-collection.mjs", {
    DocumentCollection, DirectoryCollectionMixin: (Base) => Base,
    getDocumentClass: (name) => CONFIG[name].documentClass,
});
const Playlists = nativeClass("client/documents/collections/playlists.mjs", { WorldCollection });
class Sounds extends DocumentCollection { static documentName = "PlaylistSound"; }
const ClientBackend = nativeClass("client/data/client-backend.mjs", {
    DatabaseBackend: class {
        async _getParent(operation) { return operation.parent ?? game.playlists.get(operation.parentUuid?.split(".")[1]); }
    },
    SocketInterface: {
        async dispatch(channel, request) {
            return { ...request, operation: { ...request.operation }, result: request.operation.updates, userId: game.user.id };
        },
    },
    Hooks, getDocumentClass: (name) => CONFIG[name].documentClass,
    TokenDocument: class {}, Actor: class {},
});
const backend = new ClientBackend();
const once = new Map();
initializeNativePlayback();
Hooks.once = (name, callback) => once.set(name, callback);
Hooks.call = (name, ...args) => {
    for (const callback of hooks.get(name) ?? []) if (callback(...args) === false) return false;
    return true;
};
Hooks.callAll = (name, ...args) => { for (const callback of hooks.get(name) ?? []) callback(...args); };
Hooks.onError = (name, error) => { throw error; };
const target = process.env.PE_BOOT_TARGET
    ? pathToFileURL(resolve(process.env.PE_BOOT_TARGET) + "/") : new URL("../", import.meta.url);
await import(new URL("bundle/modules/init.js", target));
const { installAudioScheduler } = await import(new URL("modules/audio-scheduler.js", target));
const { installPlaybackLifecycle } = await import(new URL("modules/playback-lifecycle.js", target));

function addModelBoundary(Base, documentName) {
    return class extends Base {
        static documentName = documentName;
        static schema = { _addTypes() {} };
        static migrateData(data) { return data; }
        static shimData(data) { return data; }
        static async _preUpdateOperation() {}
        static async _onUpdateOperation() {}
        static fromSource(data, context = {}) {
            const doc = new this({ ...structuredClone(data), id: data._id, documentName }, context);
            if (documentName === "Playlist") {
                doc.sounds = new Sounds(data.sounds);
                for (const sound of doc.sounds) sound.parent = doc;
                doc.prepareDerivedData();
            }
            return doc;
        }
        get uuid() { return `${documentName}.${this.id}`; }
        toObject() {
            const data = { _id: this.id, name: this.name, playing: this.playing };
            if (this.sounds) return { ...data, mode: this.mode, sounds: this.sounds.map((sound) => sound.toObject()) };
            return { ...data, repeat: this.repeat, volume: this.volume, pausedTime: this.pausedTime };
        }
        toJSON() { return this.toObject(); }
        updateSource(changes, { dryRun = false } = {}) {
            if (!dryRun) {
                for (const [key, value] of Object.entries(changes)) {
                    if (key === "_id") continue;
                    if (key === "sounds") for (const change of value) this.sounds.get(change._id).updateSource(change);
                    else this[key] = value;
                }
                if (this.sounds) this.prepareDerivedData();
            }
            return structuredClone(changes);
        }
        async update(changes, options = {}) {
            const operation = { ...options, updates: [{ _id: this.id, ...changes }], diff: false, render: false };
            if (this.parent) operation.parent = this.parent;
            const docs = await backend._updateDocuments(this.constructor, operation, game.user);
            await flush();
            return docs[0];
        }
        getEmbeddedCollection() { return this.sounds; }
        _dispatchDescendantDocumentEvents() {}
        reset() { this.prepareDerivedData(); }
    };
}
const BasePlaylist = addModelBoundary(Playlist, "Playlist");
const BaseSound = addModelBoundary(PlaylistSound, "PlaylistSound");

function boot({ optimize = true, late = false, afterInit } = {}) {
    initializeNativePlayback();
    hooks.clear();
    game._documentsReady = false;
    CONFIG.Playlist.documentClass = BasePlaylist;
    CONFIG.PlaylistSound.documentClass = BaseSound;
    CONFIG.ui = {}; CONFIG.ux = {}; CONFIG.debug = { documents: false };
    foundry.utils.getDocumentClass = (name) => CONFIG[name].documentClass;
    foundry.utils.isSubclass = (cls, Base) => cls.prototype instanceof Base;
    foundry.utils.isEmpty = (data) => !Object.keys(data).length;
    foundry.utils.expandObject = (data) => structuredClone(data);
    foundry.abstract = { DataModel: class {}, DocumentSocketResponse: class { constructor(data) { Object.assign(this, data); } } };
    foundry.documents.collections = { CompendiumCollection: class {} };
    foundry.applications.apps.FilePicker.implementation = class {};
    game.settings.register = () => {};
    const get = game.settings.get;
    game.settings.get = (module, key) => key === "optimizeFadeTimers" ? optimize : get(module, key);
    if (!late) once.get("init")();
    afterInit?.();
    const sounds = [0, 1].map((n) => ({
        _id: "sound" + n, name: "Track " + n, path: "track" + n + ".ogg", channel: "",
        playing: false, pausedTime: null, repeat: false, volume: 0.5, fade: null, sort: n, isOwner: true,
    }));
    game.playlists = new Playlists([{
        _id: "existing", name: "Existing playlist", sounds, channel: "music", mode: 0,
        playing: false, fade: 0, sorting: "m", isOwner: true,
    }]);
    game.collections = new Map([["Playlist", game.playlists]]);
    game.users = new Map([[game.user.id, game.user]]);
    game._documentsReady = true;
    // Foundry Game.setupGame initializes world documents BEFORE calling setup.
    if (!late) once.get("setup")();
    return game.playlists.get("existing");
}

test("existing world playlists can play, skip, stop and change mode after the real startup order", async () => {
    const parent = boot();
    await parent.playAll();
    assert.equal(parent.sounds.get("sound0").sound.playing, true);
    await parent.playNext();
    assert.equal(parent.sounds.get("sound1").playing, true);
    await parent.stopAll();
    assert.equal(parent.playing, false);
    await parent.playSound(parent.sounds.get("sound0"));
    await parent.stopSound(parent.sounds.get("sound0"));
    await parent.cycleMode();
    assert.equal(parent.mode, 1);
    assert.equal(parent instanceof CONFIG.Playlist.documentClass, true);
});

test("existing embedded sounds retain their configured class through setup and accept updates", async () => {
    const parent = boot();
    const sound = parent.sounds.get("sound0");
    await sound.update({ repeat: true, volume: 0.25 });
    assert.equal(sound instanceof CONFIG.PlaylistSound.documentClass, true);
    assert.equal(sound.repeat, true);
    assert.equal(sound.volume, 0.25);
});

test("documents loaded at startup and created later share the same collection contract", async () => {
    const existing = boot();
    const created = CONFIG.Playlist.documentClass.fromSource({
        _id: "new", name: "New playlist", sounds: [], mode: 0, isOwner: true,
    });
    game.playlists.set(created.id, created);
    await existing.update({ name: "Existing renamed" });
    await created.update({ name: "New renamed" });
    assert.equal(game.playlists.get("existing"), existing);
    assert.equal(game.playlists.get("new"), created);
});

test("turning off optimized timers does not break document registration or playback", async () => {
    const parent = boot({ optimize: false });
    await parent.playAll();
    assert.equal(parent.sounds.get("sound0").sound.playing, true);
    await parent.stopAll();
});

test("a subsequent init-time subclass keeps document identity and its playback wrapper", async () => {
    let called = 0;
    const parent = boot({ afterInit() {
        const Base = CONFIG.Playlist.documentClass;
        CONFIG.Playlist.documentClass = class ThirdPartyPlaylist extends Base {
            async playAll() { called++; return super.playAll(); }
        };
    } });
    await parent.playAll();
    await parent.stopAll();
    assert.equal(called, 1);
    assert.equal(parent instanceof CONFIG.Playlist.documentClass, true);
});

test("late installer calls refuse to replace classes of already constructed documents", async () => {
    const parent = boot({ late: true });
    const classes = [CONFIG.Playlist.documentClass, CONFIG.PlaylistSound.documentClass];
    const warn = console.warn; console.warn = () => {};
    try { installAudioScheduler(); installPlaybackLifecycle(); } finally { console.warn = warn; }
    assert.deepEqual([CONFIG.Playlist.documentClass, CONFIG.PlaylistSound.documentClass], classes);
    await parent.playAll();
    await parent.stopAll();
});
