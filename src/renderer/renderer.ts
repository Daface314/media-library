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
let currentSort: 'az' | 'za' | 'rating-high' | 'rating-low' = 'az';

// Header genre filter — supports multi-select with AND/OR logic
let genreFilterSet:  Set<string>    = new Set();
let genreFilterMode: 'and' | 'or'  = 'and';

// Genre picker state
let allGenres: string[] = [];              // full list of genre names from the DB
let selectedGenres: Set<string> = new Set(); // genres selected in the currently open modal

// Edit mode: null = adding a new entry, number = editing the entry with that id
let editingEntryId: number | null = null;

// Star rating selected in the currently open modal (1–5, or null for no rating)
let currentRating: number | null = null;

// Holds the cover image URL chosen from a Jikan result (null if not from Jikan).
// Saved to media_fields as 'image_url' alongside episodes/pages/volumes.
let currentImageUrl: string | null = null;

// English title from Jikan (stored separately from the main title so search can match it).
// Jikan's main title is often Japanese/romaji; title_english is the English localized name.
let currentTitleEnglish: string | null = null;

// Release year from auto-fill (stored in media_fields as 'year').
let currentYear: string | null = null;

// Description/synopsis from auto-fill (stored in media_fields as 'description').
let currentDescription: string | null = null;

// ─── DOM References ───────────────────────────────────────────────────────
// getElementById grabs references to HTML elements by their id="" attribute.
// The ! at the end tells TypeScript "I know this won't be null" (non-null assertion).
// The "as HTMLInputElement" cast is like a static_cast in C++ — we tell TypeScript
// the specific element type so we can access its .value property.
const mediaGrid      = document.getElementById('media-grid')!;
const searchInput    = document.getElementById('search-input') as HTMLInputElement;
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
    initStarRating();
    initJikanSearch();
    initTmdbSearch();
    // Refresh metadata in the background after the library is shown.
    // void discards the promise intentionally — we don't want to block startup.
    void refreshAllEntries();
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
    } else if (currentTab === 'mylist' && currentStatusFilter !== 'all') {
        items = await window.api.getByStatus(currentStatusFilter);
    } else {
        items = await window.api.getAllMedia();
    }

    // Apply the media type chip filter
    if (currentTypeFilter !== 'all') {
        items = items.filter(item => item.type === currentTypeFilter);
    }

    // Apply multi-genre filter (AND = entry must have every selected genre; OR = any)
    if (genreFilterSet.size > 0) {
        items = items.filter((item: any) => {
            const tags: string[] = item.tags ?? [];
            return genreFilterMode === 'and'
                ? [...genreFilterSet].every(g => tags.includes(g))
                : [...genreFilterSet].some(g  => tags.includes(g));
        });
    }

    // Sort according to the current mode
    items.sort((a, b) => {
        if (currentSort === 'rating-high' || currentSort === 'rating-low') {
            // Unrated entries (null/0) always go to the bottom regardless of direction
            const rA = a.rating ?? 0;
            const rB = b.rating ?? 0;
            if (rA === 0 && rB === 0) return a.title.localeCompare(b.title);  // tie-break by title
            if (rA === 0) return 1;   // a is unrated → push to bottom
            if (rB === 0) return -1;  // b is unrated → push to bottom
            const cmp = rB - rA;  // descending by default (high → low)
            return currentSort === 'rating-high' ? cmp : -cmp;
        }
        // Alphabetical sorts
        const cmp = a.title.localeCompare(b.title);
        return currentSort === 'az' ? cmp : -cmp;
    });

    renderMediaGrid(items);
}

// Refreshes the genre filter dropdown list in the header with the latest tags from the DB.
// Called at startup and whenever entries are saved/deleted (genres can appear/disappear).
async function loadGenres(): Promise<void> {
    const tags = await window.api.getAllTags();
    const list = document.getElementById('genre-filter-list')!;
    list.innerHTML = '';

    tags.forEach((tag: { id: number; name: string; count: number }) => {
        const li = document.createElement('li');
        li.className = 'genre-filter-item';
        if (genreFilterSet.has(tag.name)) li.classList.add('active');
        li.textContent = tag.name;

        li.addEventListener('click', () => {
            if (genreFilterSet.has(tag.name)) {
                genreFilterSet.delete(tag.name);
                li.classList.remove('active');
            } else {
                genreFilterSet.add(tag.name);
                li.classList.add('active');
            }
            updateGenreFilterBtn();
            loadMedia();
        });

        list.appendChild(li);
    });
}

// Updates the genre filter button label to show how many genres are selected and in which mode.
function updateGenreFilterBtn(): void {
    const btn = document.getElementById('genre-filter-btn')!;
    if (genreFilterSet.size === 0) {
        btn.textContent = 'Genres';
        btn.classList.remove('active');
    } else {
        const modeLabel = genreFilterMode === 'and' ? 'AND' : 'OR';
        btn.textContent = `Genres (${genreFilterSet.size} · ${modeLabel})`;
        btn.classList.add('active');
    }
}

