#!/bin/sh
# Speaks every case in cases.json with macOS voices into audio/<id>.m4a (16 kHz mono AAC, 32 kbps:
# what the terminal records). Needs `say` (macOS) and ffmpeg. Synthetic speech is clean; real
# counters are noisy, so this is a floor for accuracy, not a measure of it.
cd "$(dirname "$0")" && mkdir -p audio
python3 - <<'PY' | while IFS='	' read -r id voice text; do
import json
for c in json.load(open('cases.json')):
    print(c['id'], c.get('voice', ''), c.get('speak', ''), sep='\t')
PY
  [ -f "audio/$id.m4a" ] && continue
  if [ -z "$text" ]; then
    ffmpeg -loglevel error -y -f lavfi -i "anoisesrc=d=2.5:c=pink:a=0.08" -ac 1 -ar 16000 -c:a aac -b:a 32k "audio/$id.m4a"
  else
    say -v "$voice" -o "audio/$id.aiff" "$text" && ffmpeg -loglevel error -y -i "audio/$id.aiff" -ac 1 -ar 16000 -c:a aac -b:a 32k "audio/$id.m4a" && rm -f "audio/$id.aiff"
  fi
  echo "$id"
done
