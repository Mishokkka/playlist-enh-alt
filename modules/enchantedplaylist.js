import { PlaybackRows, playbackSounds, playbackContext, hasPausedTime, audioChannel, normalizeVolume, fadeDuration } from "./playback.js";
import { FileLocation } from "./filelocation.js";
import { withPlaybackOptions } from "./playback-lifecycle.js";

const { mergeObject } = foundry.utils;
const { PlaylistDirectory } = foundry.applications.sidebar.tabs;

export class EnchantedPlaylist extends PlaylistDirectory {
    static DEFAULT_OPTIONS = {
        actions: {
            playlistPlay: this._enchantPlayback,
            playlistStop: this._enchantPlayback,
            playlistForward: this._enchantPlayback,
            playlistBackward: this._enchantPlayback,
            soundPlay: this._enchantPlayback,
            soundPause: this._enchantPlayback,
            soundStop: this._enchantPlayback,
            enchPlaylistBackward: this._enchantAllSkip,
            enchPlaylistForward: this._enchantAllSkip,
            enchPlay: this._enchantStartAll,
            enchStop: this._enchantStopAll,
            loopPlaylists: this._loopPlaylists,
        }
    };

    static _entryPartial = "modules/playlistenchantment/templates/playlist/playlist-partial.hbs";

    static PARTS = {
        header: super.PARTS.header,
        controls: {
            template: "modules/playlistenchantment/templates/playlist/controls.hbs"
        },
        directory: super.PARTS.directory,
        playing: {
            template: "modules/playlistenchantment/templates/playlist/playing.hbs",
            templates: ["modules/playlistenchantment/templates/playlist/sound-partial.hbs"]
        },
        footer: super.PARTS.footer
    };

    static defaultUploadPlaylistName = "Playlistenchantment - Uploads";
    static _crossFadeRequest = 0;
    static _crossFadeOperation = Promise.resolve();
    static _exclusivePending = new Map();
    static _exclusiveTimer = null;
    static _settingsOperation = Promise.resolve();
    _playbackRows = null;

    async _prepareContext(_options) {
        const data = await super._prepareContext(_options);

        const enchantment = game.settings.get("playlistenchantment", "settings");
        const volume = normalizeVolume(enchantment.normalizeModifier);
        const normalizeModifier = foundry.audio.AudioHelper.volumeToInput(volume);
        mergeObject(data, {
            enchantment,
            normalizeModifier,
            normalizeTooltip: foundry.audio.AudioHelper.volumeToPercentage(volume),
            fadeTooltip: this.fadeTooltip(enchantment.fadeModifier),
        });

        return data;
    }

    /** Keep compatibility with earlier v13 builds as well as 13.351. */
    _preparePlaylistContext(root, playlist) {
        const context = super._preparePlaylistContext(root, playlist);
        context.playing = playlist.playing;
        // Core tests pausedTime for truthiness and omits an offset of exactly 0.
        // Keep those rows in both the directory and its currently-playing part.
        let included;
        for (const entry of context.sounds) {
            const sound = playlist.sounds.get(entry.id);
            if (sound?.playing || sound?.pausedTime !== 0) continue;
            Object.assign(entry, playbackContext(sound));
            included ??= new Set(this._playing.sounds);
            if (included.has(sound)) continue;
            included.add(sound);
            this._playing.sounds.push(sound);
            this._playing.context.push(entry);
        }
        return context;
    }

    async _onRender(context, options) {
        await super._onRender(context, options);
        if (options.parts.includes("playing")) {
            this._playbackRows = new PlaybackRows(this.element.querySelector(".currently-playing"));
            this._playbackRows.update();
        }
    }

    _onClose(options) {
        this._playbackRows = null;
        super._onClose(options);
    }

    /** Use core's existing one-second clock, without global or per-sound DOM searches. */
    updateTimestamps() {
        this.syncPlaybackRows();
    }

