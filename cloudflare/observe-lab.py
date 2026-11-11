"""Print only bounded lab phase records from a temporary Workers tail.

Raw tail events contain request credentials: never print or persist them.
"""
import json,os,select,subprocess,time

process=subprocess.Popen(['npx','--yes','wrangler@4','tail','--config','cloudflare/wrangler-vps-lab.toml','--format','json'],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
deadline=time.monotonic()+90
buffer=''
decoder=json.JSONDecoder()
print('Lab observation started; raw requests are discarded',flush=True)
try:
    while time.monotonic()<deadline and process.poll() is None:
        if not select.select([process.stdout],[],[],.5)[0]:continue
        data=os.read(process.stdout.fileno(),65536)
        if not data:break
        buffer+=data.decode('utf-8',errors='replace')
        while buffer.strip():
            buffer=buffer.lstrip()
            if not buffer.startswith('{'):
                newline=buffer.find('\n')
                if newline<0:break
                buffer=buffer[newline+1:]
                continue
            try:event,offset=decoder.raw_decode(buffer)
            except json.JSONDecodeError:break
            buffer=buffer[offset:]
            for log in event.get('logs',[]):
                for message in log.get('message',[]):
                    if not isinstance(message,str):continue
                    try:value=json.loads(message)
                    except json.JSONDecodeError:continue
                    if value.get('kind')!='qq-lab':continue
                    safe={key:value.get(key) for key in ['kind','phase','authorized','status','cache','block'] if key in value}
                    path=value.get('path','').split('?')[0]
                    if path.startswith('/api/truyenqq-edge/') and len(path)<250:safe['path']=path
                    print(json.dumps(safe),flush=True)
            if event.get('exceptions'):print(json.dumps({'kind':'qq-lab','phase':'exception','count':len(event['exceptions'])}),flush=True)
finally:
    process.terminate()
    try:process.wait(timeout=5)
    except subprocess.TimeoutExpired:process.kill()
print('Lab observation ended',flush=True)
