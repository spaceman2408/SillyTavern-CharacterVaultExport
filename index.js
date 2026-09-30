// CharacterVault Export Extension for SillyTavern
// Adds a "CharacterVault" option to the character export menu. The card and avatar are handed
// to CharacterVault's import page through the clipboard, which it reads when the page loads.

const EXTENSION_NAME = 'CharacterVaultExport';
const SETTINGS_KEY = 'CharacterVaultExport';
const TOAST_TITLE = 'CharacterVault Export';

const DEFAULT_VAULT_URL = 'https://vault.charactervault.app/';
const LEGACY_LOCALHOST_URL = 'http://localhost:3000/';
const IMPORT_ROUTE = '#/import?source=st';

// Export format identifier
const EXPORT_FORMAT_CV = 'charactervault';

// Android's clipboard goes through a shared 1 MB Binder buffer as UTF-16, and oversized copies
// fail silently. Keep mobile payloads well under that.
const MOBILE_PAYLOAD_BUDGET = 300_000;
// Below this there's no room left for a usable avatar.
const MIN_AVATAR_BUDGET = 20_000;
// Re-encode attempts for avatars that don't fit the mobile budget, largest first.
const AVATAR_COMPRESSION_STEPS = [
    { maxSide: 1024, quality: 0.85 },
    { maxSide: 768, quality: 0.8 },
    { maxSide: 512, quality: 0.75 },
    { maxSide: 384, quality: 0.7 },
];

// PNG text chunk keywords SillyTavern uses to embed the card (V2 and V3)
const CARD_METADATA_KEYWORDS = new Set(['chara', 'ccv3']);
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const SLOW_PREPARE_TOAST_DELAY = 600;

const AVATAR_STATUS_TEXT = {
    included: 'Avatar included',
    compressed: 'Avatar compressed to fit the phone clipboard',
    excluded: 'Avatar not included',
    'too-large': 'Avatar left out: the card alone fills the phone clipboard',
    unavailable: 'Avatar could not be loaded',
};

/**
 * Get extension settings with defaults
 * @returns {{ vaultUrl: string, includeAvatar: boolean }} Settings object
 */
function getSettings() {
    const { extensionSettings } = SillyTavern.getContext();
    const settings = extensionSettings[SETTINGS_KEY] ??= {};

    // 1.0.x had a localhost toggle instead of a URL
    if ('useLocalhost' in settings) {
        settings.vaultUrl ??= settings.useLocalhost ? LEGACY_LOCALHOST_URL : '';
        delete settings.useLocalhost;
    }

    // Empty means the hosted CharacterVault
    settings.vaultUrl ??= '';
    settings.includeAvatar ??= true;
    return settings;
}

/**
 * @returns {string} CharacterVault base URL
 */
function getVaultBaseUrl() {
    return getSettings().vaultUrl || DEFAULT_VAULT_URL;
}

/**
 * @returns {string} URL of CharacterVault's SillyTavern import page
 */
function getVaultImportUrl() {
    return new URL(IMPORT_ROUTE, getVaultBaseUrl()).href;
}

/**
 * @returns {number|string|null} Index of the character open in the editor, or null
 */
function getSelectedCharacterId() {
    const { characterId } = SillyTavern.getContext();
    return characterId === undefined || characterId === null ? null : characterId;
}

/**
 * Converts a Blob to a base64 data URL
 * @param {Blob} blob
 * @returns {Promise<string>}
 */
function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(/** @type {string} */ (reader.result));
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}

/**
 * @param {number} length Payload length in characters (the payload is almost all ASCII)
 * @returns {string}
 */
