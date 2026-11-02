import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Read the user's installed engine; no proprietary Foundry source is bundled here.
export const engine = process.env.FOUNDRY_V13_APP ?? "D:/Foundry/v13/Foundry Virtual Tabletop/resources/app";
export function nativeClass(path, dependencies = {}) {
    const source = readFileSync(resolve(engine, path), "utf8")
        .replace(/^import[^\n]*;\r?\n/gm, "")
        .replace("export default class", "return class")
        .replace("export default function", "return function");
    return Function(...Object.keys(dependencies), source)(...Object.values(dependencies));
}

Math.clamp ??= (value, min, max) => Math.min(max, Math.max(min, value));
Array.prototype.filterJoin ??= function (separator) { return this.filter(Boolean).join(separator); };
Number.prototype.paddedString ??= function (length) { return String(this).padStart(length, "0"); };
Number.prototype.toNearest ??= function (step, method = "round", offset = 0) {
    return Number((Math[method]((this - offset) / step) * step + offset).toFixed(10));
};

export class Collection extends Map {
    constructor(values = []) { super(values.map((entry) => [entry.id, entry])); }
    [Symbol.iterator]() { return this.values(); }
    get contents() { return Array.from(this.values()); }
    get playing() { return this.filter((entry) => entry.playing); }
    map(fn) { return this.contents.map(fn); }
    filter(fn) { return this.contents.filter(fn); }
    find(fn) { return this.contents.find(fn); }
    some(fn) { return this.contents.some(fn); }
    reduce(fn, initial) { return this.contents.reduce(fn, initial); }
}

export class Element extends EventTarget {
    dataset = {};
    attributes = new Map();
    attachInternals() { return {}; }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    setAttribute(name, value) { this.attributes.set(name, value); }
    contains(element) { return element === this; }
}

export class Application {
    constructor() { this.rendered = true; this.element = null; }
    async _prepareContext() { return {}; }
    async _onRender() {}
    async close() { this.rendered = false; return this; }
    async render() { return this; }
}

class DirectoryBase extends Application {
    static PARTS = { header: {}, directory: {}, footer: {} };
    _onClose() {}
    _attachPartListeners() {}
}

export const modes = { DISABLED: -1, SEQUENTIAL: 0, SHUFFLE: 1, SIMULTANEOUS: 2 };
export const NativePlaylistSound = nativeClass("client/documents/playlist-sound.mjs", {
    BasePlaylistSound: class {}, ClientDocumentMixin: (Base) => Base,
});
export const NativePlaylist = nativeClass("client/documents/playlist.mjs", {
    BasePlaylist: class {}, ClientDocumentMixin: (Base) => Base,
    PLAYLIST_MODES: modes, PLAYLIST_SORT_MODES: { ALPHABETICAL: "a", MANUAL: "m" },
});
export class NumberField { constructor(options) { this.options = options; } }
export const NativeDirectory = nativeClass("client/applications/sidebar/tabs/playlist-directory.mjs", {
    DocumentDirectory: DirectoryBase, PlaylistSound: NativePlaylistSound, PLAYLIST_MODES: modes,
    NumberField, StringField: class {}, TextEditor: {},
});
export const NativeAudioHelper = nativeClass("client/audio/helper.mjs", {
    Tile: class {}, AudioBufferCache: class {}, Sound: class {}, Hooks: {},
});
const FormElement = nativeClass("client/applications/elements/form-element.mjs", { HTMLElement: Element });
export const NativeRangePicker = nativeClass("client/applications/elements/range-picker.mjs", {
    AbstractFormInputElement: FormElement,
});

export const hooks = new Map();
export const events = [];
export const settings = { normalize: false, normalizeModifier: 0.5, alwaysFade: false, fadeModifier: 500 };
export const endpoint = { protocol: "https:", host: "s3.us-east-1.amazonaws.com" };
export const picker = {
    matchS3URL(url) {
        return /^https:\/\/(?<bucket>[^/]+)\.s3\.us-east-1\.amazonaws\.com\/(?<key>.*)$/.exec(url)
            ?? /^https:\/\/s3\.us-east-1\.amazonaws\.com\/(?<bucket>[^/]+)\/(?<key>.*)$/.exec(url);
    },
};

export function jquery(root) {
    root.handlers ??= new Map();
    return {
        off(names, selector) {
            for (const [key, entry] of root.handlers) {
                if (names.split(" ").some((name) => entry.name.includes(name)) && (!selector || entry.selector === selector)) {
                    root.handlers.delete(key);
                }
            }
            return this;
        },
        on(names, selector, handler) {
            if (typeof selector === "function") { handler = selector; selector = undefined; }
            for (const name of names.split(" ")) root.handlers.set(name + (selector ?? ""), { name, selector, handler });
            return this;
        },
        find() { throw new Error("Sound listener binding should not scan every row"); },
    };
}

