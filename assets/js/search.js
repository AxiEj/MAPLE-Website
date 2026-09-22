(function () {
  'use strict';

  var script = document.currentScript;
  if (!script) return;
  var siteRoot = new URL('../../', script.src);
  var indexUrl = new URL('assets/search-index.json', siteRoot);
  var scriptIndexUrl = new URL('assets/search-index.js', siteRoot);
  var indexPromise = null;
  var scriptIndexPromise = null;
  var indexReady = false;

  var MATCH_TIER = Object.freeze({
    NONE: 0,
    CROSS_FIELD: 1,
    BODY: 2,
    TRAIL: 3,
    STEM: 4,
    TITLE: 5,
    HEADING: 6,
    PHRASE: 7,
    EXACT: 8,
  });
  var RESULT_LIMIT = 8;
  var PER_PAGE_LIMIT = 4;
  var MIN_PREFIX_LENGTH = 3;
  var MIN_STEM_LENGTH = 4;
  var QUERY_DEBOUNCE_MS = 120;
  var MIN_QUERY_LENGTH = 2;

  /* ----- Text analysis ----- */

  function normalize(value) {
    return String(value || '').normalize('NFKD').toLowerCase();
  }

  function splitTerms(normalizedValue) {
    return normalizedValue.match(/[a-z0-9]+(?:[._/+:-][a-z0-9]+)*/g) || [];
  }

  // Compound tokens stay searchable both whole and in parts: `model.uma` also
  // matches `model` and `uma`.
  function expandTokens(compounds) {
    var tokens = new Set();
    compounds.forEach(function (compound) {
      tokens.add(compound);
      compound.split(/[._/+:-]+/).forEach(function (part) {
        if (part) tokens.add(part);
      });
    });
    return Array.from(tokens);
  }

  function stemToken(token) {
    var suffixes = ['ation', 'ment', 'ing', 'ent', 'ers', 'er', 'ed', 'es', 's'];
    for (var i = 0; i < suffixes.length; i += 1) {
      var suffix = suffixes[i];
      if (token.endsWith(suffix) && token.length - suffix.length >= 4) {
        token = token.slice(0, -suffix.length);
        break;
      }
    }
    if (token.endsWith('e') && token.length > 5) token = token.slice(0, -1);
    return token;
  }

  function escapePattern(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function boundaryPattern(value, trailing) {
    return new RegExp('(^|[^a-z0-9])' + escapePattern(value) + (trailing || '(?=$|[^a-z0-9])'));
  }

  // A query term carries everything matching needs, derived once: its stem and
  // its position patterns. The per-document loop then only compares.
  function compileTerm(text) {
    var prefixable = text.length >= MIN_PREFIX_LENGTH;
    return {
      text: text,
      stem: text.length >= MIN_STEM_LENGTH ? stemToken(text) : null,
      prefixable: prefixable,
      exactPattern: boundaryPattern(text),
      prefixPattern: prefixable ? boundaryPattern(text, '[a-z0-9]*') : null,
    };
  }

  function fieldMatchesTerm(field, term) {
    if (field.tokenSet.has(term.text)) return true;
    if (term.prefixable && field.tokens.some(function (candidate) {
      return candidate.startsWith(term.text);
    })) return true;
    return term.stem !== null && field.stems.has(term.stem);
  }

  function matchesAnyTerm(terms, candidate) {
    return terms.some(function (term) {
      if (term.text === candidate) return true;
      if (term.prefixable && candidate.startsWith(term.text)) return true;
      return term.stem !== null && term.stem === stemToken(candidate);
    });
  }

  /* ----- Prepared index -----
     Normalizing and tokenizing is done once per document at load time instead
     of once per document per keystroke, which keeps ranking allocation-free
     enough to stay well inside a frame while typing. */

  function analyzeField(rawValue) {
    var value = normalize(rawValue);
    var tokens = expandTokens(splitTerms(value));
    return {
      value: value,
      tokens: tokens,
      tokenSet: new Set(tokens),
      stems: new Set(tokens.map(stemToken)),
    };
  }

  function prepareEntry(record) {
    var trail = record.trail || [];
    var displayText = String(record.text || '').replace(/\s+/g, ' ').trim();
    var entry = {
      record: record,
      page: record.page || record.url.split('#')[0],
      title: analyzeField(record.title),
      heading: analyzeField(record.heading),
      text: analyzeField(record.text),
      trail: analyzeField(trail.join(' ')),
      pageLabel: analyzeField(trail.length ? trail[trail.length - 1] : record.title),
      // Snippet offsets are taken in this string's own index space; NFKD would
      // shift them whenever the text carries composed characters.
      displayText: displayText,
      displayLower: displayText.toLowerCase(),
    };
    entry.fields = [entry.title, entry.heading, entry.text, entry.trail, entry.pageLabel];
    return entry;
  }

  function buildIndex(payload) {
    if (!payload || payload.version !== 2 || !Array.isArray(payload.documents)) {
      throw new Error('Unsupported search index schema');
    }
    var entries = payload.documents.map(prepareEntry);
    var pageEntries = new Map();
    entries.forEach(function (entry) {
      if (entry.record.page_entry && !pageEntries.has(entry.page)) {
        pageEntries.set(entry.page, entry);
      }
    });
    indexReady = true;
    return { entries: entries, pageEntries: pageEntries };
  }

  /* ----- Index loading ----- */

  function loadScriptIndex() {
    if (window.MAPLE_SEARCH_INDEX) {
      return Promise.resolve().then(function () {
        return buildIndex(window.MAPLE_SEARCH_INDEX);
      });
    }
    if (!scriptIndexPromise) {
      scriptIndexPromise = new Promise(function (resolve, reject) {
        var indexScript = document.createElement('script');
        indexScript.src = scriptIndexUrl.href;
        indexScript.async = true;
        indexScript.onload = function () {
          if (!window.MAPLE_SEARCH_INDEX) {
            reject(new Error('Script search index did not initialize'));
            return;
          }
          try {
            resolve(buildIndex(window.MAPLE_SEARCH_INDEX));
          } catch (error) {
            reject(error);
          }
        };
        indexScript.onerror = function () {
          reject(new Error('Script search index request failed'));
        };
        document.head.appendChild(indexScript);
      }).catch(function (error) {
        scriptIndexPromise = null;
        throw error;
      });
    }
    return scriptIndexPromise;
  }

  function loadIndex() {
    if (window.MAPLE_SEARCH_INDEX) {
      return Promise.resolve().then(function () {
        return buildIndex(window.MAPLE_SEARCH_INDEX);
      });
    }
    if (!indexPromise) {
      var primary = window.location.protocol === 'file:'
        ? loadScriptIndex()
        : fetch(indexUrl).then(function (response) {
          if (!response.ok) throw new Error('Search index request failed');
          return response.json();
        }).then(buildIndex).catch(function () {
          return loadScriptIndex();
        });
      indexPromise = primary.catch(function (error) {
        indexPromise = null;
        throw error;
      });
    }
    return indexPromise;
  }

  /* ----- Ranking ----- */

  function parseQuery(rawQuery) {
    var text = normalize(rawQuery).trim();
    var terms = splitTerms(text);
    return {
      text: text,
      textPattern: text ? boundaryPattern(text) : null,
      terms: terms.map(compileTerm),
      // Highlighting compares whole words, so compounds are pre-split.
      markTerms: expandTokens(terms).map(compileTerm),
      // Case-folded only, so positions line up with `entry.displayText`.
      literal: String(rawQuery || '').toLowerCase().trim(),
    };
  }

  function matchQuality(field, query) {
    var covered = query.terms.every(function (term) { return fieldMatchesTerm(field, term); });
    if (!covered) return MATCH_TIER.NONE;
    if (field.value === query.text) return MATCH_TIER.EXACT;
    if (query.terms.length > 1 && field.value.includes(query.text)) return MATCH_TIER.PHRASE;
    if (query.terms.every(function (term) { return field.tokenSet.has(term.text); })) return MATCH_TIER.PHRASE;
    return MATCH_TIER.STEM;
  }

  function patternPosition(pattern, text) {
    var match = pattern.exec(text);
    return match ? match.index + match[1].length : -1;
  }

  function firstQueryPosition(text, query) {
    var position = query.textPattern ? patternPosition(query.textPattern, text) : -1;
    if (position >= 0) return position;
    var earliest = Number.POSITIVE_INFINITY;
    query.terms.forEach(function (term) {
      var found = patternPosition(term.exactPattern, text);
      if (found < 0 && term.prefixPattern) found = patternPosition(term.prefixPattern, text);
      if (found >= 0 && found < earliest) earliest = found;
    });
    return earliest;
  }

  function analyzeEntry(entry, query) {
    var covered = query.terms.every(function (term) {
      return entry.fields.some(function (field) { return fieldMatchesTerm(field, term); });
    });
    if (!covered) return null;

    var pageLabelQuality = matchQuality(entry.pageLabel, query);
    var titleQuality = matchQuality(entry.title, query);
    var trailQuality = matchQuality(entry.trail, query);
    var headingQuality = matchQuality(entry.heading, query);
    var textQuality = matchQuality(entry.text, query);
    var pageTier = Math.max(
      pageLabelQuality,
      titleQuality > MATCH_TIER.NONE ? Math.min(titleQuality, MATCH_TIER.TITLE) : MATCH_TIER.NONE,
      trailQuality > MATCH_TIER.NONE ? Math.min(trailQuality, MATCH_TIER.TRAIL) : MATCH_TIER.NONE
    );
    var sectionTier = Math.max(
      headingQuality > MATCH_TIER.NONE ? Math.max(headingQuality, MATCH_TIER.HEADING) : MATCH_TIER.NONE,
      textQuality > MATCH_TIER.NONE ? Math.min(textQuality, MATCH_TIER.BODY) : MATCH_TIER.NONE,
      MATCH_TIER.CROSS_FIELD
    );
    return {
      entry: entry,
      pageTier: pageTier,
      sectionTier: sectionTier,
      tier: Math.max(pageTier, sectionTier),
      position: firstQueryPosition(entry.text.value, query),
    };
  }

  function compareRanked(a, b) {
    return b.tier - a.tier ||
      b.pageTier - a.pageTier ||
      Number(Boolean(b.isPageCandidate)) - Number(Boolean(a.isPageCandidate)) ||
      Number(Boolean(b.roleMatch)) - Number(Boolean(a.roleMatch)) ||
      b.sectionTier - a.sectionTier ||
      Number(b.pageEvidence || 0) - Number(a.pageEvidence || 0) ||
      a.position - b.position ||
      Number(a.entry.record.section_order || 0) - Number(b.entry.record.section_order || 0) ||
      a.entry.record.title.localeCompare(b.entry.record.title);
  }

  function rankEntries(index, query) {
    if (!query.terms.length) return [];
    var matches = [];
    index.entries.forEach(function (entry) {
      var match = analyzeEntry(entry, query);
      if (match) matches.push(match);
    });
    if (!matches.length) return [];

    var itemsByPage = new Map();
    matches.forEach(function (item) {
      var bucket = itemsByPage.get(item.entry.page);
      if (bucket) bucket.push(item);
      else itemsByPage.set(item.entry.page, [item]);
    });

    var candidates = [];
    itemsByPage.forEach(function (items, page) {
      items.sort(compareRanked);
      var bestSection = items[0];
      var pageTier = items.reduce(function (max, item) { return Math.max(max, item.pageTier); }, MATCH_TIER.NONE);
      var pageEntry = index.pageEntries.get(page);
      var matchedPageEntry = pageEntry && items.find(function (item) { return item.entry === pageEntry; });
      var multiSectionBodyIntent = items.length >= 2 &&
        (bestSection.sectionTier <= MATCH_TIER.BODY || pageTier >= MATCH_TIER.STEM);
      var usePageEntry = Boolean(pageEntry) &&
        (pageTier >= bestSection.sectionTier || multiSectionBodyIntent);
      var representative = usePageEntry ? (matchedPageEntry || { entry: pageEntry }) : bestSection;
      var isLanding = Boolean(pageEntry) && pageEntry.record.page_role === 'landing' && pageTier > MATCH_TIER.NONE;
      var pageEvidence = Math.min(items.length, 3);

      candidates.push({
        entry: representative.entry,
        pageTier: pageTier,
        sectionTier: bestSection.sectionTier,
        tier: isLanding
          ? Math.min(MATCH_TIER.EXACT, Math.max(pageTier, bestSection.sectionTier) + 1)
          : Math.max(pageTier, bestSection.sectionTier),
        position: bestSection.position,
        pageEvidence: pageEvidence,
        isPageCandidate: true,
        roleMatch: isLanding,
      });
      items.forEach(function (item) {
        if (item.entry === representative.entry) return;
        candidates.push({
          entry: item.entry,
          pageTier: item.pageTier,
          sectionTier: item.sectionTier,
          tier: Math.max(item.sectionTier, item.pageTier > MATCH_TIER.NONE ? item.pageTier - 1 : MATCH_TIER.NONE),
          position: item.position,
          pageEvidence: pageEvidence,
          isPageCandidate: false,
          roleMatch: false,
        });
      });
    });

    candidates.sort(compareRanked);
    var selectedUrls = new Set();
    var pageCounts = new Map();
    var selected = [];
    for (var i = 0; i < candidates.length && selected.length < RESULT_LIMIT; i += 1) {
      var item = candidates[i];
      var url = item.entry.record.url;
      if (selectedUrls.has(url)) continue;
      var taken = pageCounts.get(item.entry.page) || 0;
      if (taken >= PER_PAGE_LIMIT) continue;
      selectedUrls.add(url);
      pageCounts.set(item.entry.page, taken + 1);
      selected.push(item);
    }
    return selected;
  }

  /* ----- Presentation ----- */

  function snippetFor(entry, query) {
    var text = entry.displayText;
    if (!text) return '';
    var lower = entry.displayLower;
    var position = query.literal ? lower.indexOf(query.literal) : -1;
    for (var i = 0; i < query.terms.length && position < 0; i += 1) {
      position = lower.indexOf(query.terms[i].text);
    }
    if (position < 0) position = 0;
    var start = Math.max(0, position - 70);
    var end = Math.min(text.length, start + 210);
    return (start > 0 ? '…' : '') + text.slice(start, end).trim() + (end < text.length ? '…' : '');
  }

  // Appends `text` to `target`, wrapping matched words in <mark>. Word-by-word
  // so highlighting agrees with the matcher that produced the result.
  function appendMarked(target, text, query) {
    if (!text) return;
    var parts = query.markTerms.length ? text.split(/([A-Za-z0-9]+)/) : [text];
    for (var i = 0; i < parts.length; i += 1) {
      var part = parts[i];
      if (!part) continue;
      if (i % 2 === 1 && matchesAnyTerm(query.markTerms, normalize(part))) {
        var mark = document.createElement('mark');
        mark.textContent = part;
        target.appendChild(mark);
      } else {
        target.appendChild(document.createTextNode(part));
      }
    }
  }

  function isTypingTarget(target) {
    if (!target) return false;
    var tag = target.tagName;
    return target.isContentEditable || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  }

  function ensureHeadingIds() {
    var content = document.querySelector('article') || document.querySelector('main');
    if (!content) return;
    var usedIds = new Set();
    document.querySelectorAll('[id]').forEach(function (element) {
      usedIds.add(element.id);
    });
    content.querySelectorAll('h1, h2, h3').forEach(function (heading) {
      if (heading.id) return;
      var baseId = heading.textContent.trim().toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '') || 'section';
      var uniqueId = baseId;
      var suffix = 2;
      while (usedIds.has(uniqueId)) {
        uniqueId = baseId + '-' + suffix;
        suffix += 1;
      }
      heading.id = uniqueId;
      usedIds.add(uniqueId);
    });
  }

  function alignCurrentHash() {
    if (!window.location.hash || window.location.hash.length < 2) return;
    var id;
    try {
      id = decodeURIComponent(window.location.hash.slice(1));
    } catch (error) {
      return;
    }
    var target = document.getElementById(id);
    if (!target) return;
    var cancelled = false;
    var cancelDelayedAlignment = function () { cancelled = true; };
    window.addEventListener('wheel', cancelDelayedAlignment, { once: true, passive: true });
    window.addEventListener('touchstart', cancelDelayedAlignment, { once: true, passive: true });
    window.addEventListener('pointerdown', cancelDelayedAlignment, { once: true, passive: true });
    window.addEventListener('keydown', cancelDelayedAlignment, { once: true });
    var align = function () {
      if (cancelled) return;
      var previousScrollBehavior = document.documentElement.style.scrollBehavior;
      document.documentElement.style.scrollBehavior = 'auto';
      target.scrollIntoView({ behavior: 'auto', block: 'start' });
      document.documentElement.style.scrollBehavior = previousScrollBehavior;
    };
    window.requestAnimationFrame(align);
    window.setTimeout(align, 150);
  }

  function initSearch() {
    ensureHeadingIds();
    alignCurrentHash();
    var header = document.querySelector('.top-nav .container, .site-header .header-inner, .navigation-section');
    if (!header || header.querySelector('.site-search')) return;

    var wrapper = document.createElement('div');
    wrapper.className = 'site-search';
    wrapper.innerHTML =
      '<label class="site-search-label" for="site-search-input">Search MAPLE documentation</label>' +
      '<div class="site-search-field">' +
        '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"></circle><path d="m20 20-3.5-3.5"></path></svg>' +
        '<input class="site-search-input" id="site-search-input" type="search" placeholder="Search docs" autocomplete="off" spellcheck="false" role="combobox" aria-autocomplete="list" aria-controls="site-search-results" aria-expanded="false">' +
        '<kbd class="site-search-shortcut" aria-hidden="true">/</kbd>' +
      '</div>' +
      '<div class="site-search-results" id="site-search-results" role="listbox" aria-label="Search results" hidden></div>';

    var navTools = header.querySelector('.nav-tools');
    if (navTools) header.insertBefore(wrapper, navTools);
    else header.appendChild(wrapper);

    var input = wrapper.querySelector('.site-search-input');
    var panel = wrapper.querySelector('.site-search-results');
    var requestId = 0;
    var activeIndex = -1;
    var debounceTimer = 0;

    function resultLinks() {
      return Array.from(panel.querySelectorAll('.site-search-result'));
    }

    function setOpen(open) {
      panel.hidden = !open;
      input.setAttribute('aria-expanded', String(open));
      if (!open) {
        activeIndex = -1;
        input.removeAttribute('aria-activedescendant');
      }
    }

    function setActive(index) {
      var links = resultLinks();
      if (!links.length) return;
      activeIndex = (index + links.length) % links.length;
      links.forEach(function (link, itemIndex) {
        var active = itemIndex === activeIndex;
        link.classList.toggle('active', active);
        link.setAttribute('aria-selected', String(active));
      });
      input.setAttribute('aria-activedescendant', links[activeIndex].id);
      links[activeIndex].scrollIntoView({ block: 'nearest' });
    }

    function showMessage(message, isError) {
      panel.replaceChildren();
      var note = document.createElement('p');
      note.className = 'site-search-empty' + (isError ? ' error' : '');
      note.textContent = message;
      panel.appendChild(note);
      setOpen(true);
    }

    function renderResults(index, query) {
      var ranked = rankEntries(index, query);
      panel.replaceChildren();
      activeIndex = -1;
      input.removeAttribute('aria-activedescendant');
      if (!ranked.length) {
        showMessage('No matching documentation found.');
        return;
      }

      var summary = document.createElement('p');
      summary.className = 'site-search-summary';
      summary.textContent = ranked.length + (ranked.length === 1 ? ' result' : ' results');
      panel.appendChild(summary);

      var fragment = document.createDocumentFragment();
      ranked.forEach(function (item, position) {
        var record = item.entry.record;
        var link = document.createElement('a');
        link.className = 'site-search-result';
        link.id = 'site-search-option-' + position;
        link.setAttribute('role', 'option');
        link.setAttribute('aria-selected', 'false');
        link.tabIndex = -1;
        link.href = new URL(record.url, siteRoot).href;

        var meta = document.createElement('span');
        meta.className = 'site-search-result-meta';
        meta.textContent = record.trail && record.trail.length
          ? record.trail.join(' › ')
          : record.type + ' · ' + record.title;
        var heading = document.createElement('strong');
        appendMarked(heading, record.heading, query);
        var snippet = document.createElement('span');
        snippet.className = 'site-search-result-snippet';
        appendMarked(snippet, snippetFor(item.entry, query), query);
        link.append(meta, heading, snippet);
        fragment.appendChild(link);
      });
      panel.appendChild(fragment);
      setOpen(true);
    }

    function runSearch() {
      window.clearTimeout(debounceTimer);
      var raw = input.value.trim();
      requestId += 1;
      var currentRequest = requestId;
      if (raw.length < MIN_QUERY_LENGTH) {
        panel.replaceChildren();
        setOpen(false);
        return;
      }
      // The placeholder only earns its keep while the index is still in flight.
      if (!indexReady) showMessage('Searching…');
      var query = parseQuery(raw);
      loadIndex().then(function (index) {
        if (currentRequest === requestId) renderResults(index, query);
      }).catch(function () {
        if (currentRequest === requestId) showMessage('Search is temporarily unavailable.', true);
      });
    }

    function warmIndex() {
      loadIndex().catch(function () { /* surfaced on the next query */ });
    }

    input.addEventListener('input', function () {
      window.clearTimeout(debounceTimer);
      if (input.value.trim().length < MIN_QUERY_LENGTH) {
        runSearch();
        return;
      }
      debounceTimer = window.setTimeout(runSearch, QUERY_DEBOUNCE_MS);
    });
    input.addEventListener('focus', function () {
      warmIndex();
      if (input.value.trim().length >= MIN_QUERY_LENGTH) runSearch();
    });
    wrapper.addEventListener('pointerenter', warmIndex, { once: true });
    input.addEventListener('keydown', function (event) {
      var links = resultLinks();
      if (event.key === 'ArrowDown' && links.length) {
        event.preventDefault();
        if (panel.hidden) setOpen(true);
        setActive(activeIndex + 1);
      } else if (event.key === 'ArrowUp' && links.length) {
        event.preventDefault();
        if (panel.hidden) setOpen(true);
        setActive(activeIndex < 0 ? links.length - 1 : activeIndex - 1);
      } else if (event.key === 'Enter' && activeIndex >= 0 && links[activeIndex]) {
        event.preventDefault();
        links[activeIndex].click();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
      }
    });
    wrapper.addEventListener('focusout', function () {
      window.setTimeout(function () {
        if (!wrapper.contains(document.activeElement)) setOpen(false);
      }, 0);
    });

    document.addEventListener('keydown', function (event) {
      if ((event.key === '/' && !event.metaKey && !event.ctrlKey && !event.altKey) ||
          ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k')) {
        if (isTypingTarget(event.target)) return;
        event.preventDefault();
        input.focus();
        input.select();
      }
    });
    document.addEventListener('pointerdown', function (event) {
      if (!wrapper.contains(event.target)) setOpen(false);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initSearch);
  } else {
    initSearch();
  }
})();
