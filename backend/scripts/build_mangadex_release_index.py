"""Build the public Vietnamese release seed once, with resumable checkpoints.

Usage (from the repository root):
    backend/venv/Scripts/python.exe backend/scripts/build_mangadex_release_index.py .

No browser cookie or application credentials are used. Public metadata only:
titles/tags, release IDs/times and scanlation-group names; no uploader profiles.
"""
import gzip,json,time,uuid,sys
from pathlib import Path
from datetime import datetime,timezone
import httpx
ROOT=Path(sys.argv[1] if len(sys.argv)>1 else '.').resolve()
OUT=ROOT/'backend/fastapi_app/services/mangadex_release_seed.json.gz'
PROGRESS=ROOT.parent/'.codex-artifacts/mangadex-index/bootstrap-progress.json.gz'
FIELDS=('chapter','title','translatedLanguage','publishAt','readableAt','createdAt','updatedAt')
MANGA_FIELDS=('title','altTitles','status','contentRating','tags','originalLanguage','year','lastChapter','lastVolume','demographic')
def compact(row):
    relations=[]
    for rel in row.get('relationships',[]):
        if rel.get('type')=='manga':
            attrs=rel.get('attributes') or {}
            relations.append({'id':rel['id'],'type':'manga','attributes':{k:attrs[k] for k in MANGA_FIELDS if k in attrs}})
        elif rel.get('type')=='scanlation_group':
            relations.append({'id':rel.get('id',''),'type':'scanlation_group','attributes':{'name':(rel.get('attributes') or {}).get('name','')}})
    return {'id':row['id'],'attributes':{k:(row.get('attributes') or {}).get(k,'') for k in FIELDS},'relationships':relations}
def mid(row):
    return next((r.get('id') for r in row.get('relationships',[]) if r.get('type')=='manga'),None)
def key(row):
    a=row.get('attributes') or {}
    return (a.get('readableAt') or a.get('publishAt') or a.get('createdAt') or '',row.get('id',''))
def save(path,state):
    path.parent.mkdir(parents=True,exist_ok=True)
    data=gzip.compress(json.dumps(state,ensure_ascii=False,separators=(',',':')).encode(),compresslevel=6)
    tmp=path.with_suffix(path.suffix+'.tmp');tmp.write_bytes(data);tmp.replace(path)
state=json.loads(gzip.decompress(PROGRESS.read_bytes())) if PROGRESS.exists() else None
if not state or state.get('ready'):
    state={'schema':1,'language':'vi','rows':{},'cursor':'','skip':0,'scanned':0,'total':0,'ready':False,'watermark':datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S'),'version':uuid.uuid4().hex,'last_checked':0}
last=0
with httpx.Client(headers={'User-Agent':'MangaHub/1.0 (MangaDex API client)','Accept':'application/json'},timeout=15,trust_env=False,follow_redirects=False) as client:
    while not state['ready']:
        time.sleep(max(0,.35-(time.monotonic()-last)));last=time.monotonic()
        params={'limit':100,'offset':state['skip'],'translatedLanguage[]':'vi','order[createdAt]':'asc','includes[]':['manga','scanlation_group'],'contentRating[]':['safe','suggestive','erotica','pornographic'],'includeFuturePublishAt':0}
        if state['cursor']:params['createdAtSince']=state['cursor']
        if params['offset']+100>10000:raise RuntimeError('Creation timestamp group exceeds source window')
        for attempt in range(5):
            try:
                response=client.get('https://api.mangadex.org/chapter',params=params)
                if response.status_code in (429,500,502,503,504):
                    print({'retry_status':response.status_code,'attempt':attempt+1},flush=True);time.sleep(min(30,2**attempt));continue
                if response.status_code!=200 or 'application/json' not in response.headers.get('content-type',''):raise RuntimeError('Source response status '+str(response.status_code))
                payload=response.json();break
            except httpx.HTTPError:
                if attempt==4:raise
                time.sleep(2**attempt)
        else:raise RuntimeError('Source temporarily unavailable after bounded retries')
        rows=payload.get('data',[])
        if not state['total']:state['total']=int(payload.get('total') or 0)
        for row in rows:
            if (row.get('attributes') or {}).get('translatedLanguage')!='vi':continue
            identifier=mid(row)
            if identifier and (identifier not in state['rows'] or key(row)>key(state['rows'][identifier])):state['rows'][identifier]=compact(row)
        state['scanned']+=len(rows)
        if rows:
            stamp=(rows[-1].get('attributes') or {}).get('createdAt','')[:19]
            if not stamp:raise RuntimeError('Missing source creation timestamp')
            if stamp==state['cursor']:state['skip']+=len(rows)
            else:
                state['cursor']=stamp;state['skip']=sum((r.get('attributes') or {}).get('createdAt','')[:19]==stamp for r in rows)
        state['ready']=len(rows)<100
        if state['scanned']%1000==0 or state['ready']:
            save(PROGRESS,state)
            print({'scanned':state['scanned'],'source_total':state['total'],'unique_vietnamese_titles':len(state['rows']),'ready':state['ready']},flush=True)
state['last_checked']=0
state['last_full_sync']=time.time()
save(OUT,state)
print({'seed_ready':True,'unique_titles':len(state['rows']),'compressed_bytes':OUT.stat().st_size},flush=True)
