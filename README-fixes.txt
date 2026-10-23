HP1 fixes - only changed files. DO NOT copy private/data.

Copy each file over the same path in your project:
  public/index.html          animation + language button + reveal after intro + intro on/off flag
  public/i18n.js             NEW location (was outside public -> 404)
  public/logo.png            9.3MB -> 325KB
  public/logo.webp           new, 25KB (intro + header)
  public/background.webp     new, 130KB (default background)
  public/background.png      shrunk (admin preview only)
  server.js                  qid saved with each result + owner endpoint for the intro on/off switch
  private/admin.html         export/import buttons (Questions) + intro on/off card (Special settings, owner only)
  questions-reorganized.json reorganized bank - import from the panel, saved only when you press Save

DELETE from your project: the old i18n.js in the root folder.
After upload: Ctrl+Shift+R in the browser.