globalThis.$ = jquery;
globalThis.document = { hidden: false, activeElement: null };
globalThis.CONST = { PLAYLIST_MODES: modes, AUDIO_FILE_EXTENSIONS: { mp3: {}, ogg: {}, wav: {} } };
globalThis.Hooks = { on(name, fn) { const callbacks = hooks.get(name) ?? []; callbacks.push(fn); hooks.set(name, callbacks); } };
globalThis.game = {
    release: { generation: 13 },
    playlists: new Collection(), macros: new Collection(),
    user: { id: "gm", isGM: true, hotbar: {} }, data: { files: { s3: { endpoint } } },
    i18n: { localize: (key) => key, format: (key, values) => key + JSON.stringify(values) },
    settings: {
        get(module, key) { return key === "soundUploadFolder" ? "audio" : settings; },
        async set(module, key, value) { Object.assign(settings, value); return value; },
    },
};
globalThis.ui = {
    sidebar: { expanded: true }, playlists: { constructor: NativeDirectory },
    tooltip: { activate() {}, deactivate() {} },
    notifications: Object.fromEntries(["info", "error", "warn", "remove"].map((name) => [name, (...args) => {
        events.push([name, ...args]); return events.length;
    }])),
};
globalThis.foundry = {
    utils: {
        mergeObject: Object.assign, deepClone: structuredClone,
        debounce: (fn) => fn,
        getProperty: (object, path) => path.split(".").reduce((value, key) => value?.[key], object),
    },
    data: { fields: { NumberField } },
    audio: { AudioHelper: NativeAudioHelper },
    applications: {
        sidebar: { tabs: { PlaylistDirectory: NativeDirectory } },
        api: { ApplicationV2: Application, HandlebarsApplicationMixin: (Base) => Base },
        apps: { FilePicker: { implementation: picker } },
    },
    documents: { PlaylistSound: NativePlaylistSound },
};

export async function emit(name, ...args) {
    for (const callback of hooks.get(name) ?? []) await callback(...args);
}

let counter = 0;
export function playlist({ count = 1, mode = modes.SEQUENTIAL, channel = "music", playing = false, pausedTime = null, ...data } = {}) {
    const id = data.id ?? "playlist" + (++counter);
    const result = {
        id, name: id, mode, channel, playing, isOwner: true, visible: true, documentName: "Playlist",
        fade: 0, calls: [], ...data,
        async update(changes, options = {}) {
            const update = structuredClone(changes);
            await emit("preUpdatePlaylist", this, update, options, game.user.id);
            this.calls.push(update);
            if ("fade" in update) this.fade = update.fade;
            for (const change of update.sounds ?? []) Object.assign(this.sounds.get(change._id), change);
            this.playing = this.sounds.some((sound) => sound.playing);
            await emit("updatePlaylist", this, update, options, game.user.id);
            return this;
        },
        async updateEmbeddedDocuments(type, sounds) { return this.update({ sounds }); },
        playSound(sound) { return NativePlaylist.prototype.playSound.call(this, sound); },
        playAll() { return NativePlaylist.prototype.playAll.call(this); },
        stopSound(sound) { return NativePlaylist.prototype.stopSound.call(this, sound); },
        stopAll() { return NativePlaylist.prototype.stopAll.call(this); },
        async createEmbeddedDocuments(type, sounds) { this.created = sounds; return sounds; },
    };
    result.sounds = new Collection(Array.from({ length: count }, (_, index) => ({
        id: "sound" + index, uuid: "Playlist." + id + ".PlaylistSound.sound" + index,
        documentName: "PlaylistSound", parent: result, isOwner: true,
        name: "Track " + index, path: "audio/" + index + ".ogg", playing, pausedTime, repeat: false, volume: 0.5,
        sound: { loaded: true, failed: false, currentTime: 10, duration: 180 },
    })));
    result.playbackOrder = result.sounds.map((sound) => sound.id);
    game.playlists.set(id, result);
    return result;
}

export function reset() {
    game.playlists = new Collection(); game.macros = new Collection();
    ui.enchantmentPopup = null; events.length = 0;
    document.hidden = false; document.activeElement = null;
    Object.assign(settings, { normalize: false, normalizeModifier: 0.5, alwaysFade: false, fadeModifier: 500 });
}

export function rowFor(sound, counters = { queries: 0, writes: 0 }) {
    const text = (value) => ({
        get textContent() { return value; },
        set textContent(next) { counters.writes++; value = next; },
    });
    const range = new NativeRangePicker({ value: 0.5, min: 0, max: 1, step: 0.05 });
    const classes = new Set(["fa-pause"]);
    const pause = { disabled: false, classList: {
        contains: (name) => classes.has(name),
        toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); },
    } };
    const parts = {
        "span.current": text("0:00"), "span.duration": text("3:00"), "button.pause": pause, ".sound-volume": range,
    };
    return {
        isConnected: true, dataset: { playlistId: sound.parent.id, soundId: sound.id }, parts,
        querySelector(selector) { counters.queries++; return parts[selector]; },
    };
}
