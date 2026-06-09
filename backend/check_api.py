import httpx, json

headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Accept": "application/json",
}

r = httpx.get("https://otruyenapi.com/v1/api/home", headers=headers, timeout=15, verify=False)
d = r.json()
items = d.get("data", {}).get("items", [])
print(f"Total items: {len(items)}")
statuses = set()
for i in items[:15]:
    name = i.get("name", "N/A")[:40]
    status = i.get("status", "N/A")
    statuses.add(status)
    cl = i.get("chaptersLatest") or i.get("chapters_latest") or []
    print(f'  {name:40s}  status="{status}"  chaptersLatest={len(cl)}')
print(f"\nAll unique statuses: {statuses}")
