// CharacterVault Export Extension for SillyTavern
// This extension adds a "CharacterVault" option to the export dropdown menu

import { characters } from '../../../../script.js';
import { getContext, extension_settings } from '../../../extensions.js';
import { isMobile } from '../../RossAscends-mods.js';
import { Popup, POPUP_RESULT, POPUP_TYPE } from '../../popup.js';

const EXTENSION_NAME = 'CharacterVaultExport';
const SETTINGS_KEY = 'CharacterVaultExport';

// URL options for export (with import path)
const URL_GITHUB_PAGES = 'https://spaceman2408.github.io/CharacterVault/#/import?source=st';
const URL_LOCALHOST = 'http://localhost:3000/#/import?source=st';

// Base URL options for settings link (without import path)
const URL_GITHUB_PAGES_BASE = 'https://spaceman2408.github.io/CharacterVault/';
const URL_LOCALHOST_BASE = 'http://localhost:3000/';

// Export format identifier
const EXPORT_FORMAT_CV = 'charactervault';

/**
 * Get extension settings with defaults
 * @returns {Object} Settings object
 */
function getSettings() {
    if (!extension_settings[SETTINGS_KEY]) {
        extension_settings[SETTINGS_KEY] = {
            useLocalhost: false
        };
    }
    return extension_settings[SETTINGS_KEY];
}

/**
 * Get the CharacterVault URL for export (with import path)
 * @returns {string} URL to open
 */
function getCharacterVaultUrl() {
    const settings = getSettings();
    return settings.useLocalhost ? URL_LOCALHOST : URL_GITHUB_PAGES;
}

/**
 * Get the CharacterVault base URL for settings link (without import path)
 * @returns {string} Base URL
 */
function getCharacterVaultBaseUrl() {
    const settings = getSettings();
    return settings.useLocalhost ? URL_LOCALHOST_BASE : URL_GITHUB_PAGES_BASE;
}

/**
 * Converts a File/Blob to base64 data URL
 * @param {Blob} blob - The blob to convert
 * @returns {Promise<string>} Base64 data URL
 */
async function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}

/**
 * Fetches character avatar and converts to base64
 * @param {number} characterIndex - Index of character in characters array
 * @returns {Promise<string|null>} Base64 data URL or null
 */
async function getCharacterAvatarBase64(characterIndex) {
    try {
        const character = characters[characterIndex];
        if (!character || !character.avatar) {
            return null;
        }

        // Try to get the avatar image from the character's folder
        const avatarUrl = `/characters/${character.avatar}`;
        const response = await fetch(avatarUrl);

        if (!response.ok) {
            console.warn(`[${EXTENSION_NAME}] Failed to fetch avatar: ${response.status}`);
            return null;
        }

        const blob = await response.blob();
        const base64 = await blobToBase64(blob);
        return base64;
    } catch (error) {
        console.warn(`[${EXTENSION_NAME}] Error getting avatar:`, error);
        return null;
    }
}

/**
 * Extracts lorebook entry fields for export
 * @param {Object} entry - Lorebook entry
 * @returns {Object} Formatted entry
 */
function extractLorebookEntry(entry) {
    return {
        id: entry.id ?? 0,
        keys: entry.keys ?? [],
        secondary_keys: entry.secondary_keys ?? [],
        comment: entry.comment ?? '',
        content: entry.content ?? '',
        constant: entry.constant ?? false,
        selective: entry.selective ?? false,
        insertion_order: entry.insertion_order ?? 0,
        enabled: entry.enabled ?? true,
        position: entry.position ?? 'after_char',
        name: entry.name ?? '',
        priority: entry.priority ?? 0,
        case_sensitive: entry.case_sensitive ?? false,
        extensions: entry.extensions ?? {}
    };
}

/**
 * Extracts character book data
 * @param {Object} characterBook - Character book object
 * @returns {Object|null} Formatted character book or null
 */
function extractCharacterBook(characterBook) {
    if (!characterBook) return null;

    return {
        name: characterBook.name ?? '',
        description: characterBook.description ?? '',
        scan_depth: characterBook.scan_depth ?? 100,
        token_budget: characterBook.token_budget ?? 500,
        recursive_scanning: characterBook.recursive_scanning ?? false,
        extensions: characterBook.extensions ?? {},
        entries: (characterBook.entries ?? []).map(extractLorebookEntry)
    };
}

/**
 * Builds the clipboard payload for CharacterVault
 * @param {number} characterIndex - Index of character in characters array
 * @returns {Promise<Object>} Clipboard payload
 */