    syncPlaybackRows(options) {
        if (document.hidden) return;
        if (this.rendered && !this.minimized && (this.isPopout || (this.active && ui.sidebar?.expanded))) {
            this._playbackRows?.update(options);
        }
        const popout = this.popout;
        if (popout?.rendered && !popout.minimized) popout._playbackRows?.update(options);
    }

    /**
     * Bind only the listeners which belong to the part that Foundry just rendered.
     * This avoids rescanning and rebinding the entire PlaylistDirectory after every
     * ApplicationV2 partial render.
     */
    _attachPartListeners(partId, htmlElement, options) {
        super._attachPartListeners(partId, htmlElement, options);
        const html = $(htmlElement);

        if (partId === "controls") this.activateControlListeners(html);
        if (["directory", "playing"].includes(partId)) this.activateSoundListeners(html);
    }

    /** Retained as a compatibility helper for the hotbar popup. */
    activateListeners(html) {
        this.activateControlListeners(html);
        this.activateSoundListeners(html);
    }

    activateControlListeners(html) {
        html.find(".enchantment-volume-slider")
            .off("change.playlistenchantment")
            .on("change.playlistenchantment", this._onEnchantmentVolume.bind(this));

        html.find(".enchanment-checkbox")
            .off("change.playlistenchantment")
            .on("change.playlistenchantment", this._onEnchantmentCheckbox.bind(this));
    }

    activateSoundListeners(html) {
        // A fixed number of handlers per part, independent of the library size.
        html.off(".playlistenchantment-sounds")
            .on("dblclick.playlistenchantment-sounds", ".sound", this._onEnchantmentSound.bind(this))
            .on("mouseenter.playlistenchantment-sounds", ".sound .soundName", (ev) => {
                if (ev.currentTarget.scrollWidth > ev.currentTarget.clientWidth) {
                    ev.currentTarget.classList.add("marquee");
                }
            })
            .on("mouseleave.playlistenchantment-sounds", ".sound .soundName", (ev) => {
                ev.currentTarget.classList.remove("marquee");
            });
    }

    async _onEnchantmentSound(ev) {
        if (ev.target?.closest?.("button, input, range-picker, [data-action]")) return;
        const { playlistId, soundId } = ev.currentTarget.dataset;
        await EnchantedPlaylist._finishPendingCrossFade();
        const playlist = game.playlists.get(playlistId);
        const sound = playlist?.sounds.get(soundId);
        if (playlist?.isOwner && sound) return playlist.playSound(sound);
    }

    fadeTooltip(value) {
        return game.i18n.format("PLAYLISTENCHANTMENT.FadeTooltip", { value });
    }

    _onEnchantmentVolume(ev) {
        ev.preventDefault();
        const slider = ev.currentTarget;
        let volume;
        let tooltip;

        if (slider.dataset.volume) {
            volume = foundry.audio.AudioHelper.inputToVolume(slider.value);
            tooltip = foundry.audio.AudioHelper.volumeToPercentage(volume);
        } else if (slider.dataset.unit) {
            volume = Number(slider.value);
            tooltip = this.fadeTooltip(slider.value);
        }

        slider.setAttribute("data-tooltip", tooltip);
        game.tooltip.activate(slider, { text: tooltip });
        return this.updatePlaylistEnchantment({ [slider.name]: volume });
    }

    static async hotbarPlaylist(playlistId) {
        return this.crossFade(playlistId);
    }

    static uuidFromHotbarMacro(macro) {
        return macro?.command?.match(/hotbarPlaylist\(\s*["'\x60]([^"'\x60]+)["'\x60]\s*\)/)?.[1];
    }

    static async playHotbarMacro(macroId) {
        const macro = game.macros.get(macroId);
        const uuid = this.uuidFromHotbarMacro(macro);
        return uuid ? this.hotbarPlaylist(uuid) : macro?.execute();
    }

    /** A later manual transport action supersedes a pending macro selection. */
    static async _finishPendingCrossFade() {
        ++this._crossFadeRequest;
        await this._crossFadeOperation.catch(() => {});
    }

    static async _enchantPlayback(event, target) {
        await EnchantedPlaylist._finishPendingCrossFade();
        return PlaylistDirectory.DEFAULT_OPTIONS.actions[target.dataset.action].call(this, event, target);
    }

