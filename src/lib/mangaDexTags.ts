// Native /manga/tag catalog, verified against the supplied MangaDex tag menu.
// Keep these separate from source aliases such as manhwa, ngôn tình or hentai.
export const MANGADEX_TAG_GROUPS = [
  { group: 'format', label: 'Định dạng', names: ['4-Koma', 'Adaptation', 'Anthology', 'Award Winning',
    'Doujinshi', 'Fan Colored', 'Full Color', 'Long Strip', 'Official Colored', 'Oneshot', 'Self-Published', 'Web Comic'] },
  { group: 'genre', label: 'Thể loại', names: ['Action', 'Adventure', "Boys' Love", 'Comedy', 'Crime', 'Drama',
    'Fantasy', "Girls' Love", 'Historical', 'Horror', 'Isekai', 'Magical Girls', 'Mecha', 'Medical', 'Mystery',
    'Philosophical', 'Psychological', 'Romance', 'Sci-Fi', 'Slice of Life', 'Sports', 'Superhero', 'Thriller', 'Tragedy', 'Wuxia'] },
  { group: 'theme', label: 'Chủ đề', names: ['Aliens', 'Animals', 'Cooking', 'Crossdressing', 'Delinquents',
    'Demons', 'Genderswap', 'Ghosts', 'Gyaru', 'Harem', 'Incest', 'Loli', 'Mafia', 'Magic', 'Mahjong', 'Martial Arts',
    'Military', 'Monster Girls', 'Monsters', 'Music', 'Ninja', 'Office Workers', 'Police', 'Post-Apocalyptic',
    'Reincarnation', 'Reverse Harem', 'Samurai', 'School Life', 'Shota', 'Supernatural', 'Survival', 'Time Travel',
    'Traditional Games', 'Vampires', 'Video Games', 'Villainess', 'Virtual Reality', 'Zombies'] },
  { group: 'content', label: 'Cảnh báo nội dung', names: ['Gore', 'Sexual Violence'] },
] as const;

export const MANGADEX_TAGS = MANGADEX_TAG_GROUPS.flatMap(({ group, names }) => names.map(name => ({
  name, slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''),
  source: 'mangadex' as const, group,
})));