async function buildClipboardPayload(characterIndex) {
    const character = characters[characterIndex];
    if (!character) {
        throw new Error('Character not found');
    }

    // Get character data - prefer data property (V2 format), fall back to top-level
    const data = character.data || {};

    // Get avatar as base64
    const avatar = await getCharacterAvatarBase64(characterIndex);

    // Build the character card V2 structure
    const characterCard = {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name: data.name ?? character.name ?? 'Unknown',
            description: data.description ?? '',
            personality: data.personality ?? '',
            scenario: data.scenario ?? '',
            first_mes: data.first_mes ?? '',
            mes_example: data.mes_example ?? '',
            creator_notes: data.creator_notes ?? '',
            system_prompt: data.system_prompt ?? '',
            post_history_instructions: data.post_history_instructions ?? data.post_history_instructions ?? '',
            alternate_greetings: data.alternate_greetings ?? [],
            tags: data.tags ?? [],
            creator: data.creator ?? '',
            character_version: data.character_version ?? '',
            extensions: {
                talkativeness: data.extensions?.talkativeness,
                world: data.extensions?.world,
                depth_prompt: data.extensions?.depth_prompt,
                regex_scripts: data.extensions?.regex_scripts,
                ...((data.extensions && Object.keys(data.extensions).length > 0) ? data.extensions : {})
            },
            character_book: extractCharacterBook(data.character_book)
        }
    };

    // Clean up undefined values in extensions
    const extensions = characterCard.data.extensions;
    Object.keys(extensions).forEach(key => {
        if (extensions[key] === undefined) {
            delete extensions[key];
        }
    });

    // Build the final payload
    const payload = {
        source: 'st',
        character: characterCard
    };

    // Add avatar if available
    if (avatar) {
        payload.avatar = avatar;
    } else {
        payload.avatar = null;
    }

    return payload;
}

/**
 * Attempts to copy text to clipboard using the modern API.
 * Returns { success: boolean, text: string } so callers can fallback.
 * @param {string} text - Text to copy
 * @returns {Promise<{success: boolean, text: string}>}
 */
async function copyToClipboard(text) {
    try {
        await navigator.clipboard.writeText(text);
        return { success: true, text };
    } catch (err) {
        console.warn(`[${EXTENSION_NAME}] Clipboard API failed:`, err);
        return { success: false, text };
    }
}

/**
 * Fallback clipboard copy using execCommand.
 * Works on mobile when triggered from a user gesture on a focused textarea.
 * @param {HTMLTextAreaElement} textarea - The textarea containing the text
 * @returns {boolean} Success status
 */
function fallbackCopyFromTextarea(textarea) {
    try {
        textarea.select();
        textarea.setSelectionRange(0, 99999); // iOS compatibility
        const success = document.execCommand('copy');
        return success;
    } catch (err) {
        console.warn(`[${EXTENSION_NAME}] execCommand copy failed:`, err);
        return false;
    }
}

/**
 * Escapes HTML special characters to prevent XSS in the textarea
 * @param {string} text
 * @returns {string}
 */
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/**
 * Shows a popup with the payload text for manual copying (mobile fallback)
 * @param {string} payloadText - The JSON payload string
 */
async function showManualCopyPopup(payloadText) {
    const popupContent = `
        <div class="charvault-manual-copy-popup">
            <p>Your device couldn't copy automatically. Copy the data below, then open CharacterVault.</p>
            <textarea class="charvault-payload-textarea" readonly rows="8">${escapeHtml(payloadText)}</textarea>
            <div class="charvault-copy-status"></div>
        </div>
    `;

    const popup = new Popup(popupContent, POPUP_TYPE.CONFIRM, '', {
        okButton: 'Open CharacterVault',
        cancelButton: 'Close',
        wide: true,
        allowVerticalScrolling: true,
        customButtons: [
            {
                text: 'Copy to Clipboard',
                icon: 'fa-copy',
                classes: ['charvault-copy-btn'],
                result: null, // Don't close popup on click
                action: () => {
                    const textarea = popup.content.querySelector('.charvault-payload-textarea');
                    const statusDiv = popup.content.querySelector('.charvault-copy-status');
                    if (textarea) {
                        const success = fallbackCopyFromTextarea(textarea);
                        if (success) {
                            statusDiv.textContent = '✓ Copied!';
                            statusDiv.className = 'charvault-copy-status charvault-copy-success';
                        } else {
                            statusDiv.textContent = 'Select the text above and use your device\'s copy function.';
                            statusDiv.className = 'charvault-copy-status charvault-copy-fallback';
                        }
                    }
                }
            }
        ],
        onOpen: (popupInstance) => {
            const textarea = popupInstance.content.querySelector('.charvault-payload-textarea');
            if (textarea) {
                setTimeout(() => {
                    textarea.focus();
                    textarea.select();
                    textarea.setSelectionRange(0, 99999);
                }, 100);
            }
        }
    });

    const result = await popup.show();

    // If user clicked "Open CharacterVault" (AFFIRMATIVE), open the URL
    if (result === POPUP_RESULT.AFFIRMATIVE) {
        window.open(getCharacterVaultUrl(), '_blank');
        toastr.success('Opening CharacterVault — paste your character data there', 'CharacterVault Export');
    }
}

/**
 * Exports the current character to CharacterVault
 */
