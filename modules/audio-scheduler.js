/**
 * Foundry 13's AudioTimeout allocates silent PCM for the entire delay. A track's
 * end-of-track fade can therefore allocate tens of megabytes just for its timer.
 * A silent, unconnected ConstantSourceNode uses the same AudioContext clock
 * without allocating an audio buffer proportional to the track length.
 */
const nativeSchedule = foundry.documents.PlaylistSound.prototype._scheduleFadeOut;
const nativeCancel = foundry.documents.PlaylistSound.prototype._cancelFadeOut;

// Core's private scheduled-event set cannot track our clock source. Preserve the
// public cancellation API and the source's own pause/stop/end event lifecycle.
function bindCancellation(sound, cancel) {
    const descriptor = Object.getOwnPropertyDescriptor(sound, "unscheduleAll");
    const original = sound.unscheduleAll;
    const wrapper = function (...args) { cancel(); return original.apply(this, args); };
    const events = [];
    const unbind = () => {
        for (const event of events) sound.removeEventListener?.(event, cancel);
        if (sound.unscheduleAll !== wrapper) return;
        if (descriptor) Object.defineProperty(sound, "unscheduleAll", descriptor);
        else delete sound.unscheduleAll;
    };
    try {
        if (typeof original === "function") {
            Object.defineProperty(sound, "unscheduleAll", { value: wrapper, configurable: true, writable: true });
        }
        for (const event of ["pause", "stop", "end"]) {
            sound.addEventListener?.(event, cancel);
            events.push(event);
        }
    } catch (error) {
        unbind();
        throw error;
    }
    return unbind;
}

export function installAudioScheduler() {
    if (Number(game.release?.generation) !== 13) return;
    if (game.settings.get("playlistenchantment", "optimizeFadeTimers") === false) return;
    if (game._documentsReady) {
        console.warn("Playlist Enchantment | Fade scheduler must be registered during init; keeping the current class");
        return;
    }
    const Base = CONFIG.PlaylistSound.documentClass;
    if (Base._playlistEnchantmentScheduler) return;
    // Preserve another module's custom fade scheduler if it has replaced core's.
    if (Base.prototype._scheduleFadeOut !== nativeSchedule
        || Base.prototype._cancelFadeOut !== nativeCancel) {
        console.warn("Playlist Enchantment | Keeping another module's PlaylistSound fade scheduler");
        return;
    }

    CONFIG.PlaylistSound.documentClass = class EnchantedPlaylistSound extends Base {
        static _playlistEnchantmentScheduler = true;
        #fadeTimer = null;

        _scheduleFadeOut() {
            this._cancelFadeOut();
            const { sound, repeat, fadeDuration } = this;
            if (repeat || !sound || !Number.isFinite(sound.duration) || fadeDuration <= 0) return;
            const context = sound.context;
            if (typeof context?.createConstantSource !== "function") return super._scheduleFadeOut();

            const delay = Math.max(0, sound.duration - (sound.currentTime ?? 0) - (fadeDuration / 1000));
            let source;
            try {
                source = context.createConstantSource();
                source.offset.value = 0;
                const timer = this.#fadeTimer = { source, sound, unbind: null };
                timer.unbind = bindCancellation(sound, () => {
                    if (this.#fadeTimer === timer) this._cancelFadeOut();
                });
                source.onended = () => {
                    if (this.#fadeTimer?.source !== source) return;
                    this.#fadeTimer = null;
                    timer.unbind?.();
                    source.onended = null;
                    source.disconnect();
                    if (this.sound !== sound || !this.playing || this.repeat || !sound.playing) return;
                    void Promise.resolve(sound.fade(0, { duration: fadeDuration })).catch((error) =>
                        console.error("Playlist Enchantment | End-of-track fade failed", error)
                    );
                };
                const start = context.currentTime;
                source.start(start);
                source.stop(start + delay);
            } catch (error) {
                this._cancelFadeOut();
                source?.disconnect();
                console.warn("Playlist Enchantment | Falling back to core's audio timer", error);
                return super._scheduleFadeOut();
            }
        }

        _cancelFadeOut() {
            const timer = this.#fadeTimer;
            this.#fadeTimer = null;
            if (timer) {
                timer.unbind?.();
                timer.source.onended = null;
                try { timer.source.stop(); } catch (_) { /* Already ended. */ }
                timer.source.disconnect();
            }
            return super._cancelFadeOut();
        }

        sync() {
            if (!this.playing) this._cancelFadeOut();
            return super.sync();
        }

    };
}