function formatSize(length) {
    if (length < 1024) return `${length} B`;
    if (length < 1024 * 1024) return `${Math.round(length / 1024)} KB`;
    return `${(length / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * @param {number} count
 * @param {string} singular
 * @param {string} [pluralForm]
 * @returns {string}
 */
function plural(count, singular, pluralForm = `${singular}s`) {
    return `${count} ${count === 1 ? singular : pluralForm}`;
}

/**
 * Fetches the card the same way SillyTavern's own JSON export does: read from disk, private
 * fields stripped. Falls back to the in-memory copy if the endpoint is unavailable.
 * @param {number|string} characterId
 * @returns {Promise<object>} Card V2 `data` object
 */
async function fetchCardData(characterId) {
    const context = SillyTavern.getContext();
    const character = context.characters[characterId];

    try {
        const response = await fetch('/api/characters/export', {
            method: 'POST',
            headers: context.getRequestHeaders(),
            body: JSON.stringify({ format: 'json', avatar_url: character.avatar }),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const card = await response.json();
        if (!card?.data || typeof card.data !== 'object') throw new Error('Response has no card data');
        return card.data;
    } catch (error) {
        console.warn(`[${EXTENSION_NAME}] Export endpoint failed, using in-memory card:`, error);
        await context.unshallowCharacter?.(characterId);
        const { data } = context.characters[characterId];
        return data ? structuredClone(data) : { name: character.name };
    }
}

/**
 * Converts World Info entries to a character book. Mirrors SillyTavern's server-side
 * convertWorldInfoToCharacterBook so the result matches what its own export embeds.
 * @param {string} name World Info name
 * @param {object} entries World Info entries, keyed by uid
 * @returns {object} Character book
 */
function convertWorldInfoToCharacterBook(name, entries) {
    return {
        name,
        entries: Object.values(entries).map(entry => ({
            id: entry.uid,
            keys: entry.key,
            secondary_keys: entry.keysecondary,
            comment: entry.comment,
            content: entry.content,
            constant: entry.constant,
            selective: entry.selective,
            insertion_order: entry.order,
            enabled: !entry.disable,
            position: entry.position == 0 ? 'before_char' : 'after_char',
            use_regex: true, // ST keys are always regex
            extensions: {
                ...entry.extensions,
                position: entry.position,
                exclude_recursion: entry.excludeRecursion,
                display_index: entry.displayIndex,
                probability: entry.probability ?? null,
                useProbability: entry.useProbability ?? false,
                depth: entry.depth ?? 4,
                selectiveLogic: entry.selectiveLogic ?? 0,
                outlet_name: entry.outletName ?? '',
                group: entry.group ?? '',
                group_override: entry.groupOverride ?? false,
                group_weight: entry.groupWeight ?? null,
                prevent_recursion: entry.preventRecursion ?? false,
                delay_until_recursion: entry.delayUntilRecursion ?? false,
                scan_depth: entry.scanDepth ?? null,
                match_whole_words: entry.matchWholeWords ?? null,
                use_group_scoring: entry.useGroupScoring ?? false,
                case_sensitive: entry.caseSensitive ?? null,
                automation_id: entry.automationId ?? '',
                role: entry.role ?? 0,
                vectorized: entry.vectorized ?? false,
                sticky: entry.sticky ?? null,
                cooldown: entry.cooldown ?? null,
                delay: entry.delay ?? null,
                match_persona_description: entry.matchPersonaDescription ?? false,
                match_character_description: entry.matchCharacterDescription ?? false,
                match_character_personality: entry.matchCharacterPersonality ?? false,
                match_character_depth_prompt: entry.matchCharacterDepthPrompt ?? false,
                match_scenario: entry.matchScenario ?? false,
                match_creator_notes: entry.matchCreatorNotes ?? false,
                triggers: entry.triggers ?? [],
                ignore_budget: entry.ignoreBudget ?? false,
            },
        })),
    };
}

/**
 * SillyTavern only embeds a linked World Info book into the card when the character is saved,
 * so edits made to the book since then are missing from the stored card. Its own export saves
 * first; this extension doesn't (the save can fail with EPERM on Windows), so rebuild the book
 * from the current World Info instead.
 * @param {object} data Card data, updated in place
 * @returns {Promise<boolean>} Whether the book was rebuilt
 */
async function refreshLinkedLorebook(data) {
    const worldName = data.extensions?.world;
    const context = SillyTavern.getContext();

    // The World Info endpoint returns an empty book for missing names, which would wipe the
    // embedded one, so only rebuild when the book is known to exist.
    if (!worldName || !context.getWorldInfoNames?.().includes(worldName)) {
        return false;
    }

    try {
        const world = await context.loadWorldInfo(worldName);
        if (!world?.entries) return false;
        // Keep book-level settings (token budget, scan depth, ...) that World Info has no place for
        data.character_book = {
            ...data.character_book,
            ...convertWorldInfoToCharacterBook(worldName, world.entries),
        };
        return true;
    } catch (error) {
        console.warn(`[${EXTENSION_NAME}] Could not load linked lorebook "${worldName}":`, error);
        return false;
    }
}

/**
 * @param {string} type PNG chunk type
 * @param {Uint8Array} payload Chunk data
 * @returns {boolean} Whether the chunk holds embedded card data
 */
function isCardMetadataChunk(type, payload) {
    if (type !== 'tEXt' && type !== 'iTXt' && type !== 'zTXt') return false;
    const keywordEnd = payload.indexOf(0);
    if (keywordEnd <= 0 || keywordEnd > 79) return false;
    const keyword = String.fromCharCode(...payload.subarray(0, keywordEnd));
    return CARD_METADATA_KEYWORDS.has(keyword.toLowerCase());
}

/**
 * Removes the card JSON SillyTavern embeds in avatar PNGs. CharacterVault gets the card
 * separately, and the embedded V2 + V3 copies can be larger than the image itself.
 * @param {ArrayBuffer} buffer Image file contents
 * @param {string} type Image MIME type
 * @returns {Blob} The image without card metadata (unchanged if it isn't a valid PNG)
 */
function stripCardMetadata(buffer, type) {
    const bytes = new Uint8Array(buffer);
    const isPng = bytes.length > PNG_SIGNATURE.length && PNG_SIGNATURE.every((byte, i) => bytes[i] === byte);
    if (!isPng) return new Blob([buffer], { type });

    const view = new DataView(buffer);
    const kept = [bytes.subarray(0, PNG_SIGNATURE.length)];
    let offset = PNG_SIGNATURE.length;

    while (offset + 12 <= bytes.length) {
        const length = view.getUint32(offset);
        const end = offset + 12 + length;
        if (end > bytes.length) {
            // Truncated file: leave it for the browser to cope with
            return new Blob([buffer], { type });
        }

        const chunkType = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
        if (!isCardMetadataChunk(chunkType, bytes.subarray(offset + 8, offset + 8 + length))) {
            kept.push(bytes.subarray(offset, end));
        }

        offset = end;
        if (chunkType === 'IEND') break;
    }

    return new Blob(kept, { type: 'image/png' });
}

/**
 * Fetches the full-size avatar with the embedded card removed
 * @param {string} avatarFile Avatar file name
 * @returns {Promise<Blob>}
 */
async function fetchAvatar(avatarFile) {
    // Encode: file names can contain characters like '#' that would otherwise truncate the URL
    const response = await fetch(`/characters/${encodeURIComponent(avatarFile)}`, { cache: 'no-cache' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const buffer = await response.arrayBuffer();
    return stripCardMetadata(buffer, response.headers.get('Content-Type') || 'image/png');
}

/**
 * @param {Blob} blob
 * @returns {Promise<HTMLImageElement>}
 */
function loadImage(blob) {
    return new Promise((resolve, reject) => {
        const image = new Image();
        const url = URL.createObjectURL(blob);
        image.onload = () => {
            URL.revokeObjectURL(url);
            resolve(image);
        };
        image.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error('Could not decode the avatar image'));
        };
        image.src = url;
    });
}

/**
 * Re-encodes an avatar at decreasing sizes until its data URL fits the budget
 * @param {Blob} blob Avatar image
 * @param {number} budget Maximum data URL length
 * @returns {Promise<string|null>} Data URL, or null if even the smallest step is too big
 */
async function compressAvatar(blob, budget) {
    const image = await loadImage(blob);
    const longestSide = Math.max(image.naturalWidth, image.naturalHeight);

    for (const { maxSide, quality } of AVATAR_COMPRESSION_STEPS) {
        const scale = Math.min(1, maxSide / longestSide);
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));

        const ctx = canvas.getContext('2d');
        ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
        let dataUrl = canvas.toDataURL('image/webp', quality);

        // Browsers without a WebP encoder quietly return PNG; fall back to JPEG on white
        if (!dataUrl.startsWith('data:image/webp')) {
            ctx.globalCompositeOperation = 'destination-over';
            ctx.fillStyle = '#fff';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            dataUrl = canvas.toDataURL('image/jpeg', quality);
        }

        if (dataUrl.length <= budget) return dataUrl;
    }

    return null;
}

/**
 * @typedef {object} PreparedExport
 * @property {object} payload Clipboard payload read by CharacterVault
 * @property {string} text The payload as JSON
 * @property {string} name Character name
 * @property {number} lorebookEntries Number of lorebook entries
 * @property {boolean} lorebookRefreshed Whether the linked lorebook was rebuilt from World Info
 * @property {number} greetings First message plus alternate greetings
 * @property {'included'|'compressed'|'excluded'|'too-large'|'unavailable'} avatarStatus
 */

/**
 * Builds the clipboard payload for CharacterVault
 * @param {number|string} characterId Index of the character in the characters array
 * @param {object} [options]
 * @param {boolean} [options.includeAvatar=true] Whether to include the avatar image
 * @param {number} [options.budget=Infinity] Maximum payload length; the avatar is compressed or left out to fit
 * @returns {Promise<PreparedExport>}
 */
async function prepareExport(characterId, { includeAvatar = true, budget = Infinity } = {}) {
    const character = SillyTavern.getContext().characters[characterId];
    if (!character) {
        throw new Error('Character not found');
    }

    const [data, avatarBlob] = await Promise.all([
        fetchCardData(characterId),
        includeAvatar
            ? fetchAvatar(character.avatar).catch((error) => {
                console.warn(`[${EXTENSION_NAME}] Could not load avatar:`, error);
                return null;
            })
            : null,
    ]);

    data.extensions = { ...data.extensions, fav: false };
    const lorebookRefreshed = await refreshLinkedLorebook(data);

    // Only the V2 wrapper: the full ST export also repeats every field at the top level,
    // which would double the size for nothing
    const payload = {
        source: 'st',
        character: { spec: 'chara_card_v2', spec_version: '2.0', data },
        avatar: null,
    };

    let avatarStatus = includeAvatar ? 'unavailable' : 'excluded';
    if (avatarBlob) {
        const avatarBudget = budget - JSON.stringify(payload).length;
        const estimatedLength = Math.ceil(avatarBlob.size / 3) * 4 + 32;

        if (estimatedLength <= avatarBudget) {
            payload.avatar = await blobToDataUrl(avatarBlob);
            avatarStatus = 'included';
        } else if (avatarBudget >= MIN_AVATAR_BUDGET) {
            payload.avatar = await compressAvatar(avatarBlob, avatarBudget).catch((error) => {
                console.warn(`[${EXTENSION_NAME}] Could not compress avatar:`, error);
                return null;
            });
            avatarStatus = payload.avatar ? 'compressed' : 'too-large';
        } else {
            avatarStatus = 'too-large';
        }
    }

    return {
        payload,
        text: JSON.stringify(payload),
        name: data.name || character.name,
        lorebookEntries: data.character_book?.entries?.length ?? 0,
        lorebookRefreshed,
        greetings: (data.first_mes ? 1 : 0) + (data.alternate_greetings?.length ?? 0),
        avatarStatus,
    };
}

/**
 * Builds the clipboard payload for CharacterVault. Kept for external callers.
 * @param {number|string} characterIndex Index of character in characters array
 * @param {boolean} includeAvatar Whether to include the avatar (default: true)
 * @returns {Promise<object>} Clipboard payload
 */
async function buildClipboardPayload(characterIndex, includeAvatar = true) {
    return (await prepareExport(characterIndex, { includeAvatar })).payload;
}

/**
 * Copies text with a hidden textarea and execCommand. Synchronous, so it must run inside the
 * click handler, but unlike the Clipboard API it works without a secure context (SillyTavern
 * opened over LAN http) and on iOS.
 * @param {string} text
 * @param {HTMLElement} container Must be inside any open modal dialog, or the textarea is inert
 * @returns {boolean} Success status
 */
function copyWithExecCommand(text, container = document.body) {
    const previousFocus = document.activeElement;
    const textarea = document.createElement('textarea');
    textarea.className = 'charvault-clipboard-proxy';
    textarea.setAttribute('readonly', '');
    textarea.value = text;
    container.append(textarea);

    try {
        textarea.select();
        textarea.setSelectionRange(0, text.length);
        return document.execCommand('copy');
    } catch (error) {
        console.warn(`[${EXTENSION_NAME}] execCommand copy failed:`, error);
        return false;
    } finally {
        textarea.remove();
        window.getSelection()?.removeAllRanges();
        if (previousFocus instanceof HTMLElement) {
            previousFocus.focus({ preventScroll: true });
        }
    }
}

/**
 * Copies text with the async Clipboard API
 * @param {string} text
 * @returns {Promise<boolean>} Success status
 */
async function copyWithClipboardApi(text) {
    if (!window.isSecureContext || !navigator.clipboard?.writeText) return false;
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch (error) {
        console.warn(`[${EXTENSION_NAME}] Clipboard API write failed:`, error);
        return false;
    }
}

/**
 * Starts a clipboard write for text that isn't ready yet. Must be called synchronously from a
 * user gesture: Safari only allows clipboard writes that start inside one, and ClipboardItem
 * takes a promise so the gesture isn't lost while the payload is being built.
 * @param {() => Promise<string>} getText Returns the text once it's ready
 * @returns {Promise<boolean>|null} Success status, or null if the browser can't do this
 */
function startDeferredClipboardWrite(getText) {
    if (!window.isSecureContext || !navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
        return null;
    }

    const blobPromise = getText().then(text => new Blob([text], { type: 'text/plain' }));
    // The caller reports payload errors itself
    blobPromise.catch(() => {});

    try {
        const item = new ClipboardItem({ 'text/plain': blobPromise });
        return navigator.clipboard.write([item]).then(() => true, (error) => {
            console.warn(`[${EXTENSION_NAME}] Deferred clipboard write failed:`, error);
            return false;
        });
    } catch (error) {
        console.warn(`[${EXTENSION_NAME}] ClipboardItem unsupported:`, error);
        return null;
    }
}

/**
 * Opens CharacterVault's import page in a new tab
 * @returns {boolean} False if a popup blocker stopped it
 */
function openCharacterVault() {
    const vaultWindow = window.open(getVaultImportUrl(), '_blank');
    if (!vaultWindow) return false;

    try {
        vaultWindow.opener = null;
    } catch {
        // Already cross-origin; nothing to detach
    }
    return true;
}

const EXPORT_DIALOG_TEMPLATE = `
    <div class="charvault-export-header">
        <img class="charvault-export-avatar" alt="" loading="lazy">
        <div class="charvault-export-heading">
            <div class="charvault-export-title">Send to CharacterVault</div>
            <div class="charvault-export-name"></div>
        </div>
    </div>
    <div class="charvault-export-status" role="status" aria-live="polite">
        <i class="charvault-export-status-icon fa-solid" aria-hidden="true"></i>
        <span class="charvault-export-status-text"></span>
    </div>
    <ul class="charvault-export-facts" hidden></ul>
    <label class="checkbox_label charvault-export-avatar-toggle">
        <input type="checkbox">
        <span>Include avatar image</span>
    </label>
    <div class="charvault-export-actions">
        <a class="menu_button charvault-export-primary" target="_blank" rel="noopener" aria-disabled="true">
            <i class="fa-solid fa-arrow-up-right-from-square" aria-hidden="true"></i>
            <span class="charvault-export-primary-label"></span>
        </a>
        <button class="menu_button charvault-export-copy" type="button" disabled>
            <i class="fa-solid fa-copy" aria-hidden="true"></i>
            <span>Copy only</span>
        </button>
    </div>
    <div class="charvault-export-manual" hidden>
        <p>Your browser won't let the extension copy. Tap the box, select all, copy, then open CharacterVault and paste it there.</p>
        <textarea readonly rows="5" spellcheck="false"></textarea>
    </div>
`;

const STATUS_ICONS = {
    busy: 'fa-spinner fa-spin',
    ready: 'fa-circle-check',
    success: 'fa-clipboard-check',
    warning: 'fa-triangle-exclamation',
    error: 'fa-circle-exclamation',
};

/**
 * Shows the export dialog: prepares the payload in the background, then copies it and opens
 * CharacterVault from a single tap. Used on mobile, and on desktop when the browser blocked
 * the automatic copy or the new tab.
 * @param {number|string} characterId Index of the character in the characters array
 * @param {object} [options]
 * @param {PreparedExport} [options.prepared] Payload that has already been built
 * @param {string} [options.notice] Message to show instead of the ready status
 */
async function showExportDialog(characterId, { prepared = null, notice = '' } = {}) {
    const context = SillyTavern.getContext();
    const { Popup, POPUP_TYPE, POPUP_RESULT } = context;
    const character = context.characters[characterId];
    const settings = getSettings();
    const budget = context.isMobile() ? MOBILE_PAYLOAD_BUDGET : Infinity;

    const root = document.createElement('div');
    root.className = 'charvault-export';
    root.innerHTML = EXPORT_DIALOG_TEMPLATE;
    const find = (selector) => root.querySelector(selector);

    const avatarImg = find('.charvault-export-avatar');
    const statusEl = find('.charvault-export-status');
    const statusIcon = find('.charvault-export-status-icon');
    const statusText = find('.charvault-export-status-text');
    const factsList = find('.charvault-export-facts');
    const avatarToggle = find('.charvault-export-avatar-toggle input');
    const primaryButton = find('.charvault-export-primary');
    const primaryLabel = find('.charvault-export-primary-label');
    const copyButton = find('.charvault-export-copy');
    const manualSection = find('.charvault-export-manual');
    const manualTextarea = find('.charvault-export-manual textarea');

    avatarImg.src = context.getThumbnailUrl('avatar', character.avatar);
    find('.charvault-export-name').textContent = character.name;
    avatarToggle.checked = settings.includeAvatar;
    primaryButton.href = getVaultImportUrl();

    const popup = new Popup(root, POPUP_TYPE.TEXT, '', {
        okButton: false,
        cancelButton: 'Close',
        allowVerticalScrolling: true,
    });

    let current = prepared;
    let buildToken = 0;
    // Once the copy is done (or has to be done by hand), the main button only opens CharacterVault
    let openOnly = false;

    const setStatus = (kind, message) => {
        statusEl.dataset.kind = kind;
        statusIcon.className = `charvault-export-status-icon fa-solid ${STATUS_ICONS[kind]}`;
        statusText.textContent = message;
    };

    const setOpenOnly = (value) => {
        openOnly = value;
        primaryLabel.textContent = value ? 'Open CharacterVault' : 'Copy & open CharacterVault';
    };

    const setReady = (ready) => {
        primaryButton.setAttribute('aria-disabled', String(!ready));
        copyButton.disabled = !ready;
    };

    const renderFacts = () => {
        const facts = [
            ['fa-image', AVATAR_STATUS_TEXT[current.avatarStatus]],
            current.lorebookEntries > 0 && [
                'fa-book',
                `${plural(current.lorebookEntries, 'lorebook entry', 'lorebook entries')}${current.lorebookRefreshed ? ' (synced with World Info)' : ''}`,
            ],
            ['fa-comment', plural(current.greetings, 'greeting')],
            ['fa-weight-hanging', formatSize(current.text.length)],
        ].filter(Boolean);

        factsList.replaceChildren(...facts.map(([icon, text]) => {
            const item = document.createElement('li');
            const iconEl = document.createElement('i');
            iconEl.className = `fa-solid ${icon}`;
            iconEl.setAttribute('aria-hidden', 'true');
            const textEl = document.createElement('span');
            textEl.textContent = text;
            item.append(iconEl, textEl);
            return item;
        }));
        factsList.hidden = false;
    };

    const render = () => {
        renderFacts();
        setReady(true);

        if (notice) {
            setStatus('warning', notice);
            notice = '';
        } else if (current.text.length > budget) {
            setStatus('warning', `This card is large (${formatSize(current.text.length)}) and may not fit the phone clipboard. If CharacterVault can't read it, export as PNG from SillyTavern and import that file instead.`);
        } else {
            setStatus('ready', 'Ready to send.');
        }
    };

    const build = async () => {
        const token = ++buildToken;
        current = null;
        setOpenOnly(false);
        setReady(false);
        manualSection.hidden = true;
        factsList.hidden = true;
        setStatus('busy', 'Preparing character…');

        try {
            const result = await prepareExport(characterId, { includeAvatar: settings.includeAvatar, budget });
            if (token !== buildToken) return;
            current = result;
            render();
        } catch (error) {
            if (token !== buildToken) return;
            console.error(`[${EXTENSION_NAME}] Export failed:`, error);
            setStatus('error', `Couldn't prepare this character: ${error.message}`);
        }
    };

    const showManualCopy = () => {
        manualTextarea.value = current.text;
        manualSection.hidden = false;
        setOpenOnly(true);
        setStatus('warning', 'Automatic copy was blocked. Copy the text below by hand.');
        manualTextarea.focus({ preventScroll: true });
        manualTextarea.select();
    };

    // Let the link's own navigation finish before the dialog goes away
    const closeSoon = () => setTimeout(() => popup.complete(POPUP_RESULT.AFFIRMATIVE), 0);

    primaryButton.addEventListener('click', (event) => {
        if (!current) {
            event.preventDefault();
            return;
        }

        if (openOnly) {
            closeSoon();
            return;
        }

        // Copy synchronously so the link can open CharacterVault in the same tap;
        // a real link click isn't subject to popup blockers
        if (copyWithExecCommand(current.text, popup.dlg)) {
            closeSoon();
            return;
        }

        event.preventDefault();
        void copyWithClipboardApi(current.text).then((copied) => {
            if (!copied) {
                showManualCopy();
                return;
            }
            if (openCharacterVault()) {
                closeSoon();
                return;
            }
            setOpenOnly(true);
            setStatus('success', 'Copied! Now tap “Open CharacterVault”.');
        });
    });

    copyButton.addEventListener('click', () => {
        if (!current) return;

        if (copyWithExecCommand(current.text, popup.dlg)) {
            setStatus('success', 'Copied. Paste it on CharacterVault\'s import page.');
            return;
        }

        void copyWithClipboardApi(current.text).then((copied) => {
            if (copied) {
                setStatus('success', 'Copied. Paste it on CharacterVault\'s import page.');
            } else {
                showManualCopy();
            }
        });
    });

    manualTextarea.addEventListener('focus', () => manualTextarea.select());

    avatarToggle.addEventListener('change', () => {
        settings.includeAvatar = avatarToggle.checked;
        context.saveSettingsDebounced();
        $('#charvault_include_avatar').prop('checked', settings.includeAvatar);
        void build();
    });

    setOpenOnly(false);
    if (current) {
        render();
    } else {
        void build();
    }

    await popup.show();
}

