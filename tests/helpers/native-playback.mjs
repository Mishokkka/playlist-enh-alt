import { nativeClass, Collection, emit, reset } from "./foundry-v13.mjs";

// Full client audio classes and their private fields are kept intact. Only the
// Web Audio device, network/storage boundary and base data model are simulated.
const EventEmitterMixin = nativeClass("common/utils/event-emitter.mjs");
export class AudioBuffer {
    constructor({ length, sampleRate }) {
        this.length = length; this.sampleRate = sampleRate;
        this.duration = length / sampleRate; this.numberOfChannels = 1;
        AudioBuffer.requestedBytes += length * 4;
    }
    static requestedBytes = 0;
}
class Node {
    constructor(context) { this.context = context; this.connections = []; this.onended = null; context.nodes.push(this); }
    connect(node) { this.connections.push(node); }
    disconnect() { this.connections.length = 0; }
    start(when = 0, offset = 0, duration) {
        if (this.started) throw new Error("Node started twice");
        this.started = true; this.startedAt = Math.max(this.context.currentTime, when);
        if (this.buffer && !this.loop) this.ends = this.startedAt + (duration ?? this.buffer.duration - offset);
    }
    stop(when = 0) {
        if (!this.started) throw new Error("Node stopped before start");
        this.ends = Math.max(this.context.currentTime, when);
    }
}
export class AudioBufferSourceNode extends Node {
    constructor(context, options) { super(context); this.buffer = options.buffer; this.loop = false; }
}
class ConstantSourceNode extends Node { constructor(context) { super(context); this.offset = { value: 1 }; } }

const AudioTimeout = nativeClass("client/audio/timeout.mjs", { AudioBuffer, AudioBufferSourceNode });
export const Sound = nativeClass("client/audio/sound.mjs", { AudioTimeout, EventEmitterMixin });

class Model {
    constructor(data = {}, { parent } = {}) { Object.assign(this, data); this.parent = parent; }
    _onUpdate() {}
    _onDelete() {}
    async _preUpdate() {}
    async update(data, options = {}) {
        if (this.documentName === "Playlist") return transact(this, data, options);
        return transactSound(this, data, options);
    }
}
export const Playlist = nativeClass("client/documents/playlist.mjs", {
    BasePlaylist: Model, ClientDocumentMixin: (Base) => Base,
    PLAYLIST_MODES: CONST.PLAYLIST_MODES, PLAYLIST_SORT_MODES: { ALPHABETICAL: "a", MANUAL: "m" },
});
export const PlaylistSound = nativeClass("client/documents/playlist-sound.mjs", {
    BasePlaylistSound: Model, ClientDocumentMixin: (Base) => Base,
});

export async function flush() { for (let index = 0; index < 30; index++) await Promise.resolve(); }

export class AudioClock {
    currentTime = 100;
    sampleRate = 48000;
    nodes = [];
    ramps = [];
    destination = {};
    createConstantSource() { return new ConstantSourceNode(this); }
    createGain() {
        const context = this;
        const node = new Node(context);
        let base = 0;
        let events = [];
        const valueAt = (time) => {
            let previous = { value: base, time: -Infinity };
            for (const event of [...events].sort((a, b) => a.time - b.time)) {
                if (event.time > time) {
                    if (event.kind === "linear" && Number.isFinite(previous.time)) {
                        return previous.value + (event.value - previous.value) * (time - previous.time) / (event.time - previous.time);
                    }
                    break;
                }
                previous = event;
            }
            return previous.value;
        };
        node.gain = {
            get value() { return valueAt(context.currentTime); },
            set value(value) { base = value; events = []; },
            cancelScheduledValues(time) {
                const value = valueAt(time);
                events = events.filter((event) => event.time < time);
                events.push({ kind: "set", value, time });
            },
            setValueAtTime(value, time) {
                const event = { kind: "set", value, time }; events.push(event); context.ramps.push(event);
            },
            linearRampToValueAtTime(value, time) {
                const event = { kind: "linear", value, time }; events.push(event); context.ramps.push(event);
            },
        };
        return node;
    }
    async advance(seconds) {
        const target = this.currentTime + seconds;
        for (let iteration = 0; iteration < 1000; iteration++) {
            const next = this.nodes.filter((node) => !node.ended && Number.isFinite(node.ends) && node.ends <= target)
                .sort((a, b) => a.ends - b.ends)[0];
            if (!next) { this.currentTime = target; await flush(); return; }
            this.currentTime = Math.max(this.currentTime, next.ends);
            next.ended = true;
            next.onended?.();
            await flush();
        }
        throw new Error("Audio clock did not settle");
    }
}