// Wires up the genre filter button and dropdown (AND/OR toggle, close-on-outside-click).
// Called once at startup from setupEventListeners().
function initGenreFilter(): void {
    const btn      = document.getElementById('genre-filter-btn')!;
    const dropdown = document.getElementById('genre-filter-dropdown')!;

    // Toggle dropdown open/closed
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        dropdown.classList.toggle('hidden');
    });

    // AND / OR mode buttons
    dropdown.querySelectorAll('.genre-mode-btn').forEach(modeBtn => {
        modeBtn.addEventListener('click', () => {
            genreFilterMode = (modeBtn as HTMLElement).dataset.mode as 'and' | 'or';
            dropdown.querySelectorAll('.genre-mode-btn').forEach(b =>
                b.classList.toggle('active', b === modeBtn)
            );
            updateGenreFilterBtn();
            if (genreFilterSet.size > 0) loadMedia();
        });
    });

    // Clear button — deselects all genres and reloads
    document.getElementById('genre-filter-clear')!.addEventListener('click', () => {
        genreFilterSet.clear();
        dropdown.querySelectorAll('.genre-filter-item').forEach(el => el.classList.remove('active'));
        updateGenreFilterBtn();
        loadMedia();
    });

    // Close dropdown when clicking anywhere outside it
    document.addEventListener('click', (e) => {
        if (!dropdown.contains(e.target as Node) && e.target !== btn) {
            dropdown.classList.add('hidden');
        }
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

        // Stars are included directly in the template so they're always in the DOM.
        // Using data-star attributes so the click handlers below can read the value.
        let liveRating: number | null = item.rating ?? null;
        const starsHtml = Array.from({ length: 5 }, (_, i) =>
            `<button class="card-star${liveRating && i < liveRating ? ' filled' : ''}" data-star="${i + 1}" type="button">★</button>`
        ).join('');

        const extraInfo = formatExtraField(item.fields, item.type);
        card.innerHTML = `
            <div class="card-type-badge">${item.type}</div>
            <h3 class="card-title">${escapeHtml(item.title)}</h3>
            <div class="card-status-row">
                <div class="card-status status-${item.status}">${formatStatus(item.status)}</div>
                ${item.fields?.year ? `<span class="card-extra">${item.fields.year}</span>` : ''}
                ${extraInfo ? `<span class="card-extra">${extraInfo}</span>` : ''}
            </div>
            <div class="card-rating">${starsHtml}</div>
            <div class="card-tags">
                ${(item.tags ?? []).map((t: string) => `<span class="tag">${escapeHtml(t)}</span>`).join('')}
            </div>
            <div class="card-actions">
                <button class="edit-btn" title="Edit">✎</button>
                <button class="delete-btn" title="Remove">✕</button>
            </div>
        `;

        // Wire up star hover and click now that they're in the DOM
        const cardStarEls = Array.from(card.querySelectorAll('.card-star')) as HTMLButtonElement[];
        const refreshCardStars = (threshold: number) =>
            cardStarEls.forEach((s, si) => s.classList.toggle('filled', si < threshold));
        cardStarEls.forEach((btn, i) => {
            btn.addEventListener('mouseenter', () => refreshCardStars(i + 1));
            btn.addEventListener('mouseleave', () => refreshCardStars(liveRating ?? 0));
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const newVal = liveRating === (i + 1) ? null : (i + 1);
                liveRating = newVal;
                await window.api.updateRating(item.id, newVal);
                refreshCardStars(liveRating ?? 0);
            });
        });

        // If the entry has a cover image (from Jikan), insert it at the top of the card.
        // We use DOM methods instead of innerHTML to set img.src safely without XSS risk.
        if (item.fields?.image_url) {
            const coverDiv = document.createElement('div');
            coverDiv.className = 'card-cover';
            const img = document.createElement('img');
            img.src = item.fields.image_url;
            img.alt = '';
            img.setAttribute('loading', 'lazy');  // only fetch when scrolled into view
            coverDiv.appendChild(img);
            card.insertBefore(coverDiv, card.firstChild);
        }

        // Clicking anywhere on the card (except the action buttons) opens the detail view.
        // The edit/delete buttons call e.stopPropagation() so they don't bubble here.
        card.addEventListener('click', () => openDetailModal(item));

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

    // Sort toggle: cycles az → za → rating-high → rating-low → az
    const sortBtn = document.getElementById('sort-btn')!;
    const sortCycle: typeof currentSort[] = ['az', 'za', 'rating-high', 'rating-low'];
    const sortLabels: Record<typeof currentSort, string> = {
        'az':          'A → Z',
        'za':          'Z → A',
        'rating-high': '★ High → Low',
        'rating-low':  '★ Low → High',
    };
    sortBtn.addEventListener('click', async () => {
        const next = (sortCycle.indexOf(currentSort) + 1) % sortCycle.length;
        currentSort = sortCycle[next];
        sortBtn.textContent = sortLabels[currentSort];
        sortBtn.classList.toggle('active', currentSort !== 'az');
        await loadMedia();
    });

    // Genre filter button + dropdown in the content header
    initGenreFilter();

    // Changing status in the modal may show/hide the current-episode input
    (document.getElementById('input-status') as HTMLSelectElement)
        .addEventListener('change', updateCurrentEpisodeVisibility);

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

    // Detail modal: close by clicking the overlay behind it
    document.getElementById('detail-overlay')!.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).id === 'detail-overlay') closeDetailModal();
    });

    // Settings modal
    document.getElementById('settings-btn')!.addEventListener('click', openSettings);
    document.getElementById('settings-cancel')!.addEventListener('click', closeSettings);
    document.getElementById('settings-save')!.addEventListener('click', saveSettings);
    document.getElementById('settings-overlay')!.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).id === 'settings-overlay') closeSettings();
    });

    // Escape key closes whichever modal is currently open
    document.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key !== 'Escape') return;
        if (!modalOverlay.classList.contains('hidden'))                                    closeModal();
        if (!document.getElementById('detail-overlay')!.classList.contains('hidden'))     closeDetailModal();
        if (!document.getElementById('settings-overlay')!.classList.contains('hidden'))   closeSettings();
    });

    // Modal: save the new entry
    modalSaveBtn.addEventListener('click', saveNewEntry);
}

// ─── Detail View ──────────────────────────────────────────────────────────

