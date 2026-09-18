#!/usr/bin/env bash
# Move o resultado mais recente de um runQuery do GoRAG para .seed-cache/<nome>.json
# e diz se veio truncado. Resultado truncado NUNCA deve ser carregado.
#
#   ./scripts/take.sh aff-rituaria-d0
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p .seed-cache

DIR="${CLAUDE_TOOL_RESULTS:-}"
if [ -z "$DIR" ]; then
  DIR=$(ls -td "$HOME"/.claude/projects/*/*/tool-results 2>/dev/null | head -1)
fi
[ -n "$DIR" ] || { echo "não achei o diretório de tool-results; exporte CLAUDE_TOOL_RESULTS"; exit 1; }

LAST=$(ls -t "$DIR"/*runQuery*.txt "$DIR"/*.json 2>/dev/null | head -1)
[ -n "$LAST" ] || { echo "nenhum resultado de query em $DIR"; exit 1; }

python3 - "$LAST" ".seed-cache/$1.json" <<'PY'
import json, sys
raw = open(sys.argv[1]).read()
d = json.loads(raw)
# resultado grande vem embrulhado em [{"type":"text","text":"<json>"}]
if isinstance(d, list) and d and isinstance(d[0], dict) and 'text' in d[0]:
    d = json.loads(d[0]['text'])
json.dump(d, open(sys.argv[2], 'w'))
print(f"{sys.argv[2]}: rows={d.get('rowCount')} truncated={d.get('truncated')}")
if d.get('truncated'):
    print("ATENÇÃO: truncado — quebre a janela e rode de novo. Não carregue.")
    sys.exit(2)
PY
