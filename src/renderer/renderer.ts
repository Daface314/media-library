// renderer.ts — All UI logic lives here.
// This runs in the browser/renderer process (not Node.js).
// It can access DOM APIs (document, window) but NOT the filesystem directly.
// It communicates with the database through window.api (defined in preload.ts).

// window.api is declared in src/renderer/globals.d.ts

// ─── State ────────────────────────────────────────────────────────────────
// These are like member variables — they track the current view state.
let currentTab        = 'all';
let currentTypeFilter = 'all';
let currentStatusFilter = 'all';
let activeTagFilter: string | null = null;

// Genre picker state
let allGenres: string[] = [];              // full list of genre names from the DB
let selectedGenres: Set<string> = new Set(); // genres selected in the currently open modal

// Edit mode: null = adding a new entry, number = editing the entry with that id
let editingEntryId: number | null = null;

// ─── DOM References ───────────────────────────────────────────────────────
// getElementById grabs references to HTML elements by their id="" attribute.
// The ! at the end tells TypeScript "I know this won't be null" (non-null assertion).
// The "as HTMLInputElement" cast is like a static_cast in C++ — we tell TypeScript
// the specific element type so we can access its .value property.
const mediaGrid      = document.getElementById('media-grid')!;
const searchInput    = document.getElementById('search-input') as HTMLInputElement;
const genreList      = document.getElementById('genre-list')!;
const modalOverlay   = document.getElementById('modal-overlay')!;
const addMediaBtn    = document.getElementById('add-media-btn')!;
const modalCancelBtn = document.getElementById('modal-cancel')!;
const modalSaveBtn   = document.getElementById('modal-save')!;
const contentTitle   = document.getElementById('content-title')!;

// ─── Entry Point ──────────────────────────────────────────────────────────
// DOMContentLoaded fires once all HTML elements are ready to be accessed.
// It's the equivalent of putting code at the bottom of main() after setup.
document.addEventListener('DOMContentLoaded', async () => {
    await loadMedia();
    await loadGenres();
    setupEventListeners();
});

// ─── Data Loading ─────────────────────────────────────────────────────────

// Fetches and displays media based on the current sidebar tab and filters.
// async/await is TypeScript's way of handling operations that take time
// (like database calls). "await" pauses execution until the result is ready —
// cleaner than nested callbacks or .then() chains.
async function loadMedia(): Promise<void> {
    let items: any[];

    // Decide which data to fetch based on the active tab
    if (currentTab === 'search' && searchInput.value.trim()) {
        items = await window.api.searchMedia(searchInput.value.trim());
    } else if (currentTab === 'genres' && activeTagFilter) {
        items = await window.api.getByTag(activeTagFilter);
    } else if (currentTab === 'mylist' && currentStatusFilter !== 'all') {
        items = await window.api.getByStatus(currentStatusFilter);
    } else {
        items = await window.api.getAllMedia();
    }

    // Apply the media type chip filter on top (All / Movie / Anime / etc.)
    if (currentTypeFilter !== 'all') {
        // .filter() returns a new array containing only items that pass the test
        items = items.filter(item => item.type === currentTypeFilter);
    }

    renderMediaGrid(items);
}

// Fetches all tags from the database and populates the Genres sidebar panel.
async function loadGenres(): Promise<void> {
    const tags = await window.api.getAllTags();
    genreList.innerHTML = '';  // clear existing list

    tags.forEach((tag: { id: number; name: string; count: number }) => {
        const li = document.createElement('li');
        li.className = 'genre-item';

        // Build the item as two parts: clickable name and a delete button
        li.innerHTML = `
            <span class="genre-item-label">${escapeHtml(tag.name)}<span class="genre-item-count">${tag.count}</span></span>
            <button class="genre-delete-btn" title="Delete genre">×</button>
        `;

        // Clicking the label text filters the main grid by this genre
        li.querySelector('.genre-item-label')!.addEventListener('click', () => filterByTag(tag.name));

        // Clicking × deletes the genre from the DB entirely
        li.querySelector('.genre-delete-btn')!.addEventListener('click', async (e) => {
            e.stopPropagation();  // prevent the label click from firing too
            await window.api.deleteTag(tag.id);
            // If we were currently viewing this genre, go back to all
            if (activeTagFilter === tag.name) {
                activeTagFilter = null;
                contentTitle.textContent = 'All Media';
            }
            await loadGenres();
            await loadMedia();
        });

        genreList.appendChild(li);
    });
}