// Builds and shows the read-only detail modal for a given entry.
// The entire modal interior is built with DOM nodes each time so stale
// content from the previous entry never bleeds through.
function openDetailModal(item: any): void {
    const overlay = document.getElementById('detail-overlay')!;
    const modal   = document.getElementById('detail-modal')!;
    modal.innerHTML = '';

    // ── Optional cover image column (left side) ──
    if (item.fields?.image_url) {
        const coverDiv = document.createElement('div');
        coverDiv.id = 'detail-cover';
        const img = document.createElement('img');
        img.src = item.fields.image_url;  // set via property — not innerHTML — to avoid XSS
        img.alt = '';
        coverDiv.appendChild(img);
        modal.appendChild(coverDiv);
    }

    // ── Content column (right side / full width when no image) ──
    const content = document.createElement('div');
    content.id = 'detail-content';

    // Close button — top-right corner, positioned absolute inside content
    const closeBtn = document.createElement('button');
    closeBtn.id = 'detail-close';
    closeBtn.title = 'Close';
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', closeDetailModal);
    content.appendChild(closeBtn);

    // Title
    const titleEl = document.createElement('h2');
    titleEl.id = 'detail-title';
    titleEl.textContent = item.title;
    content.appendChild(titleEl);

    // Alternate English title — shown for anime/manga when title_english differs from the main title
    const engTitle: string | undefined = item.fields?.title_english;
    if (engTitle && engTitle !== item.title && (item.type === 'anime' || item.type === 'manga')) {
        const altEl = document.createElement('div');
        altEl.id = 'detail-alt-title';
        altEl.textContent = engTitle;
        content.appendChild(altEl);
    }

    // Meta row: type badge, status badge, extra field (eps/pages/vols)
    const meta = document.createElement('div');
    meta.id = 'detail-meta';
    const typeBadge = document.createElement('span');
    typeBadge.className = `detail-badge type-${item.type}`;
    typeBadge.textContent = item.type;
    meta.appendChild(typeBadge);
    const statusBadge = document.createElement('span');
    // Reuse the same card-status CSS classes for consistent color coding
    statusBadge.className = `card-status status-${item.status}`;
    statusBadge.textContent = formatStatus(item.status);
    meta.appendChild(statusBadge);
    const extraInfo = formatExtraField(item.fields, item.type);
    if (extraInfo) {
        const extraSpan = document.createElement('span');
        extraSpan.className = 'detail-extra';
        extraSpan.textContent = extraInfo;
        meta.appendChild(extraSpan);
    }
    if (item.fields?.year) {
        const yearSpan = document.createElement('span');
        yearSpan.className = 'detail-extra';
        yearSpan.textContent = item.fields.year;
        meta.appendChild(yearSpan);
    }
    if (item.rating) {
        const ratingSpan = document.createElement('span');
        ratingSpan.className = 'detail-extra';
        ratingSpan.style.color = '#fdc97c';
        ratingSpan.textContent = '★'.repeat(item.rating) + '☆'.repeat(5 - item.rating);
        meta.appendChild(ratingSpan);
    }
    content.appendChild(meta);

    // Genre/tag chips
    const tags: string[] = item.tags ?? [];
    if (tags.length > 0) {
        const tagsDiv = document.createElement('div');
        tagsDiv.id = 'detail-tags';
        tags.forEach(t => {
            const chip = document.createElement('span');
            chip.className = 'tag';
            chip.textContent = t;
            tagsDiv.appendChild(chip);
        });
        content.appendChild(tagsDiv);
    }

    // Description (from Jikan synopsis, if saved)
    if (item.fields?.description) {
        content.appendChild(buildDetailSection('Description', item.fields.description));
    }

    // Personal notes
    if (item.notes) {
        content.appendChild(buildDetailSection('Notes', item.notes));
    }

    // Date added — pushed to the bottom with margin-top: auto in CSS
    if (item.date_added) {
        const dateStr = new Date(item.date_added).toLocaleDateString('en-US', {
            year: 'numeric', month: 'long', day: 'numeric'
        });
        const dateDiv = document.createElement('div');
        dateDiv.id = 'detail-date';
        dateDiv.textContent = `Added ${dateStr}`;
        content.appendChild(dateDiv);
    }

    modal.appendChild(content);
    overlay.classList.remove('hidden');
}

// Builds a labeled text block (e.g. "DESCRIPTION" heading + paragraph body).
// Uses textContent — never innerHTML — so no XSS risk on user-supplied text.
function buildDetailSection(label: string, text: string): HTMLElement {
    const div = document.createElement('div');
    div.className = 'detail-section';
    const labelEl = document.createElement('div');
    labelEl.className = 'detail-section-label';
    labelEl.textContent = label;
    const textEl = document.createElement('p');
    textEl.className = 'detail-text';
    textEl.textContent = text;
    div.appendChild(labelEl);
    div.appendChild(textEl);
    return div;
}

function closeDetailModal(): void {
    document.getElementById('detail-overlay')!.classList.add('hidden');
}

// ─── Refresh from API ─────────────────────────────────────────────────────

