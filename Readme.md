![Version](https://img.shields.io/github/v/tag/Plushtoast/playlistenchantment?label=Version&style=flat-square&color=2577a1) ![Foundry Core Compatible Version](https://img.shields.io/badge/dynamic/json.svg?url=https%3A%2F%2Fraw.githubusercontent.com%2FPlushtoast%2Fplaylistenchantment%2Ffoundry13%2Fmodule.json&label=Foundry%20Core%20Compatible%20Version&query=$.compatibility.verified&style=flat-square&color=ff6400)

# Playlist Enchantment

> **Local v1.3.12 Foundry VTT 13.351 patch.** This fixes the document registration failure that broke existing playlist controls in 1.3.11. **Fully reload every client.** See [BOOTSTRAP_FIX.md](BOOTSTRAP_FIX.md) for the cause and verification; earlier review results are preserved in `PR_REVIEW.md` and `REVIEW.md`.

Some minor tweaks to enhance the playlist experience. Drag playlists to the hotbar and enjoy some additional playlist controls. Read more on the github project page.
This is a module for Foundry VTT.

## Installation
This local build is installed in the module folder. Reload every Foundry client to load the updated JavaScript. The upstream v14 release uses a different compatibility target and does not include these local patches.

## Features

* Currently played tracks also now have a background color for better visibility
* Tracks can be started with a default volume other than 50% by default. This will not apply to soundboards. Also it'll overwrite any existing volume settings for that sound. Drag the volume slider for 'Normalize' to the desired value and check the checkbox next to it to enable this function.
* Tracks can have a default fade in time. It will overwrite any existing fade time on playlists. Drag the slider next to 'Fade' to set the fade duration and enable the functionality by checking the corresponding checkbox.
* New buttons to pause/start/forward/rewind all currently played tracks in the playlist directory.
* Double click on a song in a playlist starts to play the sound
* Drag playlists to the hotbar to create a playlist macro. It crossfades other playlists on the same audio channel while retaining other channels and soundboards. Grouped Next/Previous and automatic next-track playback preserve intentionally concurrent playlists.
* Sounds have an option in their context menu for the gamemaster to be played without the players hearing the sound.
* Drag a playlist folder to the hotbar to create a macro which starts a random playlist from the folder on each click.
* Long song names loop in a marquee to be readable entirely
* Drop Soundfiles from your local filebrowser onto any playlist to upload the sound to Foundry and add it to the playlist (Credits go to @janckoch with the origin module [Ensemble](https://github.com/janckoch/Ensemble) )
* The loop sound icon is replace with a colored toggle switch for better indication of the repeat state

![grafik](https://github.com/Plushtoast/playlistenchantment/assets/44941845/a64a4f61-267b-42d0-9842-33e10a984ea0)
![grafik](https://github.com/Plushtoast/playlistenchantment/assets/44941845/c3bbc9c4-caa3-406a-a9ff-1c7d4343556d)