    /** Backport v14's exclusive Fade option, batching parent and child hooks. */
    static queueExclusiveFade(playlist, sound, userId) {
        if (!userId || userId !== game.user.id || playlist.mode < 0) return;
        if (!game.settings.get("playlistenchantment", "settings").alwaysFade) return;
        const incoming = sound ? [sound] : playlist.sounds.filter((entry) => entry.playing);
        for (const entry of incoming) this._exclusivePending.set(audioChannel(playlist, entry), playlist);
        if (this._exclusiveTimer !== null) return;
        this._exclusiveTimer = setTimeout(() => {
            this._exclusiveTimer = null;
            const pending = new Map(this._exclusivePending);
            this._exclusivePending.clear();
            const settings = game.settings.get("playlistenchantment", "settings");
            if (!settings.alwaysFade) return;
            for (const [channel, incoming] of pending) {
                if (!incoming.sounds.some((entry) => entry.playing && audioChannel(incoming, entry) === channel)) pending.delete(channel);
            }
            const fade = fadeDuration(settings.fadeModifier);
            const operations = [];
            for (const other of game.playlists.playing) {
                if (!other.isOwner || other.mode < 0) continue;
                const channels = new Set([...pending].filter(([, incoming]) => incoming.id !== other.id)
                    .map(([channel]) => channel));
                operations.push(this._stopChannels(other, channels, fade));
            }
            void Promise.all(operations).catch((error) =>
                console.error("Playlist Enchantment | Failed to crossfade another playlist", error)
            );
        }, 0);
    }

    static async _stopChannels(playlist, channels, duration) {
        const selectedChannels = new Set(channels);
        const ids = new Set();
        return withPlaybackOptions(playlist, { duration, ids }, async () => {
            // Earlier queued commands can start or move layers. Decide from the
            // live documents only after the playlist's preceding operation ends.
            const targets = playlist.sounds.filter((sound) => sound.playing
                && selectedChannels.has(audioChannel(playlist, sound)));
            if (!targets.length) return;
            const mixed = playlist.sounds.some((sound) => (sound.playing || hasPausedTime(sound))
                && !selectedChannels.has(audioChannel(playlist, sound)));
            for (const sound of targets) ids.add(sound.id);
            // Keep module wrappers responsible for cleanup, looping and replication.
            if (!mixed) return playlist.stopAll();
            for (const sound of targets) await playlist.stopSound(sound);
        });
    }

    /**
     * Start through the public Playlist API before stopping the outgoing channel.
     * One-shot fade options are replicated by core without changing saved fields.
     */
    static crossFade(uuid) {
        const request = ++this._crossFadeRequest;
        const operation = this._crossFadeOperation.catch(() => {}).then(async () => {
            const thing = await fromUuid(uuid);
            if (request !== this._crossFadeRequest) return;
            let playlist;
            let sound;
            if (thing?.documentName === "Playlist") playlist = thing;
            else if (thing?.documentName === "PlaylistSound") {
                sound = thing;
                playlist = sound.parent;
            } else if (thing?.documentName === "Folder" && thing.type === "Playlist") {
                const choices = thing.contents.filter((entry) => entry.isOwner && entry.mode >= 0 && entry.sounds.size);
                playlist = choices[Math.floor(Math.random() * choices.length)];
            }
            if (!playlist) {
                ui.notifications.error("Can't start Playlist - not found or empty");
                return;
            }
            if (!playlist.isOwner) {
                ui.notifications.warn(game.i18n.localize("PLAYLISTENCHANTMENT.errorNoPermission"));
                return;
            }
            if (!playlist.sounds.size || (!sound && playlist.playing)) return;

            const settings = game.settings.get("playlistenchantment", "settings");
            const duration = fadeDuration(settings.fadeModifier);
            await withPlaybackOptions(playlist, { duration }, () =>
                sound ? playlist.playSound(sound) : playlist.playAll()
            );
            if (request !== this._crossFadeRequest || !playlist.playing || playlist.mode < 0) return;
            const incoming = sound ? [sound] : playlist.sounds.filter((entry) => entry.playing);
            const channels = new Set(incoming.map((entry) => audioChannel(playlist, entry)));
            await Promise.all(game.playlists.playing
                .filter((other) => other.id !== playlist.id && other.isOwner && other.mode >= 0)
                .map((other) => this._stopChannels(other, channels, duration)));
        });
        this._crossFadeOperation = operation;
        return operation;
    }