// ─── Rendering ────────────────────────────────────────────────────────────

// Builds and inserts media cards into the grid from an array of entries.
function renderMediaGrid(items: any[]): void {
    mediaGrid.innerHTML = '';  // wipe the current grid

    if (items.length === 0) {
        mediaGrid.innerHTML = '<p class="empty-message">Nothing here yet. Add some entries!</p>';
        return;
    }

    items.forEach(item => {
        const card = document.createElement('div');
        card.className = `media-card type-${item.type}`;

        // Template literals (backtick strings) let you embed ${variables} inline —
        // like String.format() in Java or std::format() in C++.
        const extraInfo = formatExtraField(item.fields, item.type);
        card.innerHTML = `
            <div class="card-type-badge">${item.type}</div>
            <h3 class="card-title">${escapeHtml(item.title)}</h3>
            <div class="card-status status-${item.status}">${formatStatus(item.status)}</div>
            ${extraInfo ? `<div class="card-extra">${extraInfo}</div>` : ''}
            <div class="card-tags">
                ${(item.tags ?? []).map((t: string) => `<span class="tag">${escapeHtml(t)}</span>`).join('')}
            </div>
            <div class="card-actions">
                <button class="edit-btn" title="Edit">✎</button>
                <button class="delete-btn" title="Remove">✕</button>
            </div>
        `;

        // Attach edit handler — opens the modal pre-filled with this entry's data
        card.querySelector('.edit-btn')!.addEventListener('click', async (e) => {
            e.stopPropagation();
            await openEditModal(item);
        });

        // Attach delete handler
        card.querySelector('.delete-btn')!.addEventListener('click', async (e) => {
            e.stopPropagation();
            await window.api.deleteMedia(item.id);
            await loadMedia();
            await loadGenres();
        });

        mediaGrid.appendChild(card);
    });
}

// ─── Event Listeners ──────────────────────────────────────────────────────

function setupEventListeners(): void {

    // Sidebar tab buttons
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            switchTab((btn as HTMLElement).dataset.tab!);
        });
    });

    // Media type filter chips (All / Movies / Shows / ...)
    document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentTypeFilter = (btn as HTMLElement).dataset.type!;
            await loadMedia();
        });
    });

    // Status items in "My List" panel
    document.querySelectorAll('.status-item').forEach(item => {
        item.addEventListener('click', async () => {
            document.querySelectorAll('.status-item').forEach(i => i.classList.remove('active'));
            item.classList.add('active');
            currentStatusFilter = (item as HTMLElement).dataset.status!;
            const label = formatStatus(currentStatusFilter);
            contentTitle.textContent = label === 'All' ? 'My List' : label;
            await loadMedia();
        });
    });

    // Search: re-run query on every keystroke
    searchInput.addEventListener('input', async () => {
        await loadMedia();
    });

    // Modal: open when "Add Entry" is clicked
    addMediaBtn.addEventListener('click', async () => {
        modalOverlay.classList.remove('hidden');
        await openGenrePicker();
        initExtraFields();
        // Set the correct extra field for whichever type is currently selected
        const typeSelect = document.getElementById('input-type') as HTMLSelectElement;
        updateExtraFields(typeSelect.value);
    });

    // Modal: close on Cancel button or clicking the dark overlay behind the modal
    modalCancelBtn.addEventListener('click', closeModal);
    modalOverlay.addEventListener('click', (e) => {
        if (e.target === modalOverlay) closeModal();
    });

    // Modal: save the new entry
    modalSaveBtn.addEventListener('click', saveNewEntry);
}

// ─── Modal Logic ──────────────────────────────────────────────────────────

