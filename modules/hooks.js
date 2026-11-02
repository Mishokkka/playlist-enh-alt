import { EnchantedPlaylist } from "./enchantedplaylist.js";
import { EnchantmentPopup } from "./enchantmentpopup.js";
import { normalizeVolume, fadeDuration } from "./playback.js";
import { preparePlaybackOptions } from "./playback-lifecycle.js";
const { getProperty } = foundry.utils;
let popupRequest = 0;
let popupOperation = Promise.resolve();

export function setupHooks() {
  Hooks.on("hotbarDrop", (bar, data, slot) => {
    if (["PlaylistSound", "Playlist"].includes(data.type)) {
      buildPlaylistMacro(data.uuid, slot);
      return false;
    } else if (data.type === "Folder") {
      const folder = fromUuidSync(data.uuid);
      if (folder?.type === "Playlist") {
        buildPlaylistMacro(data.uuid, slot);
        return false;
      }
    }
  });

  Hooks.on("getPlaylistSoundContextOptions", (app, options) => {
    options.push({
      name: "PLAYLISTENCHANTMENT.Prehear",
      icon: "<i class='fas fa-music'></i>",
      callback: (item) => preHearSound(item),
    });
  });

  Hooks.on("renderHotbar", (bar, html) => {
    const root = $(html);

    // Delegated, namespaced handlers stay constant even if Foundry re-renders slots.
    root
      .off(".playlistenchantment")
      .on("mouseenter.playlistenchantment", ".slot.full", onHoverMacros)
      .on("mouseleave.playlistenchantment", ".slot.full", () => ui.enchantmentPopup?.scheduleClose())
      .on("mousedown.playlistenchantment", ".slot.full", () => {
        ++popupRequest;
        void ui.enchantmentPopup?.close({ animate: false });
      });
  });

  Hooks.on("preUpdatePlaylist", (playlist, changes, options) => {
    preparePlaybackOptions(playlist, changes, options);
    if (!Array.isArray(changes.sounds)) return;

    // Native stopAll omits pausedTime. Clear old pauses when stopping, but
    // preserve an explicitly supplied offset (including zero) for Pause All.
    if (changes.playing === false) {
      for (const sound of changes.sounds) {
        if (sound.playing === false && !("pausedTime" in sound)) sound.pausedTime = null;
      }
    }
    if (playlist.mode < 0 || !changes.sounds.some((sound) => sound.playing === true)) return;
    const settings = game.settings.get("playlistenchantment", "settings");
    if (settings.alwaysFade) changes.fade = fadeDuration(settings.fadeModifier);
    if (settings.normalize) {
      for (const sound of changes.sounds) {
        if (sound.playing === true) sound.volume = normalizeVolume(settings.normalizeModifier);
      }
    }
  });

  Hooks.on("preUpdatePlaylistSound", (sound, changes, options) => {
    preparePlaybackOptions(sound.parent, changes, options, sound);
    if (sound.parent?.mode < 0 || changes.playing !== true) return;
    const settings = game.settings.get("playlistenchantment", "settings");
    if (settings.normalize) changes.volume = normalizeVolume(settings.normalizeModifier);
  });

  Hooks.on("updatePlaylist", (playlist, changes, options, userId) => {
    if (options?.playlistEnchantmentSkipExclusive) return;
    if (Array.isArray(changes.sounds)) {
      for (const change of changes.sounds) {
        if (change.playing !== true) continue;
        const sound = playlist.sounds.get(change._id ?? change.id);
        if (sound) EnchantedPlaylist.queueExclusiveFade(playlist, sound, userId);
      }
    } else if (changes.playing === true) {
      EnchantedPlaylist.queueExclusiveFade(playlist, null, userId);
    }
  });
  Hooks.on("updatePlaylistSound", (sound, changes, options, userId) => {
    if (!options?.playlistEnchantmentSkipExclusive && changes.playing === true) {
      EnchantedPlaylist.queueExclusiveFade(sound.parent, sound, userId);
    }
  });

  // Work even while the Playlist sidebar is inactive. No scanning or rendering
  // happens when the hotbar popup is closed.
  for (const hook of [
    "updatePlaylist", "updatePlaylistSound", "createPlaylistSound",
    "deletePlaylistSound", "deletePlaylist", "renderPlaylistDirectory",
  ]) {
    Hooks.on(hook, () => ui.enchantmentPopup?.scheduleSync());
  }
}

async function buildPlaylistMacro(uuid, slot) {
  const playlist = await fromUuid(uuid);
  if (!playlist) return false;

  const command = `CONFIG.ui.playlists.hotbarPlaylist(${JSON.stringify(uuid)})`;
  return createHotBarMacro(command, playlist.name, "icons/svg/sound.svg", slot, "Playlist");
}