    static async _enchantStartAll(ev, target) {
        const macroId = target.closest?.("[data-macro-id]")?.dataset.macroId;
        if (macroId) return EnchantedPlaylist.playHotbarMacro(macroId);
        await EnchantedPlaylist._finishPendingCrossFade();

        const updatesByPlaylist = new Map();
        for (const sound of playbackSounds()) {
            const playlist = sound.parent;
            if (!playlist.isOwner || playlist.mode < 0 || sound.playing) continue;
            if (playlist.mode !== CONST.PLAYLIST_MODES.SIMULTANEOUS && playlist.playing) continue;
            const sounds = updatesByPlaylist.get(playlist) ?? [];
            // Sequential/shuffle playlists can only resume one track at a time.
            if (playlist.mode === CONST.PLAYLIST_MODES.SIMULTANEOUS || !sounds.length) {
                sounds.push({ _id: sound.id, playing: true });
                updatesByPlaylist.set(playlist, sounds);
            }
        }
        return Promise.all([...updatesByPlaylist].map(([playlist, sounds]) =>
            withPlaybackOptions(playlist, {}, async () => {
                // Native playAll is one operation when every simultaneous track is
                // paused. Partial selections must keep playSound integrations.
                if (playlist.mode === CONST.PLAYLIST_MODES.SIMULTANEOUS && sounds.length === playlist.sounds.size) {
                    return playlist.playAll();
                }
                for (const { _id } of sounds) await playlist.playSound(playlist.sounds.get(_id));
            })
        ));
    }

    static async _enchantAllSkip(ev, target) {
        await EnchantedPlaylist._finishPendingCrossFade();
        const action = target.dataset.action;
        const direction = action === "enchPlaylistForward" ? 1 : -1;
        return Promise.all(game.playlists.playing.filter((playlist) => playlist.isOwner && playlist.mode >= 0)
            .map((playlist) => withPlaybackOptions(playlist, {}, () => playlist.playNext(null, { direction }))));
    }

    static async _loopPlaylists(ev, target) {
        await EnchantedPlaylist.updateSettings((settings) => ({ playListLoopEnabled: !settings.playListLoopEnabled }));
        ui.playlists.render();
    }

    static async _enchantStopAll(ev, target) {
        await EnchantedPlaylist._finishPendingCrossFade();
        const updatesByPlaylist = new Map();

        for (const sound of playbackSounds()) {
            const playlist = sound.parent;
            if (!playlist?.isOwner || !sound.playing) continue;

            let updates = updatesByPlaylist.get(playlist);
            if (!updates) {
                updates = [];
                updatesByPlaylist.set(playlist, updates);
            }

            updates.push({
                _id: sound.id,
                playing: false,
                pausedTime: sound.sound?.currentTime ?? sound.pausedTime ?? 0,
            });
        }

        return Promise.all(
            [...updatesByPlaylist].map(([playlist, updates]) =>
                playlist.updateEmbeddedDocuments("PlaylistSound", updates)
            )
        );
    }

    static updateSettings(data) {
        const update = typeof data === "function" ? data : foundry.utils.deepClone(data);
        const operation = this._settingsOperation.catch(() => {}).then(() => {
            const settings = foundry.utils.deepClone(game.settings.get("playlistenchantment", "settings"));
            mergeObject(settings, typeof update === "function" ? update(settings) : update);
            return game.settings.set("playlistenchantment", "settings", settings);
        });
        this._settingsOperation = operation;
        return operation;
    }

    updatePlaylistEnchantment(data) {
        return EnchantedPlaylist.updateSettings(data);
    }

