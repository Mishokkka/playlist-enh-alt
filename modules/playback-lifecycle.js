import { fadeDuration } from "./playback.js";

// Transition options travel with Foundry's update operation, never in saved data.
const requests = new WeakMap();
const operations = new WeakMap();
const transitions = new WeakMap();
const OPTION = "playlistEnchantmentTransition";

/**
 * Serialize module-owned commands per playlist while public APIs and their
 * wrappers perform the work. The callback must await every document update;
 * pre-update hooks attach the scoped options to core's replicated operation.
 */
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

/** Attach transient playback intent without persisting fields on a document. */
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
    const sounds = new Map((previous?.playlistId === playlist.id && Array.isArray(previous.sounds)
        ? previous.sounds : []).filter((entry) => entry && typeof entry.id === "string")
        .map((entry) => [entry.id, entry]));
    for (const entry of entries) {
        const id = entry._id ?? entry.id;
        sounds.set(id, { id, playing: entry.playing });
    }
    options[OPTION] = { playlistId: playlist.id, duration: fadeDuration(request.duration), sounds: [...sounds.values()] };
}

function arm(playlist, changes, options) {
    if (!playlist || !Array.isArray(changes)) return;
    const request = options?.[OPTION];
    if (request?.playlistId !== playlist.id || !Number.isFinite(request.duration) || !Array.isArray(request.sounds)) return;
    const expected = new Map();
    for (const entry of request.sounds) {
        if (entry && typeof entry.id === "string" && typeof entry.playing === "boolean") {
            expected.set(entry.id, entry.playing);
        }
    }
    for (const change of changes) {
        const id = change._id ?? change.id;
        const sound = playlist.sounds.get(id);
        if (!sound || typeof change.playing !== "boolean") continue;
        if (expected.get(id) !== change.playing) continue;
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
    if (game._documentsReady) {
        console.warn("Playlist Enchantment | Document classes must be registered during init; keeping the current classes");
        return;
    }
    const Playlist = CONFIG.Playlist.documentClass;
    const PlaylistSound = CONFIG.PlaylistSound.documentClass;
    if (!Playlist._playlistEnchantmentTransitions) {
        CONFIG.Playlist.documentClass = class EnchantedPlaylistDocument extends Playlist {
            static _playlistEnchantmentTransitions = true;
            _onUpdate(changes, options, userId) {
                arm(this, changes.sounds ?? [], options);
                return super._onUpdate(changes, options, userId);
            }

            _onSoundEnd(sound) {
                const source = sound.sound;
                return withPlaybackOptions(this, {}, () => {
                    // A queued completion must not advance a replaced, stopped
                    // or restarted track. Continuation keeps concurrent layers.
                    if (!sound.playing || sound.sound !== source || source?.playing) return;
                    return super._onSoundEnd(sound);
                });
            }
        };
    }
    if (PlaylistSound._playlistEnchantmentTransitions) return;
    CONFIG.PlaylistSound.documentClass = class EnchantedPlaylistSoundDocument extends PlaylistSound {
        static _playlistEnchantmentTransitions = true;

        get fadeDuration() {
            // Core's sync uses a truthy pausedTime to suppress a stop fade.
            if (!this.playing && this.pausedTime === 0) return 0;
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
            const source = event?.target ?? this.sound;
            if (!this.playing || source !== this.sound) {
                // The play event fires while Sound#play is still assigning its
                // operation promise. Let that assignment finish before stopping.
                void Promise.resolve().then(() => {
                    if (source === this.sound && this.playing) return this._onStart(event);
                    return source?.stop({ fade: 0 });
                }).catch((error) =>
                    console.error("Playlist Enchantment | Could not stop a cancelled audio source", error)
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
