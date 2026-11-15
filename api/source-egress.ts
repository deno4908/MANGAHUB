export const config = { runtime: 'edge' };
export default async function handler(request: Request) {
 const supplied = request.headers.get('X-MangaHub-Probe') || '';
 const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(supplied));
 const hex = [...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join('');
 if (request.method !== 'GET' || hex !== 'e8327ac216df7b0ab524ec39d1210c91eb5d6e45517984ca3f8cfc2021746b86') return new Response('Not found',{status:404});
 try {
  const response=await fetch('https://truyenqqko.com/truyen-moi-cap-nhat',{
   headers:{Accept:'text/html','User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',Referer:'https://truyenqqko.com/'},
   redirect:'manual',signal:AbortSignal.timeout(6000),
  });
  const html=await response.text();
  return Response.json({status:response.status,valid_listing:response.status===200&&html.includes('list_grid')},{headers:{'Cache-Control':'private, no-store'}});
 } catch { return Response.json({status:null,error:'source-unavailable'},{headers:{'Cache-Control':'private, no-store'}}); }
}