// Re-fetches cover, synopsis, year, genres, and episode/volume count from
// Jikan (anime/manga) or TMDB (movie/show) and updates the stored media_fields.
// User-owned fields (current_episode, notes, rating, status) are never touched.
// Returns true on success, false if no results were found or a key is missing.
// Callers are responsible for toasts, loadMedia/loadGenres, and any UI updates.
async function refreshEntryFromApi(item: any): Promise<boolean> {
    // These are the only fields auto-fill owns — everything else is user data.
    const AUTO_FILL_KEYS = new Set(['image_url', 'description', 'title_english', 'year', 'episodes', 'volumes']);

    const freshFields: Record<string, string> = {};
    const freshGenres: string[] = [];

    if (item.type === 'anime' || item.type === 'manga') {
        // Build a list of distinct queries to try. title_english (when it differs
        // from the stored title) often gives better Jikan results because the main
        // title can be Japanese/romaji. If the first query returns nothing — whether
        // from a rate-limit 429 or a title mismatch — we try the next one.
        const titleEng = item.fields?.title_english as string | undefined;
        const queries: string[] = [];
        if (titleEng && titleEng !== item.title) queries.push(titleEng);
        queries.push(item.title);

        let results: any[] = [];
        for (let i = 0; i < queries.length; i++) {
            if (i > 0) await new Promise<void>(resolve => setTimeout(resolve, 1000));
            results = await window.api.searchJikan(item.type, queries[i]);
            if (results && results.length > 0) break;
        }
        if (!results || results.length === 0) return false;

        // Prefer an exact title match over taking the first result blindly.
        // This guards against a renamed entry accidentally pulling in the wrong data.
        const storedTitles = new Set(
            [item.title, item.fields?.title_english]
                .filter(Boolean)
                .map((t: string) => t.toLowerCase())
        );
        const match = results.find((r: any) =>
            [r.title, r.title_english]
                .filter(Boolean)
                .some((t: string) => storedTitles.has(t.toLowerCase()))
        ) ?? results[0];

        const imgUrl = match.images?.jpg?.large_image_url ?? match.images?.jpg?.image_url;
        if (imgUrl)          freshFields['image_url']     = imgUrl;
        if (match.synopsis)  freshFields['description']   = match.synopsis;
        const eng = match.title_english as string | undefined;
        if (eng && eng !== match.title) freshFields['title_english'] = eng;
        const yr = match.year?.toString()
            ?? match.aired?.from?.slice(0, 4)
            ?? match.published?.from?.slice(0, 4);
        if (yr) freshFields['year'] = yr;
        if (item.type === 'anime' && match.episodes) freshFields['episodes'] = String(match.episodes);
        if (item.type === 'manga' && match.volumes)  freshFields['volumes']  = String(match.volumes);
        (match.genres ?? []).forEach((g: any) => freshGenres.push(g.name as string));

    } else if (item.type === 'movie' || item.type === 'show') {
        const response = await window.api.searchTmdb(item.type, item.title);
        if (response.error) return false;
        const results = response.results ?? [];
        if (results.length === 0) return false;

        const storedTitle = item.title.toLowerCase();
        const match = results.find((r: any) =>
            (r.title ?? r.name ?? '').toLowerCase() === storedTitle
        ) ?? results[0];

        if (match.poster_path) freshFields['image_url']   = `https://image.tmdb.org/t/p/w500${match.poster_path}`;
        if (match.overview)    freshFields['description'] = match.overview;
        const yr = (match.release_date ?? match.first_air_date ?? '').slice(0, 4);
        if (yr) freshFields['year'] = yr;
        if (item.type === 'show') {
            const details = await window.api.getTmdbTvDetails(match.id);
            if (details?.number_of_episodes) freshFields['episodes'] = String(details.number_of_episodes);
        }
        (match.genre_names ?? []).forEach((name: string) => freshGenres.push(name));
    }

    // Merge: carry over user-owned fields (e.g. current_episode), then overlay with fresh API data.
    const mergedFields: Record<string, string> = {};
    for (const [key, val] of Object.entries(item.fields ?? {})) {
        if (!AUTO_FILL_KEYS.has(key)) mergedFields[key] = val as string;
    }
    for (const [key, val] of Object.entries(freshFields)) {
        mergedFields[key] = val;
    }

    await window.api.clearMediaFields(item.id);
    for (const [key, val] of Object.entries(mergedFields)) {
        await window.api.addMediaField(item.id, key, val);
    }

    // Add new genres from the API without clearing the existing set,
    // so any genres the user added manually are preserved.
    // addTagToMedia uses INSERT OR IGNORE, so duplicates are silently skipped.
    for (const genre of freshGenres) {
        await window.api.addTagToMedia(item.id, genre);
    }

    return true;
}

// Refreshes every non-book entry in the library in sequence, silently.
// Called automatically on startup — the library is already visible while this runs.
// Jikan allows ~3 req/s but is sensitive to bursts; 1000ms keeps us well clear.
// TMDB allows 40 req/10s so 350ms is safe there.
async function refreshAllEntries(): Promise<void> {
    const allItems    = await window.api.getAllMedia();
    const refreshable = allItems.filter((item: any) => item.type !== 'book');
    if (refreshable.length === 0) return;

    for (const item of refreshable) {
        await refreshEntryFromApi(item);
        const delay = (item.type === 'anime' || item.type === 'manga') ? 1000 : 350;
        await new Promise<void>(resolve => setTimeout(resolve, delay));
    }

    await loadMedia();
    await loadGenres();
    showToast('Metadata refresh complete.');
}

// ─── Jikan API Search ─────────────────────────────────────────────────────

// Wires the Search button and Enter key in the Jikan search row.
// Called once at startup — no data-wired flag needed since it's not called repeatedly.
function initJikanSearch(): void {
    document.getElementById('jikan-search-btn')!.addEventListener('click', runJikanSearch);

    const queryInput = document.getElementById('jikan-query') as HTMLInputElement;
    queryInput.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key === 'Enter') runJikanSearch();
    });
}

async function runJikanSearch(): Promise<void> {
    const typeSelect = document.getElementById('input-type')  as HTMLSelectElement;
    const queryInput = document.getElementById('jikan-query') as HTMLInputElement;
    const searchBtn  = document.getElementById('jikan-search-btn') as HTMLButtonElement;

    const query = queryInput.value.trim();
    if (!query) return;

    // Show a loading state while waiting for the API response
    searchBtn.textContent = '...';
    searchBtn.disabled = true;

    const [results, existingEntries] = await Promise.all([
        window.api.searchJikan(typeSelect.value, query),
        window.api.getAllMedia(),
    ]);

    searchBtn.textContent = 'Search';
    searchBtn.disabled = false;

    renderJikanResults(results, typeSelect.value, existingEntries);
}

