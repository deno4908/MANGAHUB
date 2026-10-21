let restricted = false;
export function setSiteAccessRestricted(value: boolean) {
  restricted = value;
}
export function isSiteAccessRestricted() {
  return restricted;
}