/**
 * Exports a character to CharacterVault: copies the payload and opens the import page. On
 * mobile, or when the browser blocks the copy or the new tab, shows the export dialog instead.
 * Call it from a user gesture. Nothing may be awaited before the clipboard write starts.
 * @param {number|string|null} [characterId] Defaults to the character open in the editor
 */
async function exportToCharacterVault(characterId = getSelectedCharacterId()) {
    const context = SillyTavern.getContext();

    if (characterId === null || !context.characters[characterId]) {
        toastr.warning('Please select a character first', TOAST_TITLE);
        return;
    }

    try {
        if (context.isMobile()) {
            await showExportDialog(characterId);
            return;
        }

        const preparing = prepareExport(characterId, { includeAvatar: getSettings().includeAvatar });
        const deferredCopy = startDeferredClipboardWrite(() => preparing.then(prepared => prepared.text));

        let slowToast = null;
        const slowToastTimer = setTimeout(() => {
            slowToast = toastr.info('Preparing character…', TOAST_TITLE, { timeOut: 0, extendedTimeOut: 0 });
        }, SLOW_PREPARE_TOAST_DELAY);

        let prepared;
        try {
            prepared = await preparing;
        } finally {
            clearTimeout(slowToastTimer);
            if (slowToast) toastr.clear(slowToast);
        }

        const copied = (await deferredCopy)
            || await copyWithClipboardApi(prepared.text)
            || copyWithExecCommand(prepared.text);

        if (!copied) {
            await showExportDialog(characterId, {
                prepared,
                notice: 'Your browser blocked the automatic copy. Use the button below instead.',
            });
            return;
        }

        if (!openCharacterVault()) {
            await showExportDialog(characterId, {
                prepared,
                notice: 'Copied, but your browser blocked the new tab. Use the button below to open CharacterVault.',
            });
            return;
        }

        const avatarMissing = prepared.avatarStatus !== 'included' && prepared.avatarStatus !== 'excluded';
        toastr.success(
            `${prepared.name} copied${avatarMissing ? ' (without avatar)' : ''}. Opening CharacterVault…`,
            TOAST_TITLE,
        );
    } catch (error) {
        console.error(`[${EXTENSION_NAME}] Export failed:`, error);
        toastr.error(`Export failed: ${error.message}`, TOAST_TITLE);
    }
}

