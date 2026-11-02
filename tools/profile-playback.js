/** Optional read-only, bounded profiler. Import manually from the browser console. */
export async function profilePlayback(seconds = 20) {
    const duration = Math.min(120, Math.max(5, Number(seconds) || 20));
    const intervals = [];
    const counts = {};
    const registrations = [];
    let longTasks = 0;
    let longTaskMilliseconds = 0;
    let wasHidden = document.hidden;
    let observer;
    let frame;
    let previous = performance.now();
    const started = previous;
    const tick = (now) => {
        intervals.push(now - previous);
        previous = now;
        frame = requestAnimationFrame(tick);
    };
    const onVisibility = () => { wasHidden ||= document.hidden; };

    try {
        for (const name of ["renderPlaylistDirectory", "renderEnchantmentPopup", "updatePlaylist", "updatePlaylistSound"]) {
            counts[name] = 0;
            registrations.push([name, Hooks.on(name, () => { counts[name]++; })]);
        }
        document.addEventListener("visibilitychange", onVisibility);
        if (typeof PerformanceObserver !== "undefined" && PerformanceObserver.supportedEntryTypes?.includes("longtask")) {
            observer = new PerformanceObserver((list) => {
                for (const entry of list.getEntries()) { longTasks++; longTaskMilliseconds += entry.duration; }
            });
            observer.observe({ type: "longtask" });
        }
        frame = requestAnimationFrame(tick);
        await new Promise((resolve) => setTimeout(resolve, duration * 1000));
    } finally {
        cancelAnimationFrame(frame);
        observer?.disconnect();
        document.removeEventListener("visibilitychange", onVisibility);
        for (const [name, id] of registrations) Hooks.off(name, id);
    }
    const elapsed = performance.now() - started;
    intervals.sort((a, b) => a - b);
    const percentile = (fraction) => intervals.length ? intervals[Math.min(intervals.length - 1, Math.floor(intervals.length * fraction))] : 0;
    const report = {
        foundry: game.version,
        module: game.modules.get("playlistenchantment")?.version,
        optimizedFadeTimers: !!CONFIG.PlaylistSound.documentClass._playlistEnchantmentScheduler,
        seconds: Math.round(elapsed / 100) / 10,
        averageFPS: Math.round(intervals.length * 10000 / elapsed) / 10,
        frameP95ms: Math.round(percentile(0.95) * 10) / 10,
        frameMaxMs: Math.round((intervals.at(-1) ?? 0) * 10) / 10,
        framesOver50ms: intervals.filter((value) => value > 50).length,
        longTasks: observer ? longTasks : "unsupported",
        longTaskMilliseconds: observer ? Math.round(longTaskMilliseconds) : "unsupported",
        tabWasHidden: wasHidden,
        ...counts,
    };
    console.table(report);
    return report;
}
