import sys
sys.stdout.reconfigure(encoding='utf-8')
import urllib.parse, json, re

# Read line 37 from api.txt (the data-raw line)
with open(r'fastapi_app\services\api.txt', 'r', encoding='utf-8') as f:
    for i, line in enumerate(f, 1):
        if i == 37:
            raw_line = line.strip()
            break

# Extract the f.req value
match = re.search(r"f\.req=([^&]+)", raw_line)
if match:
    encoded = match.group(1)
    decoded = urllib.parse.unquote(encoded)
    outer = json.loads(decoded)
    # outer is [null, "inner_json_string"]
    inner = json.loads(outer[1])
    # Print first element (the message part)
    print("=== Message part (inner[0]) ===")
    print(json.dumps(inner[0], ensure_ascii=False, indent=2))
    print()
    # Print the rest
    for idx, item in enumerate(inner[1:], 1):
        val = json.dumps(item, ensure_ascii=False) if item is not None else "null"
        if len(val) > 200:
            val = val[:200] + "..."
        print(f"inner[{idx}]: {val}")
