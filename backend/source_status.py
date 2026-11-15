"""Bounded operator diagnostics for one fixed public QQ source page."""
import hmac
import os

from fastapi import HTTPException, Request


def qq_direct_status():
    from curl_cffi.requests import Session
    try:
        with Session(impersonate='chrome131') as session:
            response = session.get('https://truyenqqko.com/truyen-moi-cap-nhat',
                headers={'Referer': 'https://truyenqqko.com/'}, timeout=(3, 5), allow_redirects=False)
            return {'status': response.status_code, 'valid_listing': response.status_code == 200 and 'list_grid' in response.text}
    except Exception as error:
        return {'status': None, 'error': type(error).__name__}


async def source_status(request: Request):
    secret = os.getenv('CRON_SECRET', '')
    supplied = request.headers.get('authorization', '')
    if not secret or not hmac.compare_digest(supplied.encode(), ('Bearer ' + secret).encode()):
        raise HTTPException(401, 'Unauthorized')
    import asyncio
    return await asyncio.to_thread(qq_direct_status)
