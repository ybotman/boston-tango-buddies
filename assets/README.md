# assets/

Drop your generated images here — the app links to them and degrades gracefully
if they're missing (no crash, no broken layout).

- **`hero.png`** — the warm invite image at the top of the newbie page (`/`).
  Any size works; it's shown full-width. If absent, a coral→amber gradient with
  "Boston Tango · come dance with us" shows instead.
- **`icon.png`** — favicon (browser tab icon), also used at `/favicon.ico`.
  A square PNG (e.g. 512×512) is ideal. If absent, the browser just shows no icon.

Any other file you drop here is served at `/assets/<filename>` (png/jpg/svg/css/…).