/**
 * Adds CharacterVault option to the export format popup
 */
function addExportOption() {
    const exportPopup = $('#export_format_popup');

    // Check if already added
    if (exportPopup.find(`[data-format="${EXPORT_FORMAT_CV}"]`).length > 0) {
        return;
    }

    const cvOption = $(`
        <div class="export_format list-group-item" data-format="${EXPORT_FORMAT_CV}" title="Send this character to CharacterVault">CHARACTERVAULT</div>`);

    exportPopup.append(cvOption);
}

/**
 * Closes SillyTavern's export menu through its own toggle, so its open/closed flag stays in
 * sync. Hiding the menu directly leaves the flag set, and the next Export click does nothing.
 */
function closeExportMenu() {
    const exportPopup = $('#export_format_popup');
    if (exportPopup.is(':visible')) {
        $('#export_button').trigger('click');
    }
    exportPopup.hide();
}

/**
 * Intercept export format clicks to handle our custom format
 */
function interceptExportClicks() {
    // SillyTavern's delegated .export_format handler saves the character before exporting,
    // which can fail with EPERM, and doesn't know this format. Catch the click in the capture
    // phase so its handler never runs for our option.
    const exportPopup = document.getElementById('export_format_popup');
    if (!exportPopup) return;

    // Remove any existing capture listener to prevent duplicates
    if (exportPopup._charvaultHandler) {
        exportPopup.removeEventListener('click', exportPopup._charvaultHandler, true);
    }

    // Deliberately not async: the clipboard write has to start inside this click
    const handler = function (e) {
        const target = e.target.closest('.export_format');
        if (!target || target.dataset.format !== EXPORT_FORMAT_CV) return;

        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();

        closeExportMenu();
        void exportToCharacterVault();
    };

    exportPopup._charvaultHandler = handler;
    exportPopup.addEventListener('click', handler, true);
}