async function saveNewEntry(): Promise<void> {
    const titleInput   = document.getElementById('input-title')   as HTMLInputElement;
    const typeSelect   = document.getElementById('input-type')    as HTMLSelectElement;
    const statusSelect = document.getElementById('input-status')  as HTMLSelectElement;
    const notesArea    = document.getElementById('input-notes')   as HTMLTextAreaElement;

    const title  = titleInput.value.trim();
    const type   = typeSelect.value;
    const status = statusSelect.value;
    const notes  = notesArea.value.trim();

    if (!title) {
        alert('Please enter a title.');
        return;
    }

    // Shared helper: save genres and extra fields for a given entry id
    const extraFieldMap: Record<string, { inputId: string; fieldName: string }> = {
        anime: { inputId: 'input-episodes', fieldName: 'episodes' },
        show:  { inputId: 'input-episodes', fieldName: 'episodes' },
        book:  { inputId: 'input-pages',    fieldName: 'pages'    },
        manga: { inputId: 'input-volumes',  fieldName: 'volumes'  },
    };

    if (editingEntryId !== null) {
        // ── Edit mode: update the existing row ──
        await window.api.updateMedia(editingEntryId, title, type, status, notes);

        // Wipe old genres and re-add the current selection
        await window.api.clearMediaTags(editingEntryId);
        for (const genre of selectedGenres) {
            await window.api.addTagToMedia(editingEntryId, genre);
        }

        // Wipe old extra fields and re-add
        await window.api.clearMediaFields(editingEntryId);
        const extraDef = extraFieldMap[type];
        if (extraDef) {
            const extraInput = document.getElementById(extraDef.inputId) as HTMLInputElement;
            if (extraInput.value.trim()) {
                await window.api.addMediaField(editingEntryId, extraDef.fieldName, extraInput.value.trim());
            }
        }
    } else {
        // ── Add mode: insert a new row ──
        const entry = await window.api.addMedia(title, type, status, notes);

        for (const genre of selectedGenres) {
            await window.api.addTagToMedia(entry.id, genre);
        }

        const extraDef = extraFieldMap[type];
        if (extraDef) {
            const extraInput = document.getElementById(extraDef.inputId) as HTMLInputElement;
            if (extraInput.value.trim()) {
                await window.api.addMediaField(entry.id, extraDef.fieldName, extraInput.value.trim());
            }
        }
    }

    closeModal();
    titleInput.value = '';
    notesArea.value  = '';

    await loadMedia();
    await loadGenres();
}

function closeModal(): void {
    modalOverlay.classList.add('hidden');
    // Reset edit state and restore modal to "add" mode
    editingEntryId = null;
    const modalTitle = document.getElementById('modal-title')!;
    modalTitle.textContent = 'Add New Entry';
    modalSaveBtn.textContent = 'Save';
    // Reset form fields
    (document.getElementById('input-title') as HTMLInputElement).value = '';
    (document.getElementById('input-notes') as HTMLTextAreaElement).value = '';
    // Reset genre picker
    selectedGenres.clear();
    renderSelectedChips();
    const genreSearch = document.getElementById('genre-search') as HTMLInputElement;
    genreSearch.value = '';
    hideGenreDropdown();
    // Reset extra fields
    document.querySelectorAll('.extra-field input').forEach(el => {
        (el as HTMLInputElement).value = '';
    });
}

// Opens the modal pre-filled with an existing entry's data for editing.
async function openEditModal(item: any): Promise<void> {
    editingEntryId = item.id;

    // Update modal heading and save button to reflect edit mode
    document.getElementById('modal-title')!.textContent  = 'Edit Entry';
    modalSaveBtn.textContent = 'Update';

    // Pre-fill form fields
    (document.getElementById('input-title')  as HTMLInputElement).value  = item.title;
    (document.getElementById('input-type')   as HTMLSelectElement).value = item.type;
    (document.getElementById('input-status') as HTMLSelectElement).value = item.status;
    (document.getElementById('input-notes')  as HTMLTextAreaElement).value = item.notes ?? '';

    // Pre-select existing genres as chips
    selectedGenres = new Set(item.tags ?? []);

    // Show the modal, then init the genre picker (fetches latest genre list from DB)
    modalOverlay.classList.remove('hidden');
    await openGenrePicker();
    renderSelectedChips();

    // Show the right extra field for this type and pre-fill its value
    initExtraFields();
    updateExtraFields(item.type);
    const fieldValueMap: Record<string, string> = {
        anime: 'input-episodes',
        show:  'input-episodes',
        book:  'input-pages',
        manga: 'input-volumes',
    };
    const inputId = fieldValueMap[item.type];
    if (inputId && item.fields) {
        const fieldName = inputId === 'input-episodes' ? 'episodes'
                        : inputId === 'input-pages'    ? 'pages'
                        : 'volumes';
        (document.getElementById(inputId) as HTMLInputElement).value = item.fields[fieldName] ?? '';
    }
}

