import asyncio
import json
from copy import deepcopy

import pytest
from fastapi import HTTPException
from fastapi_app.services import qq_rating


@pytest.fixture(autouse=True)
def isolated_index(monkeypatch):
    values = {}
    monkeypatch.setattr(qq_rating, '_read', lambda key: deepcopy(values.get(key)))
    monkeypatch.setattr(qq_rating.card_metadata.cache, 'get_many',
        lambda keys: {key: json.dumps(values[key]) for key in keys if key in values})
    monkeypatch.setattr(qq_rating.card_metadata.cache, 'set_many',
        lambda data, **kw: values.update({key: json.loads(value) for key, value in data.items()}))
    def save(key, value):
        values.setdefault(key, deepcopy(value))
        return deepcopy(values[key])
    monkeypatch.setattr(qq_rating, '_save_page', save)


@pytest.mark.parametrize('positions', [[0, 30], [11, 88, 3], []])
def test_ratings_prefix_then_exact_latest_order_on_every_24_title_page(positions):
    catalog = [{'slug': f'book-{index}'} for index in range(100)]
    ranked = [catalog[index] for index in positions]
    calls = []
    async def source(number):
        calls.append(number)
        return {'data': {'items': catalog[(number-1)*42:number*42]}}
    async def run():
        output = []
        first = await source(1)
        for number in range(1, 6):
            rows, error, total = await qq_rating.page(number=number, limit=24, ranked=ranked,
                first=first, source=source, visible=lambda item: True, snapshot_key='sample',
                source_pages=3, total_bound=100)
            assert len(rows) == (24 if number < 5 else 4)
            assert error is None
            if number == 5:
                assert total == 100
            output.extend(row['slug'] for row in rows)
        return output
    expected = [row['slug'] for row in ranked] + [row['slug'] for row in catalog if row not in ranked]
    assert asyncio.run(run()) == expected
    assert calls == [1, 2, 3]  # one source read per native page across all five UI pages


def test_random_page_can_build_missing_cursors_then_reuses_them():
    catalog = [{'slug': f'book-{index}'} for index in range(180)]
    ranked = [catalog[35], catalog[0]]
    calls = []
    async def source(number):
        calls.append(number)
        return {'data': {'items': catalog[(number-1)*42:number*42]}}
    async def run():
        first = await source(1)
        options = dict(limit=24, ranked=ranked, first=first, source=source,
            visible=lambda item: True, snapshot_key='sample', source_pages=5, total_bound=180)
        fourth, _, _ = await qq_rating.page(number=4, **options)
        before = list(calls)
        third, _, _ = await qq_rating.page(number=3, **options)
        assert calls == before
        return fourth, third
    fourth, third = asyncio.run(run())
    expected = ranked + [row for row in catalog if row not in ranked]
    assert fourth == expected[72:96] and third == expected[48:72]
    assert calls == [1, 2, 3]


def test_source_failure_keeps_verified_prefix_with_an_explicit_error():
    async def blocked(number):
        raise HTTPException(503, 'Source unavailable', headers={'X-TruyenQQ-Error': 'http-403'})
    rows, error, total = asyncio.run(qq_rating.page(number=1, limit=24, ranked=[{'slug': 'rated-1'}],
        first={'data': {'items': []}}, source=blocked, visible=lambda item: True,
        snapshot_key='sample', source_pages=2, total_bound=100))
    assert rows == [{'slug': 'rated-1'}] and error.status_code == 503 and total is None


def test_relative_time_metadata_does_not_invalidate_an_unchanged_source_order():
    catalog = [{'slug': f'book-{index}', 'chaptersLatest': [
        {'chapter_api_data': f'qq--book-{index}--1', 'chapter_name': '1', 'publish_at': 'old'}]} for index in range(100)]
    calls = []
    async def source(number):
        calls.append(number)
        return {'data': {'items': catalog[(number-1)*42:number*42]}}
    async def run():
        options = dict(limit=24, ranked=[], source=source, visible=lambda item: True,
            snapshot_key='sample', source_pages=3, total_bound=100)
        first = await source(1)
        await qq_rating.page(number=4, first=first, **options)
        before = list(calls)
        refreshed = deepcopy(first)
        for item in refreshed['data']['items']:
            item['chaptersLatest'][0]['publish_at'] = 'recomputed-time'
        await qq_rating.page(number=3, first=refreshed, **options)
        assert calls == before
    asyncio.run(run())