// Returns true if a search result already exists in the library for that type.
// Checks both the main title and the stored title_english field.
// When both the result and an existing entry have a year, they must also match —
// this allows two entries with the same name but different release years (e.g. remakes).
function isAlreadyAdded(result: any, mediaType: string, existingEntries: any[]): boolean {
    const sameType = existingEntries.filter(e => e.type === mediaType);

    // Pull year out of the API result (Jikan and TMDB store it differently)
    const resultYear: string | null =
        result.year?.toString()
        ?? result.aired?.from?.slice(0, 4)
        ?? result.published?.from?.slice(0, 4)
        ?? result.release_date?.slice(0, 4)
        ?? result.first_air_date?.slice(0, 4)
        ?? null;

    const resultTitles = new Set(
        [result.title, result.title_english, result.name]
            .filter(Boolean)
            .map((t: string) => t.toLowerCase())
    );

    return sameType.some(entry => {
        // Title must match (main title or stored English title)
        const titleMatches =
            resultTitles.has(entry.title.toLowerCase()) ||
            (entry.fields?.title_english && resultTitles.has(entry.fields.title_english.toLowerCase()));

        if (!titleMatches) return false;

        // If both sides have a year and they differ, this is a different work (remake/reboot)
        const entryYear: string | null = entry.fields?.year ?? null;
        if (resultYear && entryYear && resultYear !== entryYear) return false;

        return true;
    });
}

// Builds the clickable results list from the array Jikan returned.
function renderJikanResults(results: any[], mediaType: string, existingEntries: any[]): void {
    const resultsList = document.getElementById('jikan-results')!;
    resultsList.innerHTML = '';

    if (results.length === 0) {
        const li = document.createElement('li');
        li.style.cssText = 'padding: 10px 12px; color: var(--text-secondary); font-size: 0.82rem;';
        li.textContent = 'No results found.';
        resultsList.appendChild(li);
        resultsList.classList.remove('hidden');
        return;
    }

    results.forEach((r: any) => {
        const li = document.createElement('li');
        li.className = 'jikan-result';

        // Build the "2023 • 12 eps • Action, Adventure" meta line
        const metaParts: string[] = [];
        // Jikan provides r.year directly for anime; fall back to parsing aired/published dates
        const jikanYear = r.year?.toString()
            ?? r.aired?.from?.slice(0, 4)
            ?? r.published?.from?.slice(0, 4);
        if (jikanYear) metaParts.push(jikanYear);
        if (mediaType === 'anime' && r.episodes) metaParts.push(`${r.episodes} eps`);
        if (mediaType === 'manga' && r.volumes)  metaParts.push(`${r.volumes} vols`);
        const genreText = (r.genres ?? []).slice(0, 3).map((g: any) => g.name).join(', ');
        if (genreText) metaParts.push(genreText);

        // Build DOM nodes instead of innerHTML so image src is set safely via property
        const img = document.createElement('img');
        const added = isAlreadyAdded(r, mediaType, existingEntries);

        img.className = 'jikan-thumb';
        img.src = r.images?.jpg?.image_url ?? '';  // small thumbnail is fine for the results list
        img.alt = '';

        const infoDiv  = document.createElement('div');
        infoDiv.className = 'jikan-info';

        const titleDiv = document.createElement('div');
        titleDiv.className = 'jikan-title';
        titleDiv.textContent = r.title ?? '';

        const metaDiv  = document.createElement('div');
        metaDiv.className = 'jikan-meta';
        metaDiv.textContent = metaParts.join(' • ');

        infoDiv.appendChild(titleDiv);
        infoDiv.appendChild(metaDiv);

        if (added) {
            const badge = document.createElement('span');
            badge.className = 'result-added-badge';
            badge.textContent = '✓ In library';
            infoDiv.appendChild(badge);
        }

        li.appendChild(img);
        li.appendChild(infoDiv);

        li.addEventListener('click', () => fillFromJikan(r, mediaType));
        resultsList.appendChild(li);
    });

    resultsList.classList.remove('hidden');
}

