#!/bin/sh
# Fetches the archive page the offline tests play (kept out of the repo: it's J! Archive's).
cd "$(dirname "$0")/fixtures" && curl -sS -o game9537.html "https://j-archive.com/showgame.php?game_id=9537" && ls -la game9537.html
