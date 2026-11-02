import { PlaybackRows, playbackSounds, playbackContext } from "./playback.js";

export class EnchantmentPopup extends foundry.applications.api.HandlebarsApplicationMixin(
  foundry.applications.api.ApplicationV2
) {
  static PARTS = {
    main: {
      root: true,
      template: "modules/playlistenchantment/templates/currentplayling.hbs",
      templates: ["modules/playlistenchantment/templates/playlist/sound-partial.hbs"],
    },
  };

  static DEFAULT_OPTIONS = {
    id: "enchantment-popup",
    window: { frame: false },
    classes: ["enchantmentplaylisttooltip", "playlists-sidebar"],
  };

  constructor(macroId, name) {
    super();
    this.macroId = macroId;
    this.popupName = name;
    this._volumeSyncTimer = null;
    this._closeTimer = null;
    this._timestampTimer = null;
    this._syncTimer = null;
    this._lastStateKey = "";
    this._syncInFlight = false;
    this._syncRequested = false;
    this._closing = false;
    this._closePromise = null;
    this._playbackRows = null;
    this._onVisibilityChange = () => {
      if (!document.hidden && this._syncRequested && !this._closing) this.scheduleSync();
    };
  }

  _getStateKey(sounds = playbackSounds()) {
    return JSON.stringify(sounds.map((sound) => [
      sound.parent.id, sound.id, sound.parent.mode, sound.name,
      sound.path,
      !!sound.playing, !!sound.repeat, !!sound.isOwner,
    ]));
  }

  async _prepareContext(options) {
    const data = await super._prepareContext(options);
    const sounds = playbackSounds();
    this._preparedStateKey = this._getStateKey(sounds);
    return Object.assign(data, {
      macroId: this.macroId,
      name: this.popupName,
      isGM: game.user.isGM,
      playingSounds: sounds.map(playbackContext),
      showPlaying: sounds.length > 0,
    });
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    if (this._closing) return;

    this.element.dataset.macroId = this.macroId;
    this._lastStateKey = this._preparedStateKey;
    this._playbackRows = new PlaybackRows(this.element);
    this._startTimestampUpdates();
    const template = $(this.element);
    ui.playlists.activateSoundListeners(template);

    template
      .off("click.playlistenchantment", "[data-action]")
      .on("click.playlistenchantment", "[data-action]", async (ev) => {
        const target = ev.currentTarget;
        if (target.disabled) return;
        if (!hasLiveSound(target)) { this.scheduleSync(); return; }
        let handler = ui.playlists.options.actions[target.dataset.action];
        if (!handler) return;
        let buttons = [0];
        if (typeof handler === "object") {
          buttons = handler.buttons ?? buttons;
          handler = handler.handler;
        }
        if (buttons.includes(ev.button)) await handler?.call(ui.playlists, ev, target);
      });

    template
      .off("input.playlistenchantment change.playlistenchantment", ".sound-volume")
      .on("input.playlistenchantment change.playlistenchantment", ".sound-volume", (ev) => {
        // v13's range-picker commits its own value only on release. During a drag
        // the inner input contains the live value; core accepts that input too.
        const slider = ev.target.matches("input") ? ev.target : ev.currentTarget;
        if (!hasLiveSound(slider)) { this.scheduleSync(); return; }
        ui.playlists._onSoundVolume(slider);
        this._scheduleVolumeSync();
      });

    template
      .off(".playlistenchantment-hover")
      .on("mouseenter.playlistenchantment-hover", () => this.cancelScheduledClose())
      .on("mouseleave.playlistenchantment-hover", () => this.scheduleClose());
    if (this._syncRequested) {
      this._syncRequested = false;
      this.scheduleSync();
    }
  }

  _scheduleVolumeSync() {
    if (this._volumeSyncTimer !== null) clearTimeout(this._volumeSyncTimer);
    this._volumeSyncTimer = setTimeout(() => {
      this._volumeSyncTimer = null;
      if (this._closing) return;
      ui.playlists?.syncPlaybackRows?.({ volumes: true });
      this.updateTimestamps();
    }, 120);
  }

  /** Coalesce document hooks and sidebar renders without building a render queue. */
  scheduleSync() {
    if (this._closing) return;
    if (document.hidden) {
      this._syncRequested = true;
      return;
    }
    if (this._syncTimer !== null) return;
    this._syncTimer = setTimeout(() => {
      this._syncTimer = null;
      void this.syncFromPlaylistDirectory().catch((error) =>
        console.error("Playlist Enchantment | Failed to refresh playback popup", error)
      );
    }, 50);
  }

  async syncFromPlaylistDirectory() {
    if (this._closing) return;
    if (document.hidden) {
      this._syncRequested = true;
      return;
    }
    if (this._syncInFlight || !this.rendered || !this.element) {
      this._syncRequested = true;
      return;
    }
    this._syncRequested = false;
    if (this._getStateKey() === this._lastStateKey) {
      this.updateTimestamps();
      return;
    }

    this._syncInFlight = true;
    try {
      await this.render({ parts: ["main"] });
    } finally {
      this._syncInFlight = false;
      if (this._syncRequested) {
        this._syncRequested = false;
        this.scheduleSync();
      }
    }
  }

  _startTimestampUpdates() {
    document.addEventListener?.("visibilitychange", this._onVisibilityChange);
    if (this._timestampTimer !== null) clearInterval(this._timestampTimer);
    this.updateTimestamps();
    this._timestampTimer = setInterval(() => this.updateTimestamps(), 1000);
  }

  updateTimestamps() {
    if (!this._closing && this.rendered) this._playbackRows?.update({ volumes: true });
  }

  scheduleClose(delay = 100) {
    this.cancelScheduledClose();
    this._closeTimer = setTimeout(() => {
      this._closeTimer = null;
      if (this.rendered) void this.close({ animate: false });
    }, delay);
  }

  cancelScheduledClose() {
    if (this._closeTimer !== null) clearTimeout(this._closeTimer);
    this._closeTimer = null;
  }

  close(options) {
    if (this._closePromise) return this._closePromise;
    this._closing = true;
    this.cancelScheduledClose();
    for (const key of ["_volumeSyncTimer", "_syncTimer"]) {
      if (this[key] !== null) clearTimeout(this[key]);
      this[key] = null;
    }
    if (this._timestampTimer !== null) clearInterval(this._timestampTimer);
    this._timestampTimer = null;
    this._playbackRows = null;
    document.removeEventListener?.("visibilitychange", this._onVisibilityChange);
    this._closePromise = Promise.resolve().then(() => super.close(options)).finally(() => {
      if (ui.enchantmentPopup === this) ui.enchantmentPopup = null;
    });
    return this._closePromise;
  }
}

function hasLiveSound(target) {
  const row = target.closest?.(".sound");
  return !row || !!game.playlists.get(row.dataset.playlistId)?.sounds.get(row.dataset.soundId);
}