// Auto-fills the form when the user picks a result.
function fillFromJikan(result: any, mediaType: string): void {
    (document.getElementById('input-title') as HTMLInputElement).value = result.title ?? '';
    currentDescription = result.synopsis ?? null;

    if ((mediaType === 'anime' || mediaType === 'show') && result.episodes) {
        (document.getElementById('input-episodes') as HTMLInputElement).value = String(result.episodes);
    }
    if (mediaType === 'manga' && result.volumes) {
        (document.getElementById('input-volumes') as HTMLInputElement).value = String(result.volumes);
    }

    // Add all genres from the result to the selected set
    (result.genres ?? []).forEach((g: any) => {
        const name = g.name as string;
        if (!allGenres.includes(name)) {
            allGenres.push(name);
            allGenres.sort();
        }
        selectedGenres.add(name);
    });
    renderSelectedChips();

    currentImageUrl = result.images?.jpg?.large_image_url ?? result.images?.jpg?.image_url ?? null;
    updateModalCoverPreview(currentImageUrl);

    currentYear = result.year?.toString()
        ?? result.aired?.from?.slice(0, 4)
        ?? result.published?.from?.slice(0, 4)
        ?? null;

    // Store the English title only when it differs from the main title (which is often romaji/Japanese).
    // This lets the sidebar search find the entry by either name.
    const eng = result.title_english as string | undefined;
    currentTitleEnglish = (eng && eng !== result.title) ? eng : null;

    // Clear the Jikan search UI — the fields are already filled in
    document.getElementById('jikan-results')!.classList.add('hidden');
    (document.getElementById('jikan-query') as HTMLInputElement).value = '';
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
        showToast('Please enter a title.');
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
        const updateResult = await window.api.updateMedia(editingEntryId, title, type, status, currentRating, notes);
        if ((updateResult as any)?.error) {
            showToast((updateResult as any).error);
            return;
        }

        // Wipe old genres and re-add the current selection
        await window.api.clearMediaTags(editingEntryId);
        for (const genre of selectedGenres) {
            await window.api.addTagToMedia(editingEntryId, genre);
        }

        // Wipe old extra fields and re-add (includes image_url and description if present)
        await window.api.clearMediaFields(editingEntryId);
        if (currentImageUrl)     await window.api.addMediaField(editingEntryId, 'image_url',    currentImageUrl);
        if (currentDescription)  await window.api.addMediaField(editingEntryId, 'description',  currentDescription);
        if (currentTitleEnglish) await window.api.addMediaField(editingEntryId, 'title_english', currentTitleEnglish);
        if (currentYear)         await window.api.addMediaField(editingEntryId, 'year',          currentYear);
        const extraDef = extraFieldMap[type];
        if (extraDef) {
            const extraInput = document.getElementById(extraDef.inputId) as HTMLInputElement;
            if (extraInput.value.trim()) {
                await window.api.addMediaField(editingEntryId, extraDef.fieldName, extraInput.value.trim());
            }
        }
        if ((type === 'anime' || type === 'show') && (status === 'in_progress' || status === 'dropped')) {
            const curEp = (document.getElementById('input-current-episode') as HTMLInputElement).value.trim();
            if (curEp) await window.api.addMediaField(editingEntryId, 'current_episode', curEp);
        }
    } else {
        // ── Add mode: duplicate guard before inserting ──
        // Same title + same type + same year (or no year on either side) = true duplicate.
        // Same title + same type but different years = remake/reboot, allow it.
        const allEntries = await window.api.getAllMedia();
        const conflict = allEntries.find((e: any) => {
            if (e.type !== type) return false;
            if (e.title.toLowerCase() !== title.toLowerCase()) return false;
            const existingYear: string | null = e.fields?.year ?? null;
            // If both sides have a year and they differ, it's a different work — not a duplicate
            if (currentYear && existingYear && currentYear !== existingYear) return false;
            return true;
        });
        if (conflict) {
            const yearLabel = conflict.fields?.year ? ` (${conflict.fields.year})` : '';
            showToast(`"${title}"${yearLabel} is already in your library as a ${type}.`);
            return;
        }

        // ── Add mode: insert a new row ──
        const entry = await window.api.addMedia(title, type, status, currentRating, notes);
        if ((entry as any)?.error) {
            showToast((entry as any).error);
            return;
        }

        for (const genre of selectedGenres) {
            await window.api.addTagToMedia(entry.id, genre);
        }

        if (currentImageUrl)     await window.api.addMediaField(entry.id, 'image_url',    currentImageUrl);
        if (currentDescription)  await window.api.addMediaField(entry.id, 'description',  currentDescription);
        if (currentTitleEnglish) await window.api.addMediaField(entry.id, 'title_english', currentTitleEnglish);
        if (currentYear)         await window.api.addMediaField(entry.id, 'year',          currentYear);
        const extraDef = extraFieldMap[type];
        if (extraDef) {
            const extraInput = document.getElementById(extraDef.inputId) as HTMLInputElement;
            if (extraInput.value.trim()) {
                await window.api.addMediaField(entry.id, extraDef.fieldName, extraInput.value.trim());
            }
        }
        if ((type === 'anime' || type === 'show') && status === 'in_progress') {
            const curEp = (document.getElementById('input-current-episode') as HTMLInputElement).value.trim();
            if (curEp) await window.api.addMediaField(entry.id, 'current_episode', curEp);
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
    currentRating = null;
    currentImageUrl = null;
    currentTitleEnglish = null;
    currentYear = null;
    currentDescription = null;
    renderStars(0);
    updateModalCoverPreview(null);
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
    // Reset extra fields and hide current-episode wrapper
    document.querySelectorAll('.extra-field input').forEach(el => {
        (el as HTMLInputElement).value = '';
    });
    document.getElementById('current-episode-wrapper')!.classList.add('hidden');
    // Reset Jikan search UI
    (document.getElementById('jikan-query') as HTMLInputElement).value = '';
    const jikanResults = document.getElementById('jikan-results')!;
    jikanResults.classList.add('hidden');
    jikanResults.innerHTML = '';

    // Reset TMDB search UI
    (document.getElementById('tmdb-query') as HTMLInputElement).value = '';
    const tmdbResults = document.getElementById('tmdb-results')!;
    tmdbResults.classList.add('hidden');
    tmdbResults.innerHTML = '';
}

// Opens the modal pre-filled with an existing entry's data for editing.
async function openEditModal(item: any): Promise<void> {
    editingEntryId = item.id;
    currentRating       = item.rating ?? null;
    currentImageUrl     = item.fields?.image_url     ?? null;
    currentTitleEnglish = item.fields?.title_english ?? null;
    currentYear         = item.fields?.year          ?? null;
    currentDescription  = item.fields?.description   ?? null;
    renderStars(currentRating ?? 0);
    updateModalCoverPreview(currentImageUrl);

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
    // updateCurrentEpisodeVisibility needs type+status set first, then we pre-fill the value
    updateCurrentEpisodeVisibility();
    if ((item.type === 'anime' || item.type === 'show') && item.fields?.current_episode) {
        // Pre-fill for both in_progress and dropped (visibility already set above)
        (document.getElementById('input-current-episode') as HTMLInputElement).value = item.fields.current_episode;
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
// Also shows the Jikan search section for anime and manga only.
function updateExtraFields(type: string): void {
    document.querySelectorAll('.extra-field').forEach(el => {
        (el as HTMLElement).classList.add('hidden');
        // Clear ALL inputs inside the field, not just the first (episodes has two)
        el.querySelectorAll('input').forEach(i => (i as HTMLInputElement).value = '');
    });

    const fieldId = EXTRA_FIELD_MAP[type];
    if (fieldId) {
        document.getElementById(fieldId)?.classList.remove('hidden');
    }

    // Jikan covers anime and manga; TMDB covers movies and shows
    const jikanSection = document.getElementById('jikan-section')!;
    const tmdbSection  = document.getElementById('tmdb-section')!;

    jikanSection.classList.toggle('hidden', type !== 'anime' && type !== 'manga');
    tmdbSection.classList.toggle('hidden',  type !== 'movie' && type !== 'show');

    // Clear TMDB results if the section just got hidden
    if (type !== 'movie' && type !== 'show') {
        document.getElementById('tmdb-results')!.classList.add('hidden');
        (document.getElementById('tmdb-query') as HTMLInputElement).value = '';
    }

    // Re-evaluate current-episode visibility since type may have changed
    updateCurrentEpisodeVisibility();
}

// Shows the current-episode input when the entry type is anime/show AND status is in_progress or dropped.
function updateCurrentEpisodeVisibility(): void {
    const type   = (document.getElementById('input-type')   as HTMLSelectElement).value;
    const status = (document.getElementById('input-status') as HTMLSelectElement).value;
    const wrapper = document.getElementById('current-episode-wrapper')!;

    const show = (type === 'anime' || type === 'show') && (status === 'in_progress' || status === 'dropped');
    wrapper.classList.toggle('hidden', !show);

    // Clear the value when hidden so it isn't accidentally saved
    if (!show) {
        (document.getElementById('input-current-episode') as HTMLInputElement).value = '';
    }
}

// Formats the extra field for display on a card or detail view.
// Shows episode progress as "Ep 5 / 26" when both values are present.
function formatExtraField(fields: Record<string, string> | undefined, type: string): string {
    if (!fields) return '';
    if (type === 'anime' || type === 'show') {
        const cur   = fields.current_episode;
        const total = fields.episodes;
        if (cur && total) return `Ep ${cur} / ${total}`;
        if (cur)          return `Ep ${cur}`;
        if (total)        return `${total} eps`;
        return '';
    }
    if (type === 'book'  && fields.pages)   return `${fields.pages} pages`;
    if (type === 'manga' && fields.volumes) return `${fields.volumes} vols`;
    return '';
}

// ─── Star Rating (modal picker) ───────────────────────────────────────────

function initStarRating(): void {
    const stars = document.querySelectorAll('#star-rating .star');

    stars.forEach((star, index) => {
        const value = index + 1;

        // Hovering previews the rating up to this star
        star.addEventListener('mouseenter', () => renderStars(value));
        // Leaving restores the actual saved rating
        star.addEventListener('mouseleave', () => renderStars(currentRating ?? 0));

        star.addEventListener('click', () => {
            // Clicking the already-selected star clears the rating
            currentRating = currentRating === value ? null : value;
            renderStars(currentRating ?? 0);
        });
    });
}

// Fills stars up to `filledUpTo` and empties the rest.
// Pass 0 to show all stars empty (no rating).
function renderStars(filledUpTo: number): void {
    document.querySelectorAll('#star-rating .star').forEach((star, index) => {
        star.classList.toggle('filled', index < filledUpTo);
    });
}

// ─── Settings Modal ───────────────────────────────────────────────────────

async function openSettings(): Promise<void> {
    const overlay = document.getElementById('settings-overlay')!;
    const input   = document.getElementById('tmdb-key-input') as HTMLInputElement;
    // Pre-fill with whatever key is already saved
    const saved = await window.api.getApiKey('tmdb_api_key');
    input.value = saved ?? '';
    overlay.classList.remove('hidden');
    input.focus();
}

function closeSettings(): void {
    document.getElementById('settings-overlay')!.classList.add('hidden');
}

async function saveSettings(): Promise<void> {
    const input = document.getElementById('tmdb-key-input') as HTMLInputElement;
    await window.api.setApiKey('tmdb_api_key', input.value.trim());
    closeSettings();
}

// ─── TMDB Search ──────────────────────────────────────────────────────────

function initTmdbSearch(): void {
    document.getElementById('tmdb-search-btn')!.addEventListener('click', runTmdbSearch);

    const queryInput = document.getElementById('tmdb-query') as HTMLInputElement;
    queryInput.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key === 'Enter') runTmdbSearch();
    });
}