function onHoverMacros(ev) {
  const slot = ev.currentTarget.dataset.slot;
  const macroId = game.user.hotbar[slot];
  if (!macroId) return;

  const macro = game.macros.get(macroId);
  if (!macro) return;

  const playlistType = getProperty(macro, "flags.enchantedplaylist.type");
  if (!playlistType) return;

  const request = ++popupRequest;
  const target = ev.currentTarget;
  popupOperation = popupOperation.catch(() => {}).then(() => showHotbarSoundMenu(target, macroId, request));
  void popupOperation.catch((error) => console.error("Playlist Enchantment | Failed to open hotbar popup", error));
}

async function preHearSound(item) {
  const playlistId = item.dataset.playlistId;
  const soundId = item.dataset.soundId;
  const sound = game.playlists.get(playlistId)?.sounds.get(soundId);
  if (!sound) return;

  const settings = game.settings.get("playlistenchantment", "settings");
  const rawVolume = settings.normalize ? settings.normalizeModifier : (sound.volume ?? 0.5);
  const volume = normalizeVolume(rawVolume);

  ui.notifications.info(`Fetching & Playing ${sound.name}`);
  const soundSource = await foundry.audio.AudioHelper.play({ src: sound.path, volume, loop: false }, false);
  if (!soundSource) return;
  new SoundPreview(soundSource, sound).render(true);
}

class SoundPreview extends foundry.applications.api.HandlebarsApplicationMixin(foundry.applications.api.ApplicationV2) {
  static PARTS = {
    main: {
      template: "modules/playlistenchantment/templates/soundpreview.hbs",
    },
  };

  static DEFAULT_OPTIONS = {
    window: {
      title: "PLAYLISTENCHANTMENT.Prehear",
    },
    actions: {
      stopSound: this._stopSound,
    },
  };

  constructor(sound, source) {
    super();
    this.sound = sound;
    this.source = source;
    this._closing = false;
    this._onSoundTerminated = () => this._closeFromSoundEvent();

    this.sound.addEventListener("stop", this._onSoundTerminated);
    this.sound.addEventListener("end", this._onSoundTerminated);
  }

  async _prepareContext(_options) {
    const data = await super._prepareContext(_options);
    data.sound = this.sound;
    data.source = this.source;
    return data;
  }

  static _stopSound(ev, target) {
    return this.close();
  }

  _detachSoundListeners() {
    if (!this.sound || !this._onSoundTerminated) return;
    this.sound.removeEventListener("stop", this._onSoundTerminated);
    this.sound.removeEventListener("end", this._onSoundTerminated);
  }

  async _closeFromSoundEvent() {
    if (this._closing) return;
    this._closing = true;
    this._detachSoundListeners();

    try {
      await super.close({ animate: false });
    } finally {
      this.sound = null;
      this.source = null;
    }
  }

  async close(options) {
    if (this._closing) return;
    this._closing = true;
    this._detachSoundListeners();

    try {
      if (this.sound) {
        try {
          await this.sound.stop();
        } catch (err) {
          console.warn("Playlist Enchantment | Failed to stop sound preview cleanly", err);
        }
      }
      return await super.close(options);
    } finally {
      this.sound = null;
      this.source = null;
    }
  }
}

async function showHotbarSoundMenu(target, macroId, request) {
  if (request !== popupRequest || !target?.isConnected || !target.matches(":hover")) return;
  const rect = target.getBoundingClientRect();
  const popupName = target.dataset.tooltipText || target.dataset.tooltip || game.macros.get(macroId)?.name || "";

  const oldPopup = ui.enchantmentPopup;
  if (oldPopup) {
    oldPopup.cancelScheduledClose?.();
    await oldPopup.close({ animate: false });
  }

  if (request !== popupRequest) return;
  const popup = new EnchantmentPopup(macroId, popupName);
  ui.enchantmentPopup = popup;
  await popup.render(true);

  // If another hover replaced this popup while it was rendering, close this stale instance.
  if (request !== popupRequest || ui.enchantmentPopup !== popup) {
    await popup.close({ animate: false });
    return;
  }

  const tooltip = $(popup.element);
  popup.setPosition({
    left: rect.x - 135 + rect.width / 2,
    top: rect.y - tooltip.height(),
  });

  if (!target.matches(":hover")) popup.scheduleClose();
  game.tooltip.deactivate();
}

function createHotBarMacro(command, name, img, slot, type) {
  const existing = game.macros.contents.find((macro) => macro.name === name && macro.command === command);
  if (existing) {
    game.user.assignHotbarMacro(existing, slot);
  } else {
    Macro.create(
      {
        name,
        type: "script",
        img,
        command,
        flags: {
          enchantedplaylist: {
            type,
          },
        },
      },
      { displaySheet: false }
    ).then((macro) => game.user.assignHotbarMacro(macro, slot));
  }
  return false;
}
