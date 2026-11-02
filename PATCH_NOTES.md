# Playlist Enchantment 1.3.10 — follow-up correctness review

2026-11-02. Target: Foundry VTT 13.351. The 1.3.9 implementation had reproducible regressions; its passing tests did not establish full playback integration correctness. See `REVIEW.md`.

- Restore public `playAll`, `playSound`, `stopAll` and `stopSound` workflows so other modules keep their playback/cleanup handlers. Start the incoming playlist successfully before stopping another playlist.
- Carry one-shot fades in the core update operation's options. Apply them through the document playback lifecycle on each client; preserve saved fade fields and the separate end-of-track fade. Keep the legacy always-Fade setting's intentional default updates.
- Serialize scoped operations per playlist and settings writes. Preserve asynchronous start wrappers and discard obsolete source events; let native Sound loading wait for a pending stop.
- Make optimized fade timers honor `Sound.unscheduleAll`, raw pause/stop/end events and source ownership. Retain detected third-party scheduler wrappers and clean partial bindings before fallback.
- Resume full simultaneous selections with one native `playAll` call; resume partial selections through `playSound`. Use per-track stop calls for mixed channels when needed by their public workflow.
- Distinguish case-sensitive file names and decode browsed file names exactly once. Keep literal `%20` separate from a space.
- Join concurrent popup closes and retain application ownership until teardown. Ignore actions on removed sounds.
- Move document class installation to setup, after init configuration. Bound module fade settings to the slider's 0–10000 ms range. Ensure profiler cleanup covers setup errors.

Validation: 92 checks, including 12 regression cases which fail against the saved 1.3.9 build, and 15 tests of complete native v13 Sound/PlaylistSound/Playlist client lifecycles with simulated device/storage/transport boundaries. Game FPS, the actual audio device and the full live addon combination remain unmeasured.

# Playlist Enchantment 1.3.9 — local Foundry v13 performance audit

2026-11-02. Target: Foundry VTT 13.351. Full comparison, evidence, limitations and rollback instructions: `PERFORMANCE_AUDIT.md`.

- Replace v13's end-of-track fade timer with a silent AudioContext clock source. Core's AudioTimeout allocates a PCM buffer for the entire wait (about 55 MiB for five minutes at 48 kHz). Zero fades need no timer. Preserve pause/resume, repeat, native fade limits and other modules' `_cancelFadeOut()` calls. The client setting **Optimize fade timers** enables this workaround and can be disabled for comparison after reload.
- Cache playback row elements, update changed text only, skip hidden surfaces, and use core's existing sidebar clock.
- Synchronize range-picker values without synthetic input/change events or unintended volume writes. Popup volume changes use core's debounced document update and patch the visible controls without rendering the directory.
- Use a fixed number of delegated sound listeners per rendered part. Coalesce popup refreshes and preserve changes arriving during a render.
- Read live playback documents instead of the sidebar render cache. Include loading sounds and distinguish identical embedded sound IDs in different playlists.
- Batch Pause/Resume All by parent playlist and avoid restarting tracks which are already playing.
- Use native synchronized playback/fades on every client instead of extra local ramps and delayed stop timers. Supersede stale macro selections with newer transport actions.
- Backport channel-aware exclusive Fade for normal playback, stale-pause cleanup, assigned-macro popup playback, and Forge/S3 upload fixes. Validate failed uploads and reuse existing files.
- Restore `data-sound-uuid`; retain correct v13 render-context fields, simultaneous-track normalization, zero volume, preview cleanup and the existing hotbar macro API.
- Scope marquee styles and respect reduced motion. Refresh only the controls part when module settings change.

Validation: 65 automated checks using actual installed v13 classes, template compilation, syntax/JSON checks. Actual game FPS and audio-device playback remain unmeasured because UI/browser access was denied. The upstream v14 Studio/queue/DJ feature set requires a separate backport.

# Playlist Enchantment 1.3.8

## Popup timestamp reliability

- Fixed current and total track time in the hotbar popup freezing or remaining blank.
- The popup now owns one lightweight 1-second timestamp timer only while it is open, instead of depending on the Playlist sidebar being active.
- Timestamp updates resolve each rendered row back to the live `PlaylistSound` and its `Sound`, rather than relying on `PlaylistDirectory._playing`, which Foundry documents as a render cache.
- Total duration is updated as soon as audio metadata becomes available; a transient zero/unknown duration no longer overwrites a useful value.
- Removed the custom `EnchantedPlaylist.updateTimestamps()` override, leaving Foundry v13's native PlaylistDirectory clock lifecycle untouched.
- The popup timer is always cleared on close and reset on re-render, so it cannot accumulate during long sessions.

# Playlist Enchantment 1.3.7 local verified patch

Target: Foundry VTT v13.351 / v13 API.

Second-pass corrections on top of the 1.3.6 performance patch:

- Fixes the popup's Foundry v13 volume context handling. `PlaylistSoundRenderContext.volume` is an object, not a numeric volume.
- Uses the official `durationTime`, `repeat`, and `pause` render-context fields in the custom sound template.
- Uses `PlaylistSound.pausedTime` for paused timestamps instead of a non-existent render-context property.
- Delegates popup sound actions to Foundry v13's own PlaylistDirectory action handlers, avoiding divergent pause/play/stop/repeat behavior.
- Adds an explicit `playing` value to the custom playlist render context because v13 `PlaylistRenderContext` does not provide one.
- Fixes normalization tooltip percentage conversion.
- Fixes incremental popup volume tooltip conversion and avoids overwriting an actively-focused range picker.
- Crossfades every active sound in SIMULTANEOUS playlists rather than only the first sound.
- Waits briefly for Foundry to attach a newly-started local Sound source before applying fade-in, avoiding a playback/fade race.
- Awaits SoundPreview audio shutdown before closing its application.
- Makes drag-and-drop audio extension matching case-insensitive, replaces legacy `srcElement` usage, and guarantees upload progress notifications are removed on upload failure.
- Ignores unsupported file-only drops instead of creating an empty upload playlist and reporting a false successful upload.
- Stores fade duration as a number and normalizes legacy string values before applying them to Playlist updates.
- Ignores double-click-to-play when the double-click originated on a sound control.
- Cancels stale fade-stop timers on direct PlaylistSound playback updates as well as parent Playlist updates.
- Removes the upstream `manifest` and `download` fields from this local patched build so Foundry cannot silently replace it with an unpatched upstream release or point at the old archive. The upstream project URL is retained for attribution.

Retained 1.3.6 fixes:

- Preserves live sound-volume adjustment while coalescing expensive PlaylistDirectory refreshes.
- Uses ApplicationV2 part-scoped listener attachment for custom PlaylistDirectory controls and sound rows.
- Uses Foundry v13 `updateTimestamps()` and updates popup timestamps incrementally.
- Avoids unconditional full popup re-renders when the playing sound structure/state has not changed.
- Batches the global Stop action per parent Playlist while preserving `pausedTime`.
- Makes delayed crossfade stop timers cancellable and cancels stale timers when playback starts again.
- Preserves true zero-volume normalization.
- Normalizes all simultaneously-starting sounds in a Playlist update.
- Uses normal Application lifecycle for popup cleanup and clears global references/timers.
- Replaces popup O(P²) sound matching with a Map lookup.
- Uses delegated/namespaced hotbar and popup handlers.
- Cleans up SoundPreview audio listeners and prevents re-entrant close handling.
- Keeps `bundle/modules/init.js` as the module entry point, forwarding to the maintained source tree.

No visible controls, settings schema, macro command format, CSS, or translations were intentionally changed.