async function runTmdbSearch(): Promise<void> {
    const typeSelect = document.getElementById('input-type')  as HTMLSelectElement;
    const queryInput = document.getElementById('tmdb-query')  as HTMLInputElement;
    const searchBtn  = document.getElementById('tmdb-search-btn') as HTMLButtonElement;
    const resultsList = document.getElementById('tmdb-results')!;

    const query = queryInput.value.trim();
    if (!query) return;

    searchBtn.textContent = '...';
    searchBtn.disabled = true;

    const [response, existingEntries] = await Promise.all([
        window.api.searchTmdb(typeSelect.value, query),
        window.api.getAllMedia(),
    ]);

    searchBtn.textContent = 'Search';
    searchBtn.disabled = false;

    // Handle error states
    if (response.error === 'no_key') {
        resultsList.innerHTML = '';
        const li = document.createElement('li');
        li.style.cssText = 'padding: 10px 12px; font-size: 0.82rem; color: var(--text-secondary);';
        li.textContent = 'Add your TMDB API key in Settings to use this feature.';
        resultsList.appendChild(li);
        resultsList.classList.remove('hidden');
        return;
    }
    if (response.error === 'invalid_key') {
        resultsList.innerHTML = '';
        const li = document.createElement('li');
        li.style.cssText = 'padding: 10px 12px; font-size: 0.82rem; color: var(--accent);';
        li.textContent = 'Invalid API key — check Settings.';
        resultsList.appendChild(li);
        resultsList.classList.remove('hidden');
        return;
    }

    renderTmdbResults(response.results ?? [], typeSelect.value, existingEntries);
}

