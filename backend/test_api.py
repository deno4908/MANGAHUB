import asyncio
from curl_cffi.requests import AsyncSession

async def test():
    async with AsyncSession(impersonate="chrome131") as s:
        r = await s.get(
            "https://otruyenapi.com/v1/api/home",
            headers={"accept": "application/json"},
        )
        d = r.json()
        items = d.get("data", {}).get("items", [])
        print(f"OK - Status: {r.status_code} - Items: {len(items)}")

asyncio.run(test())
