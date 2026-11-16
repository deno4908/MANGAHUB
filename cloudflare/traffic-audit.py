"""Read aggregate traffic and routes; never log credentials, query strings or IPs."""
import json
import os
import re
import urllib.error
import urllib.request
from collections import Counter
from datetime import datetime, timezone, timedelta

TOKEN = os.environ['CLOUDFLARE_API_TOKEN']
ACCOUNT = os.environ['CLOUDFLARE_ACCOUNT_ID']

def request(path, body=None):
    req = urllib.request.Request('https://api.cloudflare.com/client/v4/'+path,
        data=json.dumps(body).encode() if body else None,
        headers={'Authorization':'Bearer '+TOKEN,'Content-Type':'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=25) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        return {'errors':[{'message':'HTTP '+str(error.code)}]}

def query(label, text, variables):
    value = request('graphql', {'query':text, 'variables':variables})
    if value.get('errors'):
        print(json.dumps({'query':label,'errors':[row.get('message','unknown')[:240] for row in value['errors']]}))
        return None
    return value.get('data',{}).get('viewer',{})

now = datetime.now(timezone.utc)
since = now.replace(hour=0, minute=0, second=0, microsecond=0)
if now-since < timedelta(hours=1): since = now-timedelta(hours=3)
variables = {'account':ACCOUNT,'since':since.isoformat(),'until':now.isoformat()}
print(json.dumps({'window_start_utc':variables['since'],'window_end_utc':variables['until']}))
workers = query('workers', '''query($account:String!, $since:Time!, $until:Time!){viewer{accounts(filter:{accountTag:$account}){
 workersInvocationsAdaptive(limit:200, filter:{datetime_geq:$since,datetime_leq:$until}){
 dimensions{scriptName status} sum{requests errors subrequests}
 }}}}''', variables)
if workers: print(json.dumps({'workers':workers['accounts']}))

zones = request('zones?name=mangahub.art')
zone = (zones.get('result') or [{}])[0].get('id')
if zone:
    routes=request(f'zones/{zone}/workers/routes')
    print(json.dumps({'routes':[{k:row.get(k) for k in ['pattern','script','request_limit_fail_open']} for row in routes.get('result',[])]}))
    variables={'zone':zone,'since':variables['since'],'until':variables['until']}
    traffic=query('zone_paths', '''query($zone:String!, $since:Time!, $until:Time!){viewer{zones(filter:{zoneTag:$zone}){
     httpRequestsAdaptiveGroups(limit:500, orderBy:[count_DESC],filter:{datetime_geq:$since,datetime_leq:$until,requestSource:"eyeball"}){
      count dimensions{clientRequestHTTPHost clientRequestPath clientRequestHTTPMethodName edgeResponseStatus}
     }}}}''', variables)
    if traffic:
        counts=Counter()
        for group in traffic['zones'][0]['httpRequestsAdaptiveGroups']:
            d=group['dimensions']; path=d['clientRequestPath']
            # Resource paths may contain account/comic IDs. Preserve endpoint
            # names while grouping dynamic identifiers and dropping queries.
            path=re.sub(r'/[0-9a-fA-F]{8}(?:-[0-9a-fA-F-]+)?(?=/|$)', '/:id',path)
            for prefix in ['/api/manga/truyenqq/image/','/api/manga/truyenqq/cover/','/api/manga/mangadex-cover/','/assets/','/api/users/','/manga/','/chapter/']:
                if path.startswith(prefix): path=prefix+'*';break
            counts[(d['clientRequestHTTPHost'],path,d['clientRequestHTTPMethodName'],d['edgeResponseStatus'])]+=group['count']
        print(json.dumps({'top_paths':[{'host':key[0],'path':key[1],'method':key[2],'status':key[3],'requests':value} for key,value in counts.most_common(60)]}))
