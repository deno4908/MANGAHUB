export const SUPPORT_EMAIL = "cskh.mangahub@gmail.com";

export const supportMailto = (subject?: string) => {
  const query = subject ? `?subject=${encodeURIComponent(subject)}` : "";
  return `mailto:${SUPPORT_EMAIL}${query}`;
};