function renderTmdbResults(results: any[], mediaType: string, existingEntries: any[]): void {
    const resultsList = document.getElementById('tmdb-results')!;
    resultsList.innerHTML = '';

    if (results.length === 0) {
        const li = document.createElement('li');
        li.style.cssText = 'padding: 10px 12px; color: var(--text-secondary); font-size: 0.82rem;';
        li.textContent = 'No results found.';
        resultsList.appendChild(li);
        resultsList.classList.remove('hidden');
        return;
    }

    results.forEach((r: any) => {
        const li = document.createElement('li');
        li.className = 'jikan-result';  // reuse Jikan result row styles

        // TMDB uses 'title' for movies, 'name' for TV shows
        const title   = mediaType === 'show' ? r.name    : r.title;
        const dateStr = mediaType === 'show' ? r.first_air_date : r.release_date;
        const year    = (dateStr ?? '').slice(0, 4);
        const genres  = (r.genre_names ?? []).slice(0, 3).join(', ');
        const meta    = [year, genres].filter(Boolean).join(' • ');

        const img = document.createElement('img');
        img.className = 'jikan-thumb';
        // w92 is a small TMDB poster size — perfect for the results list thumbnail
        img.src = r.poster_path ? `https://image.tmdb.org/t/p/w92${r.poster_path}` : '';
        img.alt = '';

        const infoDiv  = document.createElement('div');
        infoDiv.className = 'jikan-info';

        const titleDiv = document.createElement('div');
        titleDiv.className = 'jikan-title';
        titleDiv.textContent = title ?? '';

        const metaDiv  = document.createElement('div');
        metaDiv.className = 'jikan-meta';
        metaDiv.textContent = meta;

        infoDiv.appendChild(titleDiv);
        infoDiv.appendChild(metaDiv);

        if (isAlreadyAdded(r, mediaType, existingEntries)) {
            const badge = document.createElement('span');
            badge.className = 'result-added-badge';
            badge.textContent = '✓ In library';
            infoDiv.appendChild(badge);
        }

        li.appendChild(img);
        li.appendChild(infoDiv);

        li.addEventListener('click', () => { void fillFromTmdb(r, mediaType); });
        resultsList.appendChild(li);
    });

    resultsList.classList.remove('hidden');
}

async function fillFromTmdb(result: any, mediaType: string): Promise<void> {
    const title = mediaType === 'show' ? result.name : result.title;

    (document.getElementById('input-title') as HTMLInputElement).value = title ?? '';
    currentDescription = result.overview ?? null;

    // For shows, fetch full details to get total episode count (not in search results)
    if (mediaType === 'show') {
        const details = await window.api.getTmdbTvDetails(result.id);
        if (details?.number_of_episodes) {
            (document.getElementById('input-episodes') as HTMLInputElement).value = String(details.number_of_episodes);
        }
    }

    // Add genres from the result
    (result.genre_names ?? []).forEach((name: string) => {
        if (!allGenres.includes(name)) {
            allGenres.push(name);
            allGenres.sort();
        }
        selectedGenres.add(name);
    });
    renderSelectedChips();

    // w500 gives a sharp poster without being unnecessarily large
    currentImageUrl     = result.poster_path ? `https://image.tmdb.org/t/p/w500${result.poster_path}` : null;
    currentTitleEnglish = null;  // TMDB results are already in English
    updateModalCoverPreview(currentImageUrl);

    const dateStr   = mediaType === 'show' ? result.first_air_date : result.release_date;
    currentYear = dateStr ? (dateStr as string).slice(0, 4) : null;

    document.getElementById('tmdb-results')!.classList.add('hidden');
    (document.getElementById('tmdb-query') as HTMLInputElement).value = '';
}

// ─── Tab Switching ────────────────────────────────────────────────────────

function switchTab(tab: string): void {
    currentTab = tab;

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
        mylist: 'My List'
    };
    contentTitle.textContent = titles[tab] ?? tab;

    loadMedia();
}

// ─── Modal Cover Preview ──────────────────────────────────────────────────

// Shows or hides the cover image panel that appears beside the add/edit modal.
function updateModalCoverPreview(url: string | null): void {
    const preview = document.getElementById('modal-cover-preview')!;
    const img     = document.getElementById('modal-cover-img') as HTMLImageElement;
    if (url) {
        img.src = url;
        preview.classList.remove('hidden');
    } else {
        preview.classList.add('hidden');
        img.src = '';
    }
}

// ─── Toast Notifications ──────────────────────────────────────────────────

// Shows a notification in the bottom-right corner.
// Stays visible until the user clicks the × button to dismiss it.
function showToast(message: string): void {
    const container = document.getElementById('toast-container')!;
    const toast = document.createElement('div');
    toast.className = 'toast';

    const text = document.createElement('span');
    text.textContent = message;
    toast.appendChild(text);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'toast-close';
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', () => {
        toast.classList.remove('visible');
        toast.addEventListener('transitionend', () => toast.remove(), { once: true });
    });
    toast.appendChild(closeBtn);

    container.appendChild(toast);

    // Force a reflow so the transition plays from the initial opacity:0 state
    toast.getBoundingClientRect();
    toast.classList.add('visible');
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
        planning:    'Plan to Watch',
        in_progress: 'In Progress',
        completed:   'Completed',
        rewatch:     'Rewatch',
        dropped:     'Dropped',
        on_hold:     'On Hold',
        all:         'All'
    };
    return labels[status] ?? status;
}