    _onEnchantmentCheckbox(event) {
        const data = { [event.currentTarget.name]: event.currentTarget.checked };
        return this.updatePlaylistEnchantment(data);
    }

    async _onDrop(event) {
        event.preventDefault();
        const files = event.dataTransfer.files;
        if (files && files.length > 0) {
            const extensions = new Set(Object.keys(CONST.AUDIO_FILE_EXTENSIONS).map((ext) => ext.toLowerCase()));
            const filteredFiles = Array.from(files).filter((file) => {
                const extension = file.name.split(".").pop()?.toLowerCase();
                return extension && extensions.has(extension);
            });
            if (filteredFiles.length === 0) return;
            await this.handleAudioFilesUpload(event, filteredFiles);
        } else {
            return super._onDrop(event);
        }
    }

    isForge() {
        return typeof ForgeVTT !== "undefined" && ForgeVTT && ForgeVTT.usingTheForge;
    }

    findFilePicker() {
        return this.isForge() ? ForgeVTT_FilePicker : foundry.applications.apps.FilePicker.implementation;
    }

    async handleAudioFilesUpload(event, files) {
        const location = FileLocation.parse(game.settings.get("playlistenchantment", "soundUploadFolder"));
        const filepicker = this.findFilePicker();
        const dropTarget = event.target?.closest?.(".playlist");
        const playlistId = this.getPlaylistIdFromElement(dropTarget);
        let playlist = game.playlists.get(playlistId);
        if (!playlist) playlist = game.playlists.find((entry) => entry.name === EnchantedPlaylist.defaultUploadPlaylistName);
        if (playlist && !playlist.isOwner) {
            ui.notifications.warn(game.i18n.localize("PLAYLISTENCHANTMENT.errorNoPermission"));
            return;
        }

        const existing = new Map();
        try {
            const result = await filepicker.browse(location.source, location.target, location.browseOptions);
            // Browse paths are URL encoded; File.name is already a literal name.
            // Decode the returned basename once, keeping case and literal %20.
            for (const path of result.files ?? []) existing.set(FileLocation.parse(path).name, path);
        } catch (error) {
            console.warn("Playlist Enchantment | Could not list upload folder; trying upload directly", error);
        }

        const sounds = [];
        let failed = false;
        for (const file of files) {
            let path = existing.get(file.name);
            if (!path) {
                const notification = ui.notifications.info(
                    game.i18n.format("PLAYLISTENCHANTMENT.uploading", { item: file.name }),
                    { permanent: true }
                );
                try {
                    const response = await filepicker.upload(
                        location.source, location.target, file, location.browseOptions, { notify: false }
                    );
                    if (!response?.path) throw new Error("Upload returned no file path");
                    path = response.path;
                    existing.set(file.name, path);
                } catch (error) {
                    failed = true;
                    console.error("Playlist Enchantment | Sound upload failed", error);
                    ui.notifications.error(game.i18n.format("PLAYLISTENCHANTMENT.uploadFailed", { item: file.name }));
                    continue;
                } finally {
                    ui.notifications.remove(notification);
                }
            }
            sounds.push({ name: file.name.split(".").slice(0, -1).join(".") || file.name, path });
        }
        if (!sounds.length) return;
        playlist ??= await foundry.documents.Playlist.create({
            name: EnchantedPlaylist.defaultUploadPlaylistName,
            description: "Files uploaded by drag and drop",
            playing: false,
        });
        await playlist.createEmbeddedDocuments("PlaylistSound", sounds);
        if (!failed) ui.notifications.info(game.i18n.localize("PLAYLISTENCHANTMENT.uploadDone"));
    }

    getPlaylistIdFromElement(el) {
        if (el == null) return false;

        const playlist = el.classList.contains("playlist") ? el : el.closest(".playlist");
        if (!playlist) {
            ui.notifications.error(game.i18n.localize("PLAYLISTENCHANTMENT.errorNoPlaylist"));
            return false;
        }
        return playlist.dataset.entryId;
    }
}
