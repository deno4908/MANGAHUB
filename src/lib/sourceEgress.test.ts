import { afterEach, expect, it, vi } from 'vitest';
import handler from '../../api/source-egress';
afterEach(()=>vi.unstubAllGlobals());
it('does not fetch source HTML or return diagnostics without the private operator token',async()=>{
 const send=vi.fn();vi.stubGlobal('fetch',send);
 for(const method of ['GET','POST']) {
  const response=await handler(new Request('https://mangahub.art/api/source-egress',{method,headers:{'X-MangaHub-Probe':'wrong'}}));
  expect(response.status).toBe(404);
 }
 expect(send).not.toHaveBeenCalled();
});
