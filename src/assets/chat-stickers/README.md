# Team-chat stickers

Every image in this folder is a sticker in the Chat composer (the 😊 button →
the 🖼️ tab), for the admin and for workers alike.

## Adding or removing one

Drop the file in and it is there on the next build — no manifest, no code
change, no database migration:

```
src/assets/chat-stickers/side-eye-cat.png   →  slug "side-eye-cat"
                                              →  label "Side eye cat"
                                              →  picker row "Side eye cat"
```

The file name stem becomes the slug and the label, so name files in
`lowercase-with-dashes` and the chat reads well: `thumbs-up-tears.png` shows up
as "Thumbs up tears".

Supported: `.png`, `.jpg`, `.jpeg`, `.webp`, `.gif`, `.svg`.

Keep them square-ish and small — they are rendered at 56 px in the picker and
112 px in the timeline, and they ship inside the app bundle (the PWA precaches
them), so a few tens of KB each is right:

```sh
convert my-meme.jpg -resize 384x384 -background none -gravity center \
        -extent 400x400 -strip -colors 224 src/assets/chat-stickers/my-meme.png
```

Deleting a file is safe too: a message sent earlier with `[sticker:my-meme]`
falls back to showing the label "My meme" instead of a broken image.

## How a sticker is stored

A sticker message is ordinary chat text: `[sticker:side-eye-cat]`. That is why
nothing here needs a database change — see the note at the top of
`src/lib/chat.ts` — and why sticker messages still read sensibly in a
notification ("Mike: [Side eye cat]").

## A note on what is in here

The 19 bundled stickers are original artwork drawn for this app in the general
style of a meme pack, so the tab is useful on day one:

| File | Beat |
| --- | --- |
| `kissy-selfie` | fisheye duck-face selfie |
| `peace-duo` | two goofballs, double peace signs |
| `shush-smirk` | "say less" finger to lips |
| `tongue-grin` | tongue out, zero regrets |
| `side-eye-cat` | the judgmental stare |
| `side-eye-duo` | two people looking at each other, suspicious |
| `cheeky-grin` | innocent, definitely up to something |
| `thumbs-up-tears` | crying cat thumbs up — "I'm fine" |
| `thumbs-up-panic` | sweating thumbs up — "all good!" |
| `nervous-sweat-grin` | huge grin, one sweat drop |
| `wince-teeth` | clenched teeth — "yikes" |
| `puzzled-stare` | complete bewilderment |
| `shock-lean` | leaning in, mouth open |
| `money-eyes` | payday |
| `chef-kiss` | perfection |
| `deal-with-it-cat` | unbothered, sunglasses on |
| `asleep-on-keyboard` | asleep on the keyboard after lunch |
| `white-flag-ghost` | giving up, quietly |
| `rushing-over` | on the way, at speed |

Anything of someone's actual face, a copyrighted character, or a private photo
should only be added with that person's OK — this is a shared work chat, and the
pack is visible to every account in the workspace.
