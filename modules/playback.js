/** Live playback queries. PlaylistDirectory._playing is only a render cache. */
export function playbackSounds() {
    const sounds = [];
    for (const playlist of game.playlists) {
        if (playlist.visible === false) continue;
        for (const sound of playlist.sounds) {
            if ((sound.playing || hasPausedTime(sound)) && (sound.isOwner || sound.playing)) sounds.push(sound);
        }
    }
    return sounds;
}

/** A stored pause offset can be zero; null/undefined mean there is no pause. */
export function hasPausedTime(sound) {
    return Number.isFinite(sound.pausedTime) && sound.pausedTime >= 0;
}

export function audioChannel(playlist, sound) {
    return sound?.channel || playlist?.channel || "music";
}

export function normalizeVolume(value, fallback = 0.5) {
    const volume = Number(value);
    return Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : fallback;
}

export function fadeDuration(value) {
    const duration = Number(value);
    return Number.isFinite(duration) ? Math.min(10000, Math.max(0, duration)) : 0;
}

export function currentSeconds(sound) {
    const value = sound.playing ? sound.sound?.currentTime : sound.pausedTime;
    return Number.isFinite(value) && value >= 0 ? value : null;
}

export function durationSeconds(sound) {
    const value = sound.sound?.duration;
    return Number.isFinite(value) && value > 0 ? value : null;
}

export function timestamp(seconds) {
    return Number.isFinite(seconds) && seconds >= 0
        ? ui.playlists.constructor.formatTimestamp(seconds)
        : "--:--";
}

/** Prepare only active tracks, including sources which have not finished loading. */
export function playbackContext(sound) {
    const { volumeToInput, volumeToPercentage } = foundry.audio.AudioHelper;
    const { id, uuid, name, playing, repeat, isOwner } = sound;
    const volume = normalizeVolume(sound.volume);
    return {
        id, uuid, name, playing, repeat, isOwner,
        playlistId: sound.parent.id,
        css: playing ? "playing" : "",
        play: {
            icon: `fa-solid ${playing ? "fa-square" : hasPausedTime(sound) ? "fa-play-circle" : "fa-play"}`,
            label: hasPausedTime(sound) ? "PLAYLIST.SoundResume" : "PLAYLIST.SoundPlay",
        },
        pause: {
            disabled: !isOwner || !playing || !sound.sound?.loaded || sound.sound?.failed,
            icon: `fa-solid ${playing && !sound.sound?.loaded ? "fa-spinner fa-spin" : "fa-pause"}`,
        },
        volume: {
            modifier: volumeToInput(volume),
            field: new foundry.data.fields.NumberField({ min: 0, max: 1, step: 0.05 }),
            dataset: { tooltip: volumeToPercentage(volume) },
            aria: {
                label: game.i18n.localize("PLAYLIST_SOUND.FIELDS.volume.label"),
                valuetext: volumeToPercentage(volume, { label: true }),
            },
        },
        currentTime: timestamp(currentSeconds(sound)),
        durationTime: timestamp(durationSeconds(sound)),
    };
}

function setText(element, value) {
    if (element && value !== null && element.textContent !== value) element.textContent = value;
}

/**
 * Cache DOM references once per render, then visit each visible playback row once.
 * No document writes, synthetic input events, or full application renders on a tick.
 */
export class PlaybackRows {
    constructor(root) {
        this.rows = Array.from(root?.querySelectorAll(".sound[data-playlist-id][data-sound-id]") ?? [], (row) => ({
            row,
            current: row.querySelector("span.current"),
            duration: row.querySelector("span.duration"),
            pause: row.querySelector("button.pause"),
            volume: row.querySelector(".sound-volume"),
            lastVolume: undefined,
        }));
    }

    update({ volumes = false } = {}) {
        if (document.hidden) return;
        for (const entry of this.rows) {
            const { row, current, duration, pause, volume } = entry;
            if (!row.isConnected) continue;
            const sound = game.playlists.get(row.dataset.playlistId)?.sounds.get(row.dataset.soundId);
            if (!sound) continue;

            const seconds = currentSeconds(sound);
            if (seconds !== null) setText(current, timestamp(seconds));
            const total = durationSeconds(sound);
            if (total !== null) setText(duration, timestamp(total));

            const loading = !!sound.playing && !sound.sound?.loaded;
            if (pause) {
                const disabled = !sound.isOwner || !sound.playing || loading || !!sound.sound?.failed;
                if (pause.disabled !== disabled) pause.disabled = disabled;
                if (pause.classList.contains("fa-spinner") !== loading) {
                    pause.classList.toggle("fa-spin", loading);
                    pause.classList.toggle("fa-spinner", loading);
                    pause.classList.toggle("fa-pause", !loading);
                }
            }

            if (!volumes || !volume || volume === document.activeElement || volume.contains(document.activeElement)) continue;
            const numericVolume = normalizeVolume(sound.volume);
            if (entry.lastVolume === numericVolume) continue;
            entry.lastVolume = numericVolume;
            const input = foundry.audio.AudioHelper.volumeToInput(numericVolume);

            // HTMLFormElement.value in v13 dispatches input AND change, even when
            // changed programmatically. Its protected setters update the view quietly.
            if (typeof volume._setValue === "function" && typeof volume._refresh === "function") {
                volume._setValue(input);
                volume._refresh();
            } else if (Number(volume.value) !== input) volume.value = input;

            const tooltip = foundry.audio.AudioHelper.volumeToPercentage(numericVolume);
            volume.dataset.tooltip = tooltip;
            volume.dataset.tooltipText = tooltip;
            volume.ariaValueText = foundry.audio.AudioHelper.volumeToPercentage(numericVolume, { label: true });
        }
    }
}
