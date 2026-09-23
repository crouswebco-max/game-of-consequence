#!/bin/bash
# Records the spoken lines with this Mac's built-in voices: the host's laugh,
# and each suspect introducing themselves. Double-click to (re)record.
cd "$(dirname "$0")/.." || exit 1
OUT="public/audio/raw"; mkdir -p "$OUT"
say -v '?' > "$OUT/voices.txt" 2>/dev/null

# First voice from the list that this Mac actually has.
pick() { for v in "$@"; do grep -q "^$v " "$OUT/voices.txt" && { echo "$v"; return; }; done; echo "Daniel"; }

HOST=$(pick "Daniel" "Arthur" "Oliver")
say -v "$HOST" -r 120 -o "$OUT/laugh.aiff" "Mwa ha ha ha ha ha ha. Ha ha ha ha haaa."
say -v "$HOST" -r 125 -o "$OUT/goodluck.aiff" "Good luck. You will need it."
WHISPER=$(pick "Whisper")
[ "$WHISPER" = "Whisper" ] && say -v Whisper -r 120 -o "$OUT/goodluck-whisper.aiff" "Good luck. You will need it."

say -v "$(pick Daniel Arthur Oliver)"          -r 150 -o "$OUT/voice-thorne.aiff" "Major Aldous Thorne. At your service."
say -v "$(pick Serena Kate Martha Stephanie)"  -r 155 -o "$OUT/voice-cross.aiff"  "Miss Vivienne Cross. Charmed, I'm sure."
say -v "$(pick Oliver Arthur Daniel)"          -r 165 -o "$OUT/voice-vale.aiff"   "Professor Edmund Vale. How fascinating."
say -v "$(pick Martha Kate Serena Moira)"      -r 140 -o "$OUT/voice-ashe.aiff"   "Lady Rosalind Ashe. I was nowhere near it."
say -v "$(pick Arthur Daniel Oliver Rishi)"    -r 145 -o "$OUT/voice-ward.aiff"   "Mr Cassius Ward. I have nothing to hide."
say -v "$(pick Fiona Moira Kate Karen)"        -r 145 -o "$OUT/voice-snow.aiff"   "Mrs Harriet Snow. This house has seen worse nights than this."

date > "$OUT/DONE"
echo ""; echo "  Voices recorded. You can close this window."; echo ""
