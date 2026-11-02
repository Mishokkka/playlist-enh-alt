import { EnchantedPlaylist } from "./enchantedplaylist.js"
import { setupHooks } from "./hooks.js"
import { installPickerOverride } from "./filelocation.js"
import { installAudioScheduler } from "./audio-scheduler.js"
import { installPlaybackLifecycle } from "./playback-lifecycle.js"

Hooks.once("init", () => {

    game.settings.register("playlistenchantment", "settings", {
        name: "playlistsettings",
        scope: "world",
        config: false,
        default: {
            normalize: false,
            normalizeModifier: 0.5,
            fadeModifier: 500,
            alwaysFade: false,
            playListLoopEnabled: false
        },
        type: Object,
        onChange: () => ui.playlists?.render({ parts: ["controls"] })
    });

    game.settings.register("playlistenchantment", "soundUploadFolder", {
        name: "PLAYLISTENCHANTMENT.soundUploadFolder",
        hint: "PLAYLISTENCHANTMENT.soundUploadFolderHint",
        scope: "world",
        config: true,
        type: String,
        filePicker: 'folder',
        default: "modules/playlistenchantment/storage"
    })

    game.settings.register("playlistenchantment", "optimizeFadeTimers", {
        name: "PLAYLISTENCHANTMENT.optimizeFadeTimers",
        hint: "PLAYLISTENCHANTMENT.optimizeFadeTimersHint",
        scope: "client",
        config: true,
        type: Boolean,
        default: true,
        requiresReload: true
    })

    CONFIG.ui.playlists = EnchantedPlaylist
    installPickerOverride()
})

Hooks.once("setup", () => {
    installAudioScheduler()
    installPlaybackLifecycle()
    setupHooks()
})