async function exportToCharacterVault() {
    try {
        const context = getContext();
        const this_chid = context.characterId;

        if (this_chid === undefined || this_chid === null) {
            toastr.warning('Please select a character first', 'CharacterVault Export');
            return;
        }

        // Build payload
        const payload = await buildClipboardPayload(this_chid);
        const payloadText = JSON.stringify(payload);

        // On mobile, skip clipboard API and go straight to manual copy popup
        // for cleaner UX (avoids the brief error flash)
        if (isMobile()) {
            await showManualCopyPopup(payloadText);
            return;
        }

        // Attempt clipboard copy (desktop)
        const { success } = await copyToClipboard(payloadText);

        if (success) {
            // Normal flow — clipboard worked
            window.open(getCharacterVaultUrl(), '_blank');
            toastr.success('Character copied! Opening CharacterVault...', 'CharacterVault Export');
        } else {
            // Desktop but clipboard failed — show manual copy popup as fallback
            await showManualCopyPopup(payloadText);
        }
    } catch (error) {
        console.error(`[${EXTENSION_NAME}] Export failed:`, error);
        toastr.error(`Export failed: ${error.message}`, 'CharacterVault Export');
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

    // Add the CharacterVault option
    const cvOption = $(`
        <div class="export_format list-group-item" data-format="${EXPORT_FORMAT_CV}">CHARACTERVAULT</div>`);

    exportPopup.append(cvOption);
}

/**
 * Intercept export format clicks to handle our custom format
 */
function interceptExportClicks() {
    // SillyTavern binds its export handler to document for .export_format clicks
    // The handler calls createOrEditCharacter() which triggers a save and causes EPERM errors
    // We need to intercept and stop ST's handler from running for our format

    const exportPopup = document.getElementById('export_format_popup');
    if (!exportPopup) return;

    // Remove any existing capture listener to prevent duplicates
    // We store the handler on the element for cleanup
    if (exportPopup._charvaultHandler) {
        exportPopup.removeEventListener('click', exportPopup._charvaultHandler, true);
    }

    // Define the handler
    const handler = async function (e) {
        const target = e.target.closest('.export_format');
        if (!target) return;

        const format = target.dataset.format;
        if (format !== EXPORT_FORMAT_CV) return;

        // Stop the event completely - prevents jQuery delegated handlers
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();

        // Hide the popup
        $('#export_format_popup').hide();

        // Handle our export
        await exportToCharacterVault();
    };

    // Store reference for cleanup
    exportPopup._charvaultHandler = handler;

    // Use capture phase to catch the click before it bubbles to document
    // where jQuery's delegated handlers are waiting
    exportPopup.addEventListener('click', handler, true);
}

/**
 * Inject extension settings into the extensions panel
 */
async function injectSettings() {
    // Check if already injected
    if ($('#character_vault_export_settings').length > 0) return;

    const settings = getSettings();
    const settingsUrl = getCharacterVaultBaseUrl();

    const settingsHtml = `
        <div id="character_vault_export_settings">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>CharacterVault Export</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <p>
                        Export characters to CharacterVault by selecting "CharacterVault" from the Export menu.
                    </p>
                    <div class="flex-container">
                        <label class="checkbox_label" for="charvault_use_localhost" title="Use localhost:3000 instead of GitHub Pages">
                            <input id="charvault_use_localhost" type="checkbox" ${settings.useLocalhost ? 'checked' : ''}>
                            <span>Use Localhost (dev mode)</span>
                        </label>
                    </div>
                    <div class="flex-container">
                        <span>CharacterVault URL:</span>
                        <a href="${settingsUrl}" target="_blank" id="charvault_url_link">
                            Open CharacterVault <i class="fa-solid fa-external-link-alt"></i>
                        </a>
                    </div>
                    <div>
                        <small>
                            <strong>How to use:</strong>
                            <ol>
                                <li>Select a character</li>
                                <li>Click the <i class="fa-solid fa-file-export"></i> Export button</li>
                                <li>Choose "CharacterVault" from the dropdown</li>
                                <li>CharacterVault will open with your character data ready</li>
                            </ol>
                        </small>
                    </div>
                </div>
            </div>
        </div>
    `;

    $('#extensions_settings').append(settingsHtml);

    // Bind toggle event
    $(document).on('change', '#charvault_use_localhost', function() {
        const useLocalhost = $(this).prop('checked');
        settings.useLocalhost = useLocalhost;

        // Update the settings URL link (base URL, not export URL)
        const newUrl = getCharacterVaultBaseUrl();
        $('#charvault_url_link').attr('href', newUrl);

        console.log(`[${EXTENSION_NAME}] URL mode changed to: ${useLocalhost ? 'localhost' : 'github pages'}`);
    });
}

/**
 * Initialize the extension
 */
async function init() {
    console.log(`[${EXTENSION_NAME}] Initializing...`);

    // Inject settings panel
    await injectSettings();

    // Add the export option
    addExportOption();

    // Intercept export clicks
    interceptExportClicks();

    // Watch for popup being shown and ensure our option is there
    const observer = new MutationObserver(() => {
        addExportOption();
    });

    const exportPopup = document.getElementById('export_format_popup');
    if (exportPopup) {
        observer.observe(exportPopup, { childList: true });
    }

    console.log(`[${EXTENSION_NAME}] Extension loaded successfully`);
}

// Initialize when jQuery is ready
jQuery(async () => {
    await init();
});

// Export for potential external use
window.CharacterVaultExport = {
    exportToCharacterVault,
    buildClipboardPayload
};
