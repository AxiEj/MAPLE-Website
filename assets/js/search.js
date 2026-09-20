(function () {
  'use strict';

  var script = document.currentScript;
  if (!script) return;
  var siteRoot = new URL('../../', script.src);
  var indexUrl = new URL('assets/search-index.json', siteRoot);
  var scriptIndexUrl = new URL('assets/search-index.js', siteRoot);
  var indexPromise = null;
  var scriptIndexPromise = null;

  function documentsFromPayload(payload) {
    if (!payload || payload.version !== 2 || !Array.isArray(payload.documents)) {
      throw new Error('Unsupported search index schema');
    }
    return payload.documents;
  }

  function loadScriptIndex() {
    if (window.MAPLE_SEARCH_INDEX) {
      return Promise.resolve().then(function () {
        return documentsFromPayload(window.MAPLE_SEARCH_INDEX);
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
            resolve(documentsFromPayload(window.MAPLE_SEARCH_INDEX));
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
        return documentsFromPayload(window.MAPLE_SEARCH_INDEX);
      });
    }
    if (!indexPromise) {
      var primary = window.location.protocol === 'file:'
        ? loadScriptIndex()
        : fetch(indexUrl).then(function (response) {
          if (!response.ok) throw new Error('Search index request failed');
          return response.json();
        }).then(function (payload) {
          return documentsFromPayload(payload);
        }).catch(function () {
          return loadScriptIndex();
        });
      indexPromise = primary.catch(function (error) {
        indexPromise = null;
        throw error;
      });
    }
    return indexPromise;
  }

  function normalize(value) {
    return String(value || '').normalize('NFKD').toLowerCase();
  }

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

  function queryTerms(query) {
    return normalize(query).match(/[a-z0-9]+(?:[._/+:-][a-z0-9]+)*/g) || [];
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

  function fieldTokens(value) {
    var compounds = queryTerms(value);
    var tokens = new Set();
    compounds.forEach(function (compound) {
      tokens.add(compound);
      compound.split(/[._/+:-]+/).forEach(function (part) {
        if (part) tokens.add(part);
      });
    });
    return Array.from(tokens);
  }

  function termMatches(term, candidate) {
    if (term === candidate) return true;
    if (term.length >= MIN_PREFIX_LENGTH && candidate.startsWith(term)) return true;
    return term.length >= MIN_STEM_LENGTH && stemToken(term) === stemToken(candidate);
  }

  function hasExactTerm(tokens, term) {
    return tokens.some(function (candidate) { return candidate === term; });
  }

  function coversTerms(tokens, terms) {
    return terms.every(function (term) {
      return tokens.some(function (candidate) { return termMatches(term, candidate); });
    });
  }

  function matchQuality(value, terms, normalizedQuery) {
    var normalizedValue = normalize(value);
    var tokens = fieldTokens(normalizedValue);
    if (!coversTerms(tokens, terms)) return MATCH_TIER.NONE;
    if (normalizedValue === normalizedQuery) return MATCH_TIER.EXACT;
    if (terms.length > 1 && normalizedValue.includes(normalizedQuery)) return MATCH_TIER.PHRASE;
    if (terms.every(function (term) { return hasExactTerm(tokens, term); })) return MATCH_TIER.PHRASE;
    return MATCH_TIER.STEM;
  }

  function firstQueryPosition(text, normalizedQuery, terms) {
    var escapePattern = function (value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); };
    var boundaryPosition = function (value) {
      var match = new RegExp('(^|[^a-z0-9])' + escapePattern(value) + '(?=$|[^a-z0-9])').exec(text);
      return match ? match.index + match[1].length : -1;
    };
    var position = boundaryPosition(normalizedQuery);
    if (position >= 0) return position;
    var positions = terms.map(function (term) {
      var exactPosition = boundaryPosition(term);
      if (exactPosition >= 0 || term.length < MIN_PREFIX_LENGTH) return exactPosition;
      var prefixMatch = new RegExp('(^|[^a-z0-9])' + escapePattern(term) + '[a-z0-9]*').exec(text);
      return prefixMatch ? prefixMatch.index + prefixMatch[1].length : -1;
    }).filter(function (item) { return item >= 0; });
    return positions.length ? Math.min.apply(Math, positions) : Number.POSITIVE_INFINITY;
  }

  function analyzeDocument(document, normalizedQuery, terms) {
    var title = normalize(document.title);
    var heading = normalize(document.heading);
    var text = normalize(document.text);
    var trail = normalize((document.trail || []).join(' '));
    var pageLabel = normalize((document.trail || []).slice(-1)[0] || document.title);
    var allTokens = fieldTokens([title, heading, text, trail, pageLabel].join(' '));
    if (!coversTerms(allTokens, terms)) return null;

    var pageLabelQuality = matchQuality(pageLabel, terms, normalizedQuery);
    var titleQuality = matchQuality(title, terms, normalizedQuery);
    var trailQuality = matchQuality(trail, terms, normalizedQuery);
    var headingQuality = matchQuality(heading, terms, normalizedQuery);
    var textQuality = matchQuality(text, terms, normalizedQuery);
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
      document: document,
      pageTier: pageTier,
      sectionTier: sectionTier,
      tier: Math.max(pageTier, sectionTier),
      position: firstQueryPosition(text, normalizedQuery, terms),
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
      Number(a.document.section_order || 0) - Number(b.document.section_order || 0) ||
      a.document.title.localeCompare(b.document.title);
  }

  function rankDocuments(documents, query) {
    var normalizedQuery = normalize(query).trim();
    var terms = queryTerms(normalizedQuery);
    if (!terms.length) return [];
    var matches = documents.map(function (document) {
      return analyzeDocument(document, normalizedQuery, terms);
    }).filter(Boolean);
    if (!matches.length) return [];

    var itemsByPage = new Map();
    var pageEntries = new Map();
    documents.forEach(function (document) {
      var page = document.page || document.url.split('#')[0];
      if (document.page_entry && !pageEntries.has(page)) pageEntries.set(page, document);
    });
    matches.forEach(function (item) {
      var page = item.document.page || item.document.url.split('#')[0];
      if (!itemsByPage.has(page)) itemsByPage.set(page, []);
      itemsByPage.get(page).push(item);
    });

    var candidates = [];
    itemsByPage.forEach(function (items) {
      items.sort(compareRanked);
      var bestSection = items[0];
      var pageTier = Math.max.apply(null, items.map(function (item) { return item.pageTier; }));
      var pageEntryDocument = pageEntries.get(bestSection.document.page || bestSection.document.url.split('#')[0]);
      var matchedPageEntry = items.find(function (item) { return item.document.url === (pageEntryDocument && pageEntryDocument.url); });
      var multiSectionBodyIntent = items.length >= 2 &&
        (bestSection.sectionTier <= MATCH_TIER.BODY || pageTier >= MATCH_TIER.STEM);
      var usePageEntry = Boolean(pageEntryDocument) &&
        (pageTier >= bestSection.sectionTier || multiSectionBodyIntent);
      var representative = usePageEntry
        ? (matchedPageEntry || {
          document: pageEntryDocument,
          pageTier: pageTier,
          sectionTier: MATCH_TIER.NONE,
          position: bestSection.position,
        })
        : bestSection;
      var candidateTier = Math.max(pageTier, bestSection.sectionTier);
      if (pageEntryDocument && pageEntryDocument.page_role === 'landing' && pageTier > MATCH_TIER.NONE) {
        candidateTier = Math.min(MATCH_TIER.EXACT, candidateTier + 1);
      }
      var pageCandidate = {
        document: representative.document,
        pageTier: pageTier,
        sectionTier: bestSection.sectionTier,
        tier: candidateTier,
        position: bestSection.position,
        pageEvidence: Math.min(items.length, 3),
        isPageCandidate: true,
        roleMatch: pageEntryDocument && pageEntryDocument.page_role === 'landing' && pageTier > MATCH_TIER.NONE,
      };
      candidates.push(pageCandidate);
      items.forEach(function (item) {
        if (item.document.url === representative.document.url) return;
        candidates.push({
          document: item.document,
          pageTier: item.pageTier,
          sectionTier: item.sectionTier,
          tier: Math.max(item.sectionTier, item.pageTier > MATCH_TIER.NONE ? item.pageTier - 1 : MATCH_TIER.NONE),
          position: item.position,
          pageEvidence: Math.min(items.length, 3),
          isPageCandidate: false,
          roleMatch: false,
        });
      });
    });
    candidates.sort(compareRanked);
    var selectedUrls = new Set();
    var pageCounts = new Map();
    return candidates.filter(function (item) {
      if (selectedUrls.has(item.document.url)) return false;
      var page = item.document.page || item.document.url.split('#')[0];
      if ((pageCounts.get(page) || 0) >= PER_PAGE_LIMIT) return false;
      selectedUrls.add(item.document.url);
      pageCounts.set(page, (pageCounts.get(page) || 0) + 1);
      return true;
    }).slice(0, RESULT_LIMIT);
  }

  function snippetFor(document, query) {
    var text = String(document.text || '').replace(/\s+/g, ' ').trim();
    if (!text) return '';
    var lower = normalize(text);
    var terms = query.split(/\s+/).filter(Boolean);
    var position = lower.indexOf(query);
    if (position < 0) {
      for (var i = 0; i < terms.length && position < 0; i += 1) {
        position = lower.indexOf(terms[i]);
      }
    }
    if (position < 0) position = 0;
    var start = Math.max(0, position - 70);
    var end = Math.min(text.length, start + 210);
    return (start > 0 ? '…' : '') + text.slice(start, end).trim() + (end < text.length ? '…' : '');
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

    function renderResults(documents, rawQuery) {
      var query = normalize(rawQuery).trim();
      var ranked = rankDocuments(documents, query);

      panel.replaceChildren();
      activeIndex = -1;
      input.removeAttribute('aria-activedescendant');
      if (!ranked.length) {
        var empty = document.createElement('p');
        empty.className = 'site-search-empty';
        empty.textContent = 'No matching documentation found.';
        panel.appendChild(empty);
        setOpen(true);
        return;
      }

      var summary = document.createElement('p');
      summary.className = 'site-search-summary';
      summary.textContent = ranked.length + (ranked.length === 1 ? ' result' : ' results');
      panel.appendChild(summary);

      ranked.forEach(function (item, index) {
        var record = item.document;
        var link = document.createElement('a');
        link.className = 'site-search-result';
        link.id = 'site-search-option-' + index;
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
        heading.textContent = record.heading;
        var snippet = document.createElement('span');
        snippet.className = 'site-search-result-snippet';
        snippet.textContent = snippetFor(record, query);
        link.append(meta, heading, snippet);
        panel.appendChild(link);
      });
      setOpen(true);
    }

    function search() {
      var query = input.value.trim();
      requestId += 1;
      var currentRequest = requestId;
      if (query.length < 2) {
        panel.replaceChildren();
        setOpen(false);
        return;
      }
      panel.replaceChildren();
      var loading = document.createElement('p');
      loading.className = 'site-search-empty';
      loading.textContent = 'Searching…';
      panel.appendChild(loading);
      setOpen(true);

      loadIndex().then(function (documents) {
        if (currentRequest === requestId) renderResults(documents, query);
      }).catch(function () {
        if (currentRequest !== requestId) return;
        panel.replaceChildren();
        var error = document.createElement('p');
        error.className = 'site-search-empty error';
        error.textContent = 'Search is temporarily unavailable.';
        panel.appendChild(error);
        setOpen(true);
      });
    }

    input.addEventListener('input', search);
    input.addEventListener('focus', function () {
      if (input.value.trim().length >= 2) search();
    });
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