/**
 * Validates a user-entered CharacterVault URL
 * @param {string} value
 * @returns {string} Normalized URL, or '' for the default
 * @throws {Error} If the URL isn't a valid http(s) URL
 */
function normalizeVaultUrl(value) {
    const trimmed = value.trim();
    if (!trimmed) return '';

    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error('The URL must start with http:// or https://');
    }
    url.hash = '';
    return url.href === DEFAULT_VAULT_URL ? '' : url.href;
}

/**
 * Inject extension settings into the extensions panel
 */
function injectSettings() {
    // Check if already injected
    if ($('#character_vault_export_settings').length > 0) return;

    const settings = getSettings();

    const settingsHtml = `
        <div id="character_vault_export_settings">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>CharacterVault Export</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <p>
                        Send the open character to CharacterVault from the
                        <i class="fa-solid fa-file-export"></i> Export menu → CharacterVault.
                    </p>
                    <label class="checkbox_label" for="charvault_include_avatar">
                        <input id="charvault_include_avatar" type="checkbox">
                        <span>Include avatar image</span>
                    </label>
                    <small class="charvault-settings-hint">
                        On phones and tablets, large avatars are compressed so the copy fits the clipboard.
                    </small>
                    <label for="charvault_vault_url">CharacterVault URL</label>
                    <div class="charvault-settings-url">
                        <input id="charvault_vault_url" class="text_pole" type="url" inputmode="url"
                            autocomplete="off" spellcheck="false" placeholder="${DEFAULT_VAULT_URL}">
                        <div id="charvault_vault_url_reset" class="menu_button fa-solid fa-rotate-left"
                            title="Reset to ${DEFAULT_VAULT_URL}" role="button" tabindex="0"></div>
                    </div>
                    <small class="charvault-settings-hint">
                        Leave empty for the hosted CharacterVault. Set it if you run your own copy, e.g. ${LEGACY_LOCALHOST_URL}
                    </small>
                    <a id="charvault_url_link" target="_blank" rel="noopener">
                        Open CharacterVault <i class="fa-solid fa-arrow-up-right-from-square"></i>
                    </a>
                    <small>
                        <strong>How to use:</strong>
                        <ol>
                            <li>Open a character</li>
                            <li>Click the <i class="fa-solid fa-file-export"></i> Export button</li>
                            <li>Choose "CharacterVault" from the dropdown</li>
                            <li>CharacterVault opens with the character ready to import</li>
                        </ol>
                    </small>
                </div>
            </div>
        </div>
    `;

    $('#extensions_settings').append(settingsHtml);

    const urlInput = $('#charvault_vault_url');
    const urlLink = $('#charvault_url_link');

    const showUrl = () => {
        urlInput.val(settings.vaultUrl);
        urlLink.attr('href', getVaultBaseUrl());
    };

    const saveUrl = (value) => {
        try {
            settings.vaultUrl = normalizeVaultUrl(value);
        } catch (error) {
            toastr.warning(`Invalid CharacterVault URL: ${error.message}`, TOAST_TITLE);
        }
        showUrl();
        SillyTavern.getContext().saveSettingsDebounced();
    };

    showUrl();
    urlInput.on('change', () => saveUrl(String(urlInput.val())));
    $('#charvault_vault_url_reset').on('click keydown', (e) => {
        if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        saveUrl('');
    });

    $('#charvault_include_avatar')
        .prop('checked', settings.includeAvatar)
        .on('change', function () {
            settings.includeAvatar = $(this).prop('checked');
            SillyTavern.getContext().saveSettingsDebounced();
        });
}

/**
 * Initialize the extension
 */
function init() {
    injectSettings();
    addExportOption();
    interceptExportClicks();

    // Re-add our option if something rebuilds the export menu
    const exportPopup = document.getElementById('export_format_popup');
    if (exportPopup) {
        new MutationObserver(addExportOption).observe(exportPopup, { childList: true });
    }

    console.log(`[${EXTENSION_NAME}] Extension loaded`);
}

jQuery(init);

// Export for potential external use
window.CharacterVaultExport = {
    exportToCharacterVault,
    buildClipboardPayload,
};
