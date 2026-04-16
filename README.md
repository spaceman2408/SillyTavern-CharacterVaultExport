# CharacterVault Export Extension for SillyTavern

A SillyTavern extension that adds an export button to character cards, allowing quick export to [CharacterVault](https://spaceman2408.github.io/CharacterVault/).

## Features

- Adds a vault/box icon button to character cards in the grid view
- Exports full character data including:
  - Character metadata (name, description, personality, scenario, etc.)
  - Avatar image as base64 data URL
  - Lorebook entries
  - Alternate greetings
  - Tags and creator info
  - Extension data (talkativeness, depth prompts, regex scripts, etc.)
- Copies data to clipboard in CharacterVault-compatible format
- Opens CharacterVault import page automatically

## Installation

1. Copy this extension folder to your SillyTavern installation:
   ```
   public/scripts/extensions/third-party/SillyTavern-CharacterVaultExport/
   ```

2. Restart SillyTavern or reload extensions

3. The export button will appear on character cards

## Usage

1. Navigate to the Characters tab in SillyTavern
2. Hover over any character card
3. Click the vault icon (📦) button
4. The character is copied to your clipboard
5. CharacterVault opens in a new tab with the import page
6. Follow CharacterVault's import instructions

## Clipboard Format

The extension copies JSON data following the CharacterVault import specification:

```json
{
  "source": "st",
  "character": {
    "spec": "chara_card_v2",
    "spec_version": "2.0",
    "data": { ... }
  },
  "avatar": "data:image/png;base64,..." // or null
}
```

## Development

### File Structure

- `manifest.json` - Extension manifest for SillyTavern
- `index.js` - Main extension code
- `styles.css` - Extension styles
- `index.html` - Documentation page
- `plan.md` - Implementation specification from CharacterVault

### Building

No build step required - this is a pure JavaScript/CSS extension.

## License

MIT

## Author

spaceman2408