// ─── Genre Picker ─────────────────────────────────────────────────────────

// Called when the modal opens — fetches the current genre list and wires up events.
// Only wires events once by checking a data attribute as a flag.
async function openGenrePicker(): Promise<void> {
    const tags = await window.api.getAllTags();
    // Keep allGenres in sync with whatever is in the DB right now
    allGenres = tags.map(t => t.name);

    const picker     = document.getElementById('genre-picker')!;
    const searchInput = document.getElementById('genre-search') as HTMLInputElement;
    const dropdown   = document.getElementById('genre-dropdown')!;

    // 'data-wired' flag prevents re-attaching the same listeners every time the modal opens
    if (picker.dataset.wired) return;
    picker.dataset.wired = 'true';

    // Clicking anywhere on the picker container focuses the search input
    picker.addEventListener('click', () => searchInput.focus());

    // Show dropdown when the input gains focus
    searchInput.addEventListener('focus', () => {
        renderGenreDropdown(searchInput.value);
    });

    // Filter the dropdown as the user types
    searchInput.addEventListener('input', () => {
        renderGenreDropdown(searchInput.value);
    });

    // Hide the dropdown when the input loses focus.
    // We use mousedown (not click) on dropdown items so they fire BEFORE blur —
    // that way the item click registers before the dropdown disappears.
    searchInput.addEventListener('blur', () => {
        // Small delay lets the mousedown on a dropdown item fire first
        setTimeout(hideGenreDropdown, 150);
    });

    // Pressing Enter selects the top item or creates a new genre
    searchInput.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key !== 'Enter') return;
        const topItem = dropdown.querySelector('.dropdown-item') as HTMLElement | null;
        if (topItem) topItem.click();  // trigger the mousedown handler on the first item
    });
}

// Rebuild the dropdown list based on the current search text.
function renderGenreDropdown(filter: string): void {
    const dropdown = document.getElementById('genre-dropdown')!;
    const lc = filter.trim().toLowerCase();

    // Genres that match the filter and aren't already selected
    const matches = allGenres.filter(g =>
        g.toLowerCase().includes(lc) && !selectedGenres.has(g)
    );

    dropdown.innerHTML = '';  // clear previous items

    // Show "Add X" option if the typed text doesn't exactly match an existing genre
    const exactMatch = allGenres.some(g => g.toLowerCase() === lc);
    if (filter.trim() && !exactMatch) {
        const li = document.createElement('li');
        li.className = 'dropdown-item add-new';
        li.textContent = `+ Add "${filter.trim()}"`;
        // mousedown fires before blur, so this click goes through even as the input loses focus
        li.addEventListener('mousedown', () => addAndSelectGenre(filter.trim()));
        dropdown.appendChild(li);
    }

    // One list item per matching genre
    matches.forEach(genre => {
        const li = document.createElement('li');
        li.className = 'dropdown-item';
        li.textContent = genre;
        li.addEventListener('mousedown', () => selectGenre(genre));
        dropdown.appendChild(li);
    });

    // Hide the dropdown if there's nothing to show
    dropdown.classList.toggle('hidden', dropdown.children.length === 0);
}

// Add a genre to the selected set and refresh the chip display.
function selectGenre(genre: string): void {
    selectedGenres.add(genre);
    renderSelectedChips();
    // Clear the search input and re-render the dropdown (now without the selected genre)
    const searchInput = document.getElementById('genre-search') as HTMLInputElement;
    searchInput.value = '';
    renderGenreDropdown('');
    searchInput.focus();
}

// Creates a brand-new genre (adds it to our local list) then selects it.
// The genre gets saved to the DB when the entry is saved via addTagToMedia().
function addAndSelectGenre(genre: string): void {
    if (!allGenres.includes(genre)) {
        allGenres.push(genre);
        allGenres.sort();  // keep the list alphabetical
    }
    selectGenre(genre);
}

