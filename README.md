# CharacterVault Export Extension for SillyTavern

A companion extension for [CharacterVault](https://github.com/spaceman2408/CharacterVault).

Export characters from [SillyTavern](https://github.com/SillyTavern/SillyTavern) to [CharacterVault](https://vault.charactervault.app/).

## Features

- Adds "CharacterVault" option to the export menu
- Exports the full character card, avatar, and lorebook
- Linked lorebooks are exported as they are now, including World Info edits made since the character was last saved
- Opens CharacterVault automatically with the character ready to import
- Works on phones and tablets, avatar included

## Installation

Open SillyTavern -> Extensions -> Install Extension -> Paste `https://github.com/spaceman2408/SillyTavern-CharacterVaultExport` and reload SillyTavern.

Requires SillyTavern 1.12.12 or newer. Syncing linked lorebooks needs 1.18.0 or newer; older versions export the lorebook stored in the card.

## Usage

1. Open a character
2. Click Export → CharacterVault
3. CharacterVault opens with your character ready to import

On desktop this is one click: the character is copied to your clipboard and CharacterVault opens in a new tab.

If your browser blocks the copy or the new tab, a dialog opens instead. Use **Copy & open CharacterVault** to finish.

### Phones and tablets

A dialog shows what's being exported (avatar, lorebook entries, greetings, size). Tap **Copy & open CharacterVault**.

- Copying works even when SillyTavern is opened over your local network (plain `http://`).
- Android's clipboard can't hold much more than about 1 MB, so large avatars are compressed to keep the copy small. A typical export is under 100 KB.
- If CharacterVault can't read the clipboard on its own, paste into the box on its import page.

### Settings

- **Include avatar image**: turn off to export the card without the image.
- **CharacterVault URL**: leave empty for `vault.charactervault.app`. Set it if you run your own CharacterVault, for example `http://localhost:3000/` for local development.

## License

MIT

## Author

[spaceman2408](https://github.com/spaceman2408)
