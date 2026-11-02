import { fadeDuration } from "./playback.js";

// Transition options travel with Foundry's update operation, never in saved data.
const requests = new WeakMap();
const operations = new WeakMap();
const transitions = new WeakMap();
const OPTION = "playlistEnchantmentTransition";

export function withPlaybackOptions(playlist, options, callback) {
    const operation = (operations.get(playlist) ?? Promise.resolve()).catch(() => {}).then(async () => {
        const request = { ...options };
        requests.set(playlist, request);
        try {
            return await callback();
        } finally {
            if (requests.get(playlist) === request) requests.delete(playlist);
        }
    });
    operations.set(playlist, operation);
    return operation.finally(() => {
        if (operations.get(playlist) === operation) operations.delete(playlist);
    });
}

export function preparePlaybackOptions(playlist, changes, options, sound) {
    const request = requests.get(playlist);
    if (!request || !options) return;
    const changeset = sound ? [{ ...changes, _id: sound.id }] : changes.sounds;
    if (!Array.isArray(changeset)) return;
    const entries = changeset.filter((change) => typeof change.playing === "boolean"
        && (!request.ids || request.ids.has(change._id ?? change.id)));
    if (!entries.length) return;
    options.playlistEnchantmentSkipExclusive = true;
    if (!Number.isFinite(request.duration)) return;
    const previous = options[OPTION];
    const sounds = previous?.playlistId === playlist.id ? [...previous.sounds] : [];
    for (const entry of entries) {
        const id = entry._id ?? entry.id;
        const index = sounds.findIndex((sound) => sound.id === id);
        const next = { id, playing: entry.playing };
        if (index < 0) sounds.push(next);
        else sounds[index] = next;
    }
    options[OPTION] = { playlistId: playlist.id, duration: fadeDuration(request.duration), sounds };
}

function arm(playlist, changes, options) {
    if (!playlist) return;
    const request = options?.[OPTION];
    if (request?.playlistId !== playlist.id || !Number.isFinite(request.duration) || !Array.isArray(request.sounds)) return;
    for (const change of changes) {
        const id = change._id ?? change.id;
        const sound = playlist.sounds.get(id);
        if (!sound || typeof change.playing !== "boolean") continue;
        if (!request.sounds.some((entry) => entry.id === id && entry.playing === change.playing)) continue;
        transitions.set(sound, { duration: fadeDuration(request.duration), playing: change.playing });
    }
}

function prune(sound) {
    const request = transitions.get(sound);
    if (!request) return;
    const source = sound.sound;
    const stopping = source?._state !== undefined && source._state === source.constructor.STATES?.STOPPING;
    if (!request.playing || !sound.playing || source?.failed
        || (source?.playing && !stopping && !request.starting)) transitions.delete(sound);
}

export function installPlaybackLifecycle() {
    const Playlist = CONFIG.Playlist.documentClass;
    const PlaylistSound = CONFIG.PlaylistSound.documentClass;
    if (!Playlist._playlistEnchantmentTransitions) {
        CONFIG.Playlist.documentClass = class EnchantedPlaylistDocument extends Playlist {
            static _playlistEnchantmentTransitions = true;
            _onUpdate(changes, options, userId) {
                arm(this, changes.sounds ?? [], options);
                return super._onUpdate(changes, options, userId);
            }
        };
    }
    if (PlaylistSound._playlistEnchantmentTransitions) return;
    CONFIG.PlaylistSound.documentClass = class EnchantedPlaylistSoundDocument extends PlaylistSound {
        static _playlistEnchantmentTransitions = true;

        get fadeDuration() {
            const request = transitions.get(this);
            if (!request || request.scheduling) return super.fadeDuration;
            const duration = this.sound?.duration;
            return Number.isFinite(duration)
                ? Math.min(request.duration, Math.ceil(duration / 2) * 1000) : request.duration;
        }

        _onUpdate(changes, options, userId) {
            if ("path" in changes || "channel" in changes) transitions.delete(this);
            arm(this.parent, [{ ...changes, _id: this.id }], options);
            try { return super._onUpdate(changes, options, userId); }
            finally { prune(this); }
        }

        sync() {
            try { return super.sync(); }
            finally { prune(this); }
        }

        _scheduleFadeOut() {
            const request = transitions.get(this);
            if (request) request.scheduling = true;
            try { return super._scheduleFadeOut(); }
            finally { if (request) request.scheduling = false; }
        }

        async _onStart(event) {
            if (event?.target && event.target !== this.sound) {
                // The play event fires while Sound#play is still assigning its
                // operation promise. Let that assignment finish before stopping.
                void Promise.resolve().then(() => event.target.stop({ fade: 0 })).catch((error) =>
                    console.error("Playlist Enchantment | Could not stop an obsolete audio source", error)
                );
                return;
            }
            const request = transitions.get(this);
            if (request) request.starting = true;
            try { return await super._onStart(event); }
            finally { if (transitions.get(this) === request) transitions.delete(this); }
        }

        _onEnd(event) {
            if (event?.target && event.target !== this.sound) return;
            return super._onEnd(event);
        }

        _onDelete(...args) {
            transitions.delete(this);
            return super._onDelete(...args);
        }
    };
}
