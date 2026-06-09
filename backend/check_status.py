import httpx

for endpoint in ['sap-ra-mat', 'dang-phat-hanh']:
    r = httpx.get(f'https://otruyenapi.com/v1/api/danh-sach/{endpoint}?page=1', headers={'accept': 'application/json'})
    d = r.json()
    items = d.get('data', {}).get('items', [])
    print(f"\n=== {endpoint} ===")
    for i in items[:3]:
        print(f"  name={i.get('name')[:30]}, status={repr(i.get('status'))}")