// Rebuild the chips row from the current selectedGenres set.
function renderSelectedChips(): void {
    const container = document.getElementById('selected-genres')!;
    container.innerHTML = '';

    selectedGenres.forEach(genre => {
        const chip = document.createElement('span');
        chip.className = 'genre-chip';
        // escapeHtml prevents a genre named e.g. "<b>test</b>" from injecting HTML
        chip.innerHTML = `${escapeHtml(genre)}<button class="chip-remove" title="Remove">×</button>`;
        chip.querySelector('.chip-remove')!.addEventListener('click', () => {
            selectedGenres.delete(genre);
            renderSelectedChips();
        });
        container.appendChild(chip);
    });
}

function hideGenreDropdown(): void {
    const dropdown = document.getElementById('genre-dropdown');
    dropdown?.classList.add('hidden');
}

// ─── Extra Fields ─────────────────────────────────────────────────────────

// Maps each media type to which extra field div to show and which input to use.
const EXTRA_FIELD_MAP: Record<string, string> = {
    anime: 'field-episodes',
    show:  'field-episodes',
    book:  'field-pages',
    manga: 'field-volumes',
};

// Wire up the type <select> so changing it shows/hides the correct field.
// Uses a data-wired flag so we only attach the listener once.
function initExtraFields(): void {
    const typeSelect = document.getElementById('input-type') as HTMLSelectElement;
    if (typeSelect.dataset.wired) return;
    typeSelect.dataset.wired = 'true';

    typeSelect.addEventListener('change', () => {
        updateExtraFields(typeSelect.value);
    });
}

// Show only the extra field that matches the current type; hide and clear the rest.
function updateExtraFields(type: string): void {
    document.querySelectorAll('.extra-field').forEach(el => {
        (el as HTMLElement).classList.add('hidden');
        const input = el.querySelector('input') as HTMLInputElement | null;
        if (input) input.value = '';
    });

    const fieldId = EXTRA_FIELD_MAP[type];
    if (fieldId) {
        document.getElementById(fieldId)?.classList.remove('hidden');
    }
}

// Formats the extra field value for display on a card, e.g. "26 eps" or "412 pages".
function formatExtraField(fields: Record<string, string> | undefined, type: string): string {
    if (!fields) return '';
    if ((type === 'anime' || type === 'show') && fields.episodes) return `${fields.episodes} eps`;
    if (type === 'book'  && fields.pages)   return `${fields.pages} pages`;
    if (type === 'manga' && fields.volumes) return `${fields.volumes} vols`;
    return '';
}

// ─── Tab Switching ────────────────────────────────────────────────────────

function switchTab(tab: string): void {
    currentTab = tab;
    activeTagFilter = null;

    // Toggle active class on tab buttons
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.toggle('active', (btn as HTMLElement).dataset.tab === tab);
    });

    // Show/hide sidebar panels — only one visible at a time
    document.querySelectorAll('.panel').forEach(p => {
        (p as HTMLElement).style.display = 'none';
    });
    const panel = document.getElementById(`panel-${tab}`);
    if (panel) panel.style.display = 'block';

    // Update the main content area heading
    const titles: Record<string, string> = {
        all:    'All Media',
        search: 'Search',
        genres: 'Genres',
        mylist: 'My List'
    };
    contentTitle.textContent = titles[tab] ?? tab;

    loadMedia();
}

function filterByTag(tagName: string): void {
    activeTagFilter = tagName;
    contentTitle.textContent = tagName;

    // Highlight the clicked genre item
    document.querySelectorAll('.genre-item').forEach(el => {
        el.classList.toggle('active', el.textContent?.startsWith(tagName) ?? false);
    });

    loadMedia();
}

// ─── Utilities ────────────────────────────────────────────────────────────

// Escapes HTML special characters in user-supplied text so they can't inject
// HTML/script tags into the UI. Always do this when displaying user data.
// e.g. a title of "<b>hi</b>" renders as text, not bold.
function escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.appendChild(document.createTextNode(text));
    return div.innerHTML;
}

// Maps database status keys to human-readable display labels.
// Record<string, string> is like a Map<String, String> in Java.
function formatStatus(status: string): string {
    const labels: Record<string, string> = {
        planning:    'Planning',
        in_progress: 'In Progress',
        completed:   'Completed',
        dropped:     'Dropped',
        on_hold:     'On Hold',
        all:         'All'
    };
    return labels[status] ?? status;
}
