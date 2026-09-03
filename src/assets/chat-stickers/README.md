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

The nine bundled stickers are original artwork drawn for this app in the
general style of a meme pack (kissy selfie, peace-sign duo, shushing kid,
tongue-out grin, side-eye cat, cheeky grin, crying thumbs-up cat,
leaning-in shock, puzzled stare). Anything of someone's actual face, a
copyrighted character, or a private photo should only be added with that
person's OK — this is a shared work chat, and the pack is visible to every
account in the workspace.
