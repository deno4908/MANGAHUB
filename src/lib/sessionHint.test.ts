import { afterEach, expect, it, vi } from 'vitest';
import { sharedSessionHint, setSharedSessionHint } from './sessionHint';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function page(hostname: string, protocol = 'https:') {
  vi.stubGlobal('window', { location: { hostname, protocol } });
}

it.each(['mangahub.art', 'standby.mangahub.art'])('lets %s restore only by the canonical auth cookie', host => {
  page(host);
  vi.spyOn(document, 'cookie', 'get').mockReturnValue('other=fixture; mh_session_present=1');
  expect(sharedSessionHint()).toBe(true);
  const write = vi.spyOn(document, 'cookie', 'set').mockImplementation(() => {});
  setSharedSessionHint(true);
  expect(write).toHaveBeenCalledWith('mh_session_present=1; Domain=mangahub.art; Path=/; Max-Age=2592000; Secure; SameSite=Lax');
  setSharedSessionHint(false);
  expect(write).toHaveBeenLastCalledWith('mh_session_present=; Domain=mangahub.art; Path=/; Max-Age=0; Secure; SameSite=Lax');
});

it.each([['localhost','http:'],['untrusted.mangahub.art','https:'],['mangahub.art','http:']])('does not share a hint on %s over %s', (host, protocol) => {
  page(host, protocol);
  const write = vi.spyOn(document, 'cookie', 'set').mockImplementation(() => {});
  vi.spyOn(document, 'cookie', 'get').mockReturnValue('mh_session_present=1');
  expect(sharedSessionHint()).toBe(false);
  setSharedSessionHint(true);
  expect(write).not.toHaveBeenCalled();
});

it('does not consider a similarly named cookie or an empty marker a login hint', () => {
  page('standby.mangahub.art');
  const read = vi.spyOn(document, 'cookie', 'get').mockReturnValue('prefix_mh_session_present=1; mh_session_present=');
  expect(sharedSessionHint()).toBe(false);
  read.mockReturnValue('mh_session_present=0');
  expect(sharedSessionHint()).toBe(false);
});