export function initializeNativePlayback() {
    reset();
    Number.isNumeric ??= (value) => typeof value === "number" && Number.isFinite(value);
    globalThis.AudioBufferSourceNode = AudioBufferSourceNode;
    globalThis.CONFIG = {
        Playlist: { documentClass: Playlist, autoPreloadSeconds: undefined },
        PlaylistSound: { documentClass: PlaylistSound },
    };
    foundry.documents.Playlist = Playlist;
    foundry.documents.PlaylistSound = PlaylistSound;
    foundry.audio.Sound = Sound;
    document.querySelectorAll = () => [];
    const clock = new AudioClock();
    game.audio = {
        locked: false, music: clock, environment: clock, interface: clock,
        playing: new Map(), buffers: { lock() {} }, debug() {},
        create({ src, context }) {
            const sound = new Sound(src, { context });
            sound._load = async function () { this.buffer = { duration: 300 }; };
            return sound;
        },
    };
    AudioBuffer.requestedBytes = 0;
    return clock;
}

let index = 0;
export function makePlaylist({ id = "native" + (++index), fade = 0, mode = 0, count = 1, context = game.audio.music } = {}) {
    const parent = new CONFIG.Playlist.documentClass({
        id, documentName: "Playlist", isOwner: true, name: id, channel: "music", playing: false,
        mode, fade, sorting: "m", seed: 1,
    });
    parent.sounds = new Collection(Array.from({ length: count }, (_, number) => {
        const sound = new CONFIG.PlaylistSound.documentClass({
            id: "sound" + number, documentName: "PlaylistSound", isOwner: true,
            name: "Track " + number, path: "track" + number + ".ogg", playing: false,
            pausedTime: null, repeat: false, volume: 0.5, fade: null, sort: number,
        }, { parent });
        Object.defineProperty(sound, "context", { get: () => context });
        return sound;
    }));
    // Shuffle algorithm randomness is unrelated to these lifecycle tests.
    Object.defineProperty(parent, "playbackOrder", { get: () => parent.sounds.map((sound) => sound.id) });
    parent.transactions = [];
    game.playlists.set(parent.id, parent);
    return parent;
}

function apply(parent, changes) {
    for (const [key, value] of Object.entries(changes)) if (key !== "sounds") parent[key] = value;
    for (const change of changes.sounds ?? []) {
        const sound = parent.sounds.get(change._id ?? change.id);
        for (const [key, value] of Object.entries(change)) if (key !== "_id") sound[key] = value;
    }
    parent.prepareDerivedData();
}

export async function replay(parent, changes, options) {
    const message = structuredClone({ changes, options });
    apply(parent, message.changes);
    parent._onUpdate(message.changes, message.options, "gm");
    await flush();
}

async function transact(parent, changes, options) {
    const data = structuredClone(changes);
    const operation = { ...options };
    await parent._preUpdate(data, operation, game.user);
    await emit("preUpdatePlaylist", parent, data, operation, game.user.id);
    // Foundry copies hook-mutated options into the socket operation. Keep a
    // serializable message for replay through a second client's native classes.
    const message = structuredClone({ changes: data, options: operation });
    parent.transactions.push(message);
    apply(parent, data);
    parent._onUpdate(data, operation, game.user.id);
    await emit("updatePlaylist", parent, data, operation, game.user.id);
    await flush();
    return parent;
}

async function transactSound(sound, changes, options) {
    const data = structuredClone(changes); const operation = { ...options };
    await sound._preUpdate(data, operation, game.user);
    await emit("preUpdatePlaylistSound", sound, data, operation, game.user.id);
    Object.assign(sound, data);
    sound.parent.prepareDerivedData();
    sound._onUpdate(data, operation, game.user.id);
    await emit("updatePlaylistSound", sound, data, operation, game.user.id);
    await flush();
    return sound;
}
