Digimon Tile Adventure 1
=========================

Welcome to Digimon Tile Adventure!


Description
-----------

Yggdrasil, the supercomputer that rules the Digital World, has gone
rogue once again! Only a special Digimon, chosen by Homeostasis, can
defeat the 21 rulers of the 21 Sectors and stop Yggdrasil's plans to
Reboot the Digital World!

The game was developed from 29 September to 8 October 2026 with the
help of Claude Sonnet 5.

The data on the Digimon comes from wikimon.net with some creative
liberties on my part, e.g. in introducing two new Digimon Levels and
changing the Levels of some existing ones.

The storyline is likewise of my invention, but the inspiration is
strongly drawn from many different series and movies of the Digimon
Franchise.

I hope you enjoy it!

Paxt, Milan (Italy), 8 October 2026 CE


Disclaimer
-----------

Digimon and all related characters, names, and data are trademarks /
copyrights of Bandai and Toei Animation. This is an unofficial,
non-commercial fan project made for personal/educational purposes.
I am not affiliated with, endorsed by, or connected to Bandai, Toei
Animation, or any official Digimon property. Digimon data referenced
in this project was sourced from Wikimon, a fan-run wiki.


How to run it
-------------

1. Download/clone this repository, then open a terminal in the folder
   that contains this README (the "Daemon" project root).

2. Start the local dev server (serves everything with caching disabled,
   so any edits are always picked up on reload):

       python3 game/serve.py 8765

3. Open a browser and go to:

       http://localhost:8765/game/

   (Note the trailing /game/ — the server runs from this folder's root,
   not from inside game/, so the game itself lives at that path.)

4. To stop the server, go back to the terminal and press Ctrl+C.

Requirements: Python 3 (no other dependencies — the server uses only
Python's built-in http.server module, and the game itself is plain
HTML/CSS/JavaScript with no build step).
