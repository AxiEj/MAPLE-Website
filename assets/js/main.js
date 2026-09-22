/* ============================================================
   MAPLE Documentation — Interactive Components
   ============================================================ */

document.addEventListener('DOMContentLoaded', function () {

  // ----- 1. Sidebar Tree Toggle -----
  var treeControlIndex = 0;

  function setupTreeControl(control, li, children, label) {
    if (!control || !li || !children) return;

    if (!children.id) {
      treeControlIndex += 1;
      children.id = 'sidebar-group-' + treeControlIndex;
    }
    control.type = 'button';
    control.setAttribute('aria-controls', children.id);
    if (label) control.setAttribute('aria-label', label);

    function setTreeOpen(open) {
      li.classList.toggle('open', open);
      control.setAttribute('aria-expanded', String(open));
      children.setAttribute('aria-hidden', String(!open));
      children.inert = !open;
    }

    setTreeOpen(li.classList.contains('open'));
    control.addEventListener('click', function () {
      setTreeOpen(!li.classList.contains('open'));
    });
  }

  document.querySelectorAll('.sidebar-tree .tree-section').forEach(function (section) {
    var li = section.closest('li');
    var children = li ? li.querySelector(':scope > .children') : null;
    var control = section;

    if (section.tagName !== 'BUTTON') {
      control = document.createElement('button');
      control.className = section.className;
      control.innerHTML = section.innerHTML;
      section.replaceWith(control);
    }
    setupTreeControl(control, li, children);
  });

  document.querySelectorAll('.sidebar-tree .tree-label').forEach(function (label) {
    var li = label.closest('li');
    var children = li ? li.querySelector(':scope > .children') : null;
    var chevron = label.querySelector('.chevron');
    var link = label.querySelector('a');
    if (!chevron || !children) return;

    var control = chevron;
    if (chevron.tagName !== 'BUTTON') {
      control = document.createElement('button');
      control.className = chevron.className + ' tree-toggle';
      chevron.replaceWith(control);
    } else {
      control.classList.add('tree-toggle');
    }
    var name = link ? link.textContent.trim() : 'section';
    setupTreeControl(control, li, children, 'Toggle ' + name + ' section');
  });

  // ----- 2. MAPLE Input Syntax Highlighting -----
  function escapeHtml(text) {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function isMapleInput(text) {
    return /(^|\n)\s*#(?:model|device|charge|mult|sp|opt|ts|scan|irc|freq|md|solv|solvent|constraint|constraints)\b/i.test(text) ||
      /(^|\n)\s*(?:XYZ|PDB|MOL2)\s+\S+/i.test(text);
  }

  function highlightDirectiveTail(tail) {
    var directValue = tail.match(/^(\s*=\s*)("[^"]*"|'[^']*'|[^,\)\s]+)(.*)$/);
    if (directValue) {
      return escapeHtml(directValue[1]) +
        '<span class="value">' + escapeHtml(directValue[2]) + '</span>' +
        escapeHtml(directValue[3]);
    }

    var out = '';
    var last = 0;
    var paramRe = /([A-Za-z_][\w-]*)(\s*=\s*)("[^"]*"|'[^']*'|[^,\)\s]+)/g;
    var match;
    while ((match = paramRe.exec(tail)) !== null) {
      out += escapeHtml(tail.slice(last, match.index));
      out += '<span class="param">' + escapeHtml(match[1]) + '</span>';
      out += escapeHtml(match[2]);
      out += '<span class="value">' + escapeHtml(match[3]) + '</span>';
      last = match.index + match[0].length;
    }
    out += escapeHtml(tail.slice(last));
    return out;
  }

  function highlightCoordinateLine(line) {
    var match = line.match(/^(\s*)([A-Z][a-z]?)((?:\s+[-+]?\d*\.\d+(?:[Ee][-+]?\d+)?){3,})(.*)$/);
    if (!match) return null;
    return escapeHtml(match[1]) +
      '<span class="atom">' + escapeHtml(match[2]) + '</span>' +
      escapeHtml(match[3]).replace(/([-+]?\d*\.?\d+(?:[Ee][-+]?\d+)?)/g, '<span class="number">$1</span>') +
      escapeHtml(match[4]);
  }

  function highlightScanLine(line) {
    var match = line.match(/^(\s*)(S)((?:\s+[-+]?\d*\.?\d+(?:[Ee][-+]?\d+)?){3,})(.*)$/);
    if (!match) return null;
    var nums = match[3].match(/\s+[-+]?\d*\.?\d+(?:[Ee][-+]?\d+)?/g) || [];
    var n = nums.length;
    if (n < 4 || n > 6) return null;
    var atomCount = n - 2;
    var out = escapeHtml(match[1]) + '<span class="directive">' + escapeHtml(match[2]) + '</span>';
    nums.forEach(function (chunk, i) {
      var parts = chunk.match(/^(\s+)([-+]?\d*\.?\d+(?:[Ee][-+]?\d+)?)$/);
      if (!parts) return;
      var cls = i < atomCount ? 'atom-idx' : (i === atomCount ? 'step-size' : 'n-steps');
      out += escapeHtml(parts[1]) + '<span class="' + cls + '">' + escapeHtml(parts[2]) + '</span>';
    });
    return out + escapeHtml(match[4]);
  }

  function highlightMapleLine(line) {
    if (/^\s*$/.test(line)) return '';

    if (/^\s*#\s/.test(line)) {
      return '<span class="comment">' + escapeHtml(line) + '</span>';
    }

    var directive = line.match(/^(\s*)#([A-Za-z_][\w-]*)(.*)$/);
    if (directive) {
      return escapeHtml(directive[1]) +
        '<span class="hash">#</span><span class="directive">' + escapeHtml(directive[2]) + '</span>' +
        highlightDirectiveTail(directive[3]);
    }

    var fileRef = line.match(/^(\s*)(XYZ|PDB|MOL2)(\s+)(.*)$/i);
    if (fileRef) {
      return escapeHtml(fileRef[1]) +
        '<span class="directive">' + escapeHtml(fileRef[2]) + '</span>' +
        escapeHtml(fileRef[3]) +
        '<span class="filename">' + escapeHtml(fileRef[4]) + '</span>';
    }

    return highlightCoordinateLine(line) || highlightScanLine(line) || escapeHtml(line);
  }

  document.querySelectorAll('pre code').forEach(function (code) {
    var text = code.textContent;
    if (!isMapleInput(text)) return;

    var pre = code.closest('pre');
    if (pre) pre.classList.add('maple-code');
    code.classList.add('maple-input-code');
    code.innerHTML = text.split('\n').map(highlightMapleLine).join('\n');
  });

  // ----- 3. Copy Code Buttons -----
  var copyIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>';
  var copiedIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';

  function copyStatusFor(button) {
    var parent = button.parentElement;
    var status = parent ? parent.querySelector(':scope > .copy-status') : null;
    if (!status && parent) {
      status = document.createElement('span');
      status.className = 'copy-status';
      status.setAttribute('role', 'status');
      status.setAttribute('aria-live', 'polite');
      parent.appendChild(status);
    }
    return status;
  }

  async function writeClipboard(text, button, defaultLabel, useCopiedIcon) {
    var status = copyStatusFor(button);
    window.clearTimeout(button._copyResetTimer);
    button.classList.remove('copied', 'copy-failed');

    try {
      if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
        throw new Error('Clipboard API is unavailable');
      }
      await navigator.clipboard.writeText(text);
      button.classList.add('copied');
      button.setAttribute('aria-label', 'Copied to clipboard');
      if (useCopiedIcon) button.innerHTML = copiedIcon;
      if (status) {
        status.textContent = 'Copied';
        status.classList.remove('error');
        status.classList.add('visible');
      }
      button._copyResetTimer = window.setTimeout(function () {
        button.classList.remove('copied');
        button.setAttribute('aria-label', defaultLabel);
        if (useCopiedIcon) button.innerHTML = copyIcon;
        if (status) {
          status.textContent = '';
          status.classList.remove('visible');
        }
      }, 2000);
    } catch (error) {
      button.classList.add('copy-failed');
      button.setAttribute('aria-label', 'Copy failed');
      if (status) {
        status.textContent = 'Copy failed. Select the code and copy it manually.';
        status.classList.add('visible', 'error');
      }
    }
  }

  document.querySelectorAll('pre').forEach(function (pre) {
    // Dedicated structure buttons are initialized below.
    if (pre.parentElement.classList.contains('code-wrapper') || pre.querySelector('[data-copy-target]')) return;

    var wrapper = document.createElement('div');
    wrapper.className = 'code-wrapper';
    pre.parentNode.insertBefore(wrapper, pre);
    wrapper.appendChild(pre);

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'copy-btn';
    btn.setAttribute('aria-label', 'Copy code');
    btn.innerHTML = copyIcon;

    btn.addEventListener('click', function () {
      var code = pre.querySelector('code');
      var text = code ? code.textContent : pre.textContent;
      writeClipboard(text, btn, 'Copy code', true);
    });

    wrapper.appendChild(btn);
  });

  document.querySelectorAll('[data-copy-target]').forEach(function (button) {
    var defaultLabel = button.getAttribute('aria-label') || 'Copy code';
    button.addEventListener('click', function () {
      var targetId = button.getAttribute('data-copy-target');
      var target = targetId ? document.getElementById(targetId) : null;
      if (!target) return;
      writeClipboard(target.textContent, button, defaultLabel, false);
    });
  });

  // ----- 4. Generate TOC, then initialize scroll spy -----
  var tocContainer = document.querySelector('.toc ul');
  if (tocContainer && tocContainer.children.length === 0) {
    var article = document.querySelector('article');
    if (article) {
      var usedHeadingIds = new Set();
      document.querySelectorAll('[id]').forEach(function (element) {
        usedHeadingIds.add(element.id);
      });
      article.querySelectorAll('h2, h3').forEach(function (heading) {
        if (!heading.id) {
          var baseId = heading.textContent.trim().toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '') || 'section';
          var uniqueId = baseId;
          var suffix = 2;
          while (usedHeadingIds.has(uniqueId)) {
            uniqueId = baseId + '-' + suffix;
            suffix += 1;
          }
          heading.id = uniqueId;
          usedHeadingIds.add(uniqueId);
        }
        var item = document.createElement('li');
        if (heading.tagName === 'H3') item.className = 'toc-h3';
        var anchor = document.createElement('a');
        anchor.href = '#' + heading.id;
        anchor.textContent = heading.textContent;
        item.appendChild(anchor);
        tocContainer.appendChild(item);
      });
    }
  }

  var tocLinks = document.querySelectorAll('.toc a');
  if (tocLinks.length > 0) {
    var headings = [];
    tocLinks.forEach(function (link) {
      var id = link.getAttribute('href');
      if (id && id.startsWith('#')) {
        var heading = document.querySelector(id);
        if (heading) headings.push({ el: heading, link: link });
      }
    });

    // Heading offsets are measured once per layout change rather than once per
    // scroll event, all reads happen inside one animation frame, and the active
    // class is only rewritten when it actually moves.
    var headingOffsets = [];
    var activeTocLink = null;
    var needsMeasure = true;
    var tocFrame = 0;

    function paintTocActive() {
      tocFrame = 0;
      if (needsMeasure) {
        var scrollY = window.scrollY;
        headingOffsets = headings.map(function (item) {
          return item.el.getBoundingClientRect().top + scrollY;
        });
        needsMeasure = false;
      }
      var edge = window.scrollY + 100;
      var current = headings.length ? headings[0].link : null;
      for (var i = 0; i < headingOffsets.length; i += 1) {
        if (headingOffsets[i] <= edge) current = headings[i].link;
      }
      if (current === activeTocLink) return;
      if (activeTocLink) activeTocLink.classList.remove('active');
      if (current) current.classList.add('active');
      activeTocLink = current;
    }

    function scheduleTocUpdate() {
      if (!tocFrame) tocFrame = window.requestAnimationFrame(paintTocActive);
    }

    function invalidateTocOffsets() {
      needsMeasure = true;
      scheduleTocUpdate();
    }

    paintTocActive();
    window.addEventListener('scroll', scheduleTocUpdate, { passive: true });
    window.addEventListener('resize', invalidateTocOffsets, { passive: true });
    // Images and late-loading fonts change where headings sit.
    window.addEventListener('load', invalidateTocOffsets);
  }

  // ----- 5. Mobile Hamburger Menu -----
  var mobileToggle = document.querySelector('.mobile-toggle');
  var sidebar = document.querySelector('.sidebar');
  var overlay = document.querySelector('.sidebar-overlay');
  var topNavUl = document.querySelector('.top-nav ul');
  var compactNavQuery = window.matchMedia('(max-width: 78em)');
  var sidebarDrawerQuery = window.matchMedia('(max-width: 67em)');
  var sidebarFab = null;
  var lastSidebarTrigger = null;

  if (topNavUl && !topNavUl.id) topNavUl.id = 'primary-navigation';
  if (mobileToggle) {
    mobileToggle.type = 'button';
    if (topNavUl) mobileToggle.setAttribute('aria-controls', topNavUl.id);
  }
  if (sidebar && !sidebar.id) sidebar.id = 'documentation-sidebar';

  function setTopNavOpen(open, returnFocus) {
    if (topNavUl) topNavUl.classList.toggle('open', open);
    if (mobileToggle) mobileToggle.setAttribute('aria-expanded', String(open));
    if (!open && returnFocus && mobileToggle) mobileToggle.focus();
  }

  function setSidebarOpen(open, trigger, returnFocus) {
    var drawer = sidebarDrawerQuery.matches;
    if (open && trigger) lastSidebarTrigger = trigger;
    if (sidebar) sidebar.classList.toggle('open', open);
    if (overlay) overlay.classList.toggle('active', open);
    if (sidebarFab) {
      sidebarFab.classList.toggle('active', open);
      sidebarFab.setAttribute('aria-expanded', String(open));
    }
    if (sidebar) {
      sidebar.inert = drawer && !open;
      if (drawer) sidebar.setAttribute('aria-hidden', String(!open));
      else sidebar.removeAttribute('aria-hidden');
    }
    if (!open && returnFocus && lastSidebarTrigger) lastSidebarTrigger.focus();
  }

  if (sidebar) {
    sidebarFab = document.createElement('button');
    sidebarFab.type = 'button';
    sidebarFab.className = 'sidebar-fab';
    sidebarFab.setAttribute('aria-label', 'Toggle documentation sidebar');
    sidebarFab.setAttribute('aria-expanded', 'false');
    sidebarFab.setAttribute('aria-controls', sidebar.id);
    sidebarFab.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6h14"/><path d="M4 12h10"/><path d="M4 18h14"/><path d="M20 8l-3 4 3 4"/></svg>';
    document.body.appendChild(sidebarFab);
    sidebarFab.addEventListener('click', function () {
      setTopNavOpen(false);
      setSidebarOpen(!sidebar.classList.contains('open'), sidebarFab);
    });
  }

  if (mobileToggle) {
    mobileToggle.setAttribute('aria-expanded', 'false');
    mobileToggle.addEventListener('click', function () {
      setSidebarOpen(false);
      if (topNavUl) setTopNavOpen(!topNavUl.classList.contains('open'));
    });
  }

  if (topNavUl) {
    topNavUl.querySelectorAll('a').forEach(function (link) {
      link.addEventListener('click', function () { setTopNavOpen(false); });
    });
  }

  if (overlay) {
    overlay.addEventListener('click', function () {
      setSidebarOpen(false, null, true);
    });
  }

  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape') return;
    if (topNavUl && topNavUl.classList.contains('open')) {
      setTopNavOpen(false, true);
      return;
    }
    if (sidebar && sidebar.classList.contains('open')) {
      setSidebarOpen(false, null, true);
    }
  });

  if (compactNavQuery.addEventListener) {
    compactNavQuery.addEventListener('change', function () {
      setTopNavOpen(false);
    });
  }
  if (sidebarDrawerQuery.addEventListener) {
    sidebarDrawerQuery.addEventListener('change', function () {
      setSidebarOpen(false);
    });
  }
  setSidebarOpen(false);

  // ----- 5b. Skip Link -----
  // Docs pages put a few dozen sidebar links between the header and the
  // article; keyboard and screen-reader users need a way past them.
  var contentRoot = document.querySelector('main, .page-body');
  if (sidebar && contentRoot) {
    if (!contentRoot.id) contentRoot.id = 'main-content';
    contentRoot.tabIndex = -1;
    contentRoot.classList.add('skip-target');

    var skipLink = document.createElement('a');
    skipLink.className = 'skip-link';
    skipLink.href = '#' + contentRoot.id;
    skipLink.textContent = 'Skip to content';
    // Scrolling is left to the shared anchor handler below; this only needs to
    // move the caret so the next Tab continues inside the article.
    skipLink.addEventListener('click', function () {
      contentRoot.focus({ preventScroll: true });
    });
    document.body.insertBefore(skipLink, document.body.firstChild);
  }

  // ----- 6. Smooth Scroll for Anchor Links -----
  document.querySelectorAll('a[href^="#"]').forEach(function (a) {
    a.addEventListener('click', function (e) {
      var href = a.getAttribute('href');
      if (href && href.length > 1) {
        var target = document.querySelector(href);
        if (target) {
          e.preventDefault();
          var behavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
          target.scrollIntoView({ behavior: behavior, block: 'start' });
          history.pushState(null, '', href);
        }
      }
    });
  });

});
