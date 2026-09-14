/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Markup for the tab strip hosted by `BundleHost`.
 *
 * The page is loaded once as a data URL and afterwards only receives state
 * through `window.__bundleRender`. It has no preload and no IPC: commands travel
 * back to the main process as `bundle:<json>` console messages, which keeps the
 * strip independent of the workbench service infrastructure.
 */
/**
 * @param topInset Height to keep clear at the top. On macOS the traffic lights
 * are drawn over the window's own top left corner, which is the strip, so the
 * toolbar has to start below them.
 */
export function getSidebarPage(handleWidth: number, topInset: number): string {
	return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
	/* One place for the palette, because the strip has to be able to sit next to
	   a light editor as well as a dark one. */
	:root {
		--bg: #181818; --edge: #2b2b2b; --text: #e4e4e4; --dim: #8a8a8a;
		--faint: #6e6e6e; --hover: #232323; --icon: #a8a8a8; --icon-hover: #2a2a2a;
		--accent: #0078d4; --accent-hover: #1a88e0; --on-accent: #fff;
		--open: #4ec9a3; --attention: #e2c08d;
		--rename-bg: #1e1e1e;
	}
	body.light {
		--bg: #f8f8f8; --edge: #e0e0e0; --text: #1f1f1f; --dim: #6a6a6a;
		--faint: #8a8a8a; --hover: #ececec; --icon: #5a5a5a; --icon-hover: #e4e4e4;
		--accent: #005fb8; --accent-hover: #0a6cc8; --on-accent: #fff;
		--open: #1a7f64; --attention: #9a6a00;
		--rename-bg: #fff;
	}

	/* Derived rather than given: the secondary text on a selected row has to
	   follow whatever that row's foreground turned out to be, and a theme only
	   says the one colour. */
	:root, body.light { --on-accent-dim: color-mix(in srgb, var(--on-accent) 72%, transparent); }

	html, body { margin: 0; height: 100%; background: transparent; overflow: hidden;
		font: 12px -apple-system, system-ui, sans-serif; color: var(--text); user-select: none; cursor: default; }

	/* Left clear for the window controls, and draggable so the strip still
	   behaves like a title bar there. */
	#titlebar { height: ${topInset}px; flex: none; -webkit-app-region: drag; }

	/* Matches the Dark Modern side bar so the strip reads as part of the workbench. */
	#list { position: absolute; top: 0; left: 0; bottom: 0; background: var(--bg); overflow-y: auto;
		border-right: 1px solid var(--edge); display: flex; flex-direction: column; }
	#handle { position: absolute; top: 0; bottom: 0; width: ${handleWidth}px; cursor: col-resize; background: transparent; }
	#handle:hover { background: var(--accent); }

	/* Above the list rather than below it. The strip is narrow, so labels cost
	   more than they explain; the actions are icons and say what they are on
	   hover. Two rows: the first says which columns are showing, the second acts
	   on what is inside this one. */
	#chrome { flex: none; border-bottom: 1px solid var(--edge); padding: 2px 6px 6px; }
	/* One row, wrapping rather than clipping. The strip goes down to 140px and
	   six buttons do not fit there; folding to a second line keeps all of them
	   reachable, which a row that runs off the edge does not. */
	#chrome .bar { display: flex; align-items: center; gap: 2px; flex-wrap: wrap; }
	/* Right, over the gear rather than centred over nothing: the strip itself is
	   what this row acts on, and the edge it folds towards is the right one. */
	#chrome .bar.lead { justify-content: flex-end; }
	#chrome button { display: flex; align-items: center; justify-content: center;
		width: 26px; height: 24px; background: transparent; border: none; border-radius: 5px;
		color: var(--icon); cursor: pointer; padding: 0; }
	#chrome button:hover { background: var(--icon-hover); color: var(--text); }
	/* Available again as soon as the list is showing headings, so it dims rather
	   than disappears: a control that comes and goes is harder to find than one
	   that is there and quiet. */
	#chrome button:disabled { opacity: .35; cursor: default; }
	#chrome button:disabled:hover { background: transparent; color: var(--icon); }
	/* Latched rather than momentary: it changes how the list is ordered until
	   it is pressed again, so it has to look pressed. */
	#chrome button.on { background: var(--accent); color: var(--on-accent); }
	#chrome button.on:hover { background: var(--accent-hover); }
	#chrome svg { width: 16px; height: 16px; fill: none; stroke: currentColor;
		stroke-width: 1.2; stroke-linecap: round; stroke-linejoin: round; }

	#items { flex: 1; overflow-y: auto; padding: 4px 0 12px; }

	/* Folded, the list goes and the actions stay, stacked into a rail. Giving up
	   the list should not also give up the way back to it. */
	#list.collapsed #items { display: none; }
	#list.collapsed #chrome { border-bottom: none; padding: 2px 4px; }
	#list.collapsed #chrome .bar { flex-direction: column; gap: 2px; }

	/* Rows are inset and rounded so the fill reads as a selected card rather
	   than a band across the strip. */
	.row { margin: 1px 6px; padding: 5px 8px; border-radius: 6px; cursor: pointer;
		white-space: nowrap; overflow: hidden; border-top: 2px solid transparent;
		border-bottom: 2px solid transparent; }
	.row:hover { background: var(--hover); }

	/* Two lines: the name, and the path under it. A basename repeats across
	   projects often enough that the name alone does not identify one. */
	.entry { display: grid; grid-template-columns: 7px 1fr auto; column-gap: 6px; align-items: center; }
	.entry.active { background: var(--accent); color: var(--on-accent); }
	/* Enough that a child's name lines up under its group's, rather than
	   starting to the left of the heading it belongs to. */
	.entry.nested { margin-left: 28px; }

	.entry .dot { width: 5px; height: 5px; border-radius: 50%; background: var(--open); }
	.entry.closed .dot { background: transparent; }
	/* Output is arriving in one of this project's terminals. The dot is already
	   this green when the project is open, and the brighter green is spoken for
	   by attention, so on the dot the state is said with movement rather than a
	   third colour: still means open, breathing means working. */
	.entry.running .dot { animation: pulse 1.6s ease-in-out infinite; }
	/* Carried into the label as well. A 5px dot is most of a glance away from
	   nothing, and the strip is read down the names rather than down the dots;
	   whichever project is working should be findable without hunting. Held at
	   the open green so the brighter one still means the work came back. */
	.entry.running .label { color: var(--open); }
	/* The selected row writes its label on the accent, where the open green is
	   too dark to read. Mixed towards the row's own foreground rather than
	   dropped: this state is reported for the tab on screen too. */
	.entry.running.active .label { color: color-mix(in srgb, var(--open) 55%, var(--on-accent)); }
	@keyframes pulse {
		0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--open) 50%, transparent); }
		50% { box-shadow: 0 0 0 4px color-mix(in srgb, var(--open) 0%, transparent); }
	}
	/* Movement at the edge of vision is the part of this that is hard to ignore,
	   so leave the state visible but hold it still when motion is unwelcome. */
	@media (prefers-reduced-motion: reduce) {
		.entry.running .dot { animation: none;
			box-shadow: 0 0 0 3px color-mix(in srgb, var(--open) 25%, transparent); }
	}
	/* Something in this project's terminals rang the bell. A mark rather than a
	   count: the strip cannot say how many, and the answer is the same either
	   way, which is to go and look.

	   Amber, against the green of working, because the pair is read as a change
	   rather than as two colours: the name goes green while the agent runs and
	   amber when it stops, and it is the moment of change that is being watched
	   for. Two greens put that moment where nothing appears to happen. */
	.entry.attention .dot { background: var(--attention);
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--attention) 22%, transparent); }
	.entry.attention .label { color: var(--attention); }
	.entry.attention.active .dot { background: #ffd8a0; box-shadow: none; }
	.entry.attention.active .label { color: color-mix(in srgb, var(--attention) 55%, var(--on-accent)); }
	/* Being asked for is louder than being busy, and a tab can be both: an agent
	   that rings the bell and keeps going. Attention wins, and stops moving.

	   On the label it wins by sitting after the running rules rather than by
	   carrying more classes, which is also how the active row takes its own
	   colour further down. Keep this block below the running one. */
	.entry.attention.running .dot { animation: none; }

	.row .label { font-size: 13px; font-weight: 600; color: var(--text);
		overflow: hidden; text-overflow: ellipsis; }

	/* Closed projects stay on the list but read as inactive. */
	.entry.closed .label { color: var(--dim); font-weight: 500; }
	/* Open but not on the list. Outlined rather than filled: it is here because
	   a window is, not because it was put here. */
	.entry.unlisted .label { font-style: italic; }
	.entry.unlisted .dot { background: transparent; box-shadow: inset 0 0 0 1.5px var(--open); }
	.entry.active .label { color: var(--on-accent); }

	/* Second line, under the name rather than beside it. */
	.entry .path { grid-column: 2 / 4; font: 11px ui-monospace, SFMono-Regular, Menlo, monospace;
		color: var(--faint); overflow: hidden; text-overflow: ellipsis; }
	.entry.active .path { color: var(--on-accent-dim); }

	.row .actions { display: flex; gap: 2px; }
	.row .action { visibility: hidden; color: var(--dim); padding: 0 2px; }
	.row:hover .action { visibility: visible; }
	.row .action:hover { color: var(--text); }
	.entry.active .action { color: var(--on-accent-dim); }

	/* Headings read as headings by weight, not by shouting in capitals. */
	.group { display: flex; align-items: center; gap: 6px; color: var(--text);
		font-size: 12px; font-weight: 600; }
	.group:hover { color: var(--text); }
	.group .twisty { width: 10px; flex: none; color: var(--dim); font-size: 9px; }
	.group .folder { flex: none; opacity: .75; }

	/* Drop feedback: a line for reordering, a fill for dropping into a group. */
	.row.drop-before { border-top-color: var(--accent); }
	.row.drop-after { border-bottom-color: var(--accent); }
	.row.drop-inside { background: var(--accent); opacity: .55; }

	/* Under the actions, in the strip's own chrome rather than floating over the
	   list: it belongs to the list the way the buttons above it do, and a field
	   that covers rows would hide the thing being looked for. */
	#search { padding-top: 6px; }
	#search input { width: 100%; box-sizing: border-box; background: var(--rename-bg);
		color: var(--text); border: 1px solid var(--edge); border-radius: 5px;
		font: inherit; padding: 3px 6px; outline: none; }
	#search input:focus { border-color: var(--accent); }
	/* Folded there is no list to narrow, so the field has nothing to act on. */
	#list.collapsed #search { display: none; }

	/* Said in the list rather than beside the field, where the answer is. */
	.empty { color: var(--faint); padding: 14px 10px; text-align: center; font-size: 11px; }

	.rename { width: 100%; box-sizing: border-box; background: var(--rename-bg); color: var(--text);
		border: 1px solid var(--accent); border-radius: 2px; font: inherit; padding: 1px 4px; }
</style></head><body>
	<div id="list">
		<div id="titlebar"></div>
		<div id="chrome">
			<div class="bar lead">
				<button id="toggle" title="サイドバーを隠す（\u2318\u2303B）">
					<svg viewBox="0 0 16 16"><rect x="1.6" y="2.6" width="12.8" height="10.8" rx="1.6"/><path d="M6.2 2.6v10.8" /><rect x="1.6" y="2.6" width="4.6" height="10.8" rx="1.6" fill="currentColor" stroke="none" opacity=".7"/></svg>
				</button>
			</div>
			<div class="bar">
				<button id="add" title="フォルダーを開いて一覧に追加する">
					<svg viewBox="0 0 16 16"><path d="M1.7 12.9V3.4h3.9l1.2 1.6h7.5v7.9z"/><path d="M8 6.9v4.2M5.9 9h4.2"/></svg>
				</button>
				<button id="group" title="グループを作る">
					<svg viewBox="0 0 16 16"><rect x="1.7" y="2.4" width="12.6" height="4" rx="1.2"/><rect x="1.7" y="9.6" width="12.6" height="4" rx="1.2"/><path d="M4.6 6.4v3.2"/></svg>
				</button>
				<button id="recent" title="最近使った順に並べる">
					<svg viewBox="0 0 16 16"><path d="M3 3.6h10M3 8h7M3 12.4h4"/><path d="M12.4 9.4v3.6M10.9 11.5l1.5 1.5 1.5-1.5"/></svg>
				</button>
				<button id="remote" title="SSH でリモートに接続する">
					<svg viewBox="0 0 16 16"><path d="M6.4 3.6 2.6 8l3.8 4.4"/><path d="M9.6 3.6 13.4 8l-3.8 4.4"/></svg>
				</button>
				<button id="find" title="一覧を絞り込む（\u2318\u2303F）">
					<svg viewBox="0 0 16 16"><circle cx="7" cy="7" r="4.4"/><path d="M10.3 10.3 14 14"/></svg>
				</button>
				<button id="settings" title="プロジェクトとグループを管理">
					<svg viewBox="0 0 16 16"><path d="M2 4.6h3.1M9 4.6h5M2 11.4h5.1M11 11.4h3"/><circle cx="7.1" cy="4.6" r="1.9"/><circle cx="9.1" cy="11.4" r="1.9"/></svg>
				</button>
			</div>
			<div id="search" hidden>
				<input id="query" type="text" placeholder="名前かパスで絞り込む" spellcheck="false" />
			</div>
		</div>
		<div id="items"></div>
	</div>
	<div id="handle" title="ドラッグで幅を変更 / ダブルクリックで開閉"></div>
<script>
(function () {
	var list = document.getElementById('list');
	var items = document.getElementById('items');
	var handle = document.getElementById('handle');
	var toggle = document.getElementById('toggle');
	var recentButton = document.getElementById('recent');
	var recent = false;
	var applied = [];
	var dragging = false;
	var drag = null;
	var editing = false;
	/**
	 * Row order held still while the pointer is over the strip, and the last
	 * state received so it can be laid out again once the pointer leaves.
	 *
	 * Ordering by recency means the row just clicked becomes the first row, and
	 * doing that at the moment of the click takes it out from under the pointer:
	 * whatever was going to be reached for next has moved, and the list has to
	 * be read again from the top. Only the sequence waits — the open dot, the
	 * mark for attention and the names all keep up, because those say what is
	 * happening rather than where to aim.
	 */
	var frozenOrder = null;
	var lastState = null;
	var searchBox = document.getElementById('search');
	var query = document.getElementById('query');
	var findButton = document.getElementById('find');
	var groupButton = document.getElementById('group');
	var filter = '';

	function send(payload) {
		console.log('bundle:' + JSON.stringify(payload));
	}


	/**
	 * Colours the workbench resolved from its theme, laid over the built in
	 * palette. Set on the root rather than merged into it so that dropping back
	 * to light or dark is a matter of clearing them.
	 */
	function applyColors(colors) {
		var style = document.documentElement.style;
		for (var i = 0; i < applied.length; i++) {
			style.removeProperty('--' + applied[i]);
		}
		applied = Object.keys(colors || {});
		for (var j = 0; j < applied.length; j++) {
			style.setProperty('--' + applied[j], colors[applied[j]]);
		}
	}

	//#region rendering

	window.__bundleRender = function (state) {
		list.style.width = state.width + 'px';
		list.classList.toggle('collapsed', state.collapsed);
		handle.style.left = state.width + 'px';
		toggle.title = state.collapsed ? '一覧を表示（\u2318\u2303B）' : '一覧を隠す（\u2318\u2303B）';

		// Kept here rather than on each row: the whole list is either ordered by
		// hand or not, and dragging one row is what would contradict that.
		document.body.classList.toggle('light', state.theme === 'light');
		applyColors(state.colors);

		// Latched the other way round: the column is out unless it has been put
		// away, so the button reads as pressed while it is showing.
		recent = !!state.recent;
		recentButton.classList.toggle('on', recent);
		recentButton.title = recent ? '自分で並べた順に戻す' : '最近使った順に並べる';

		// A group made now would not be drawn: headings are dropped while the
		// order is computed and while the list is narrowed. Said on the button
		// rather than left to be discovered — pressing it and seeing nothing
		// happen is indistinguishable from a broken button, which is how this
		// was reported.
		var groupsShown = !recent && !filter;
		groupButton.disabled = !groupsShown;
		groupButton.title = groupsShown
			? 'グループを作る'
			: (recent ? '最近使った順のあいだはグループを作れません' : '絞り込みのあいだはグループを作れません');

		// Redrawing while a name is being typed would throw the input away
		// mid-edit. The rename itself ends with a render, so nothing is lost.
		if (editing) {
			return;
		}

		lastState = state;

		var rows = filtered(orderedRows(state));

		items.innerHTML = '';
		if (!rows.length) {
			var empty = document.createElement('div');
			empty.className = 'empty';
			empty.textContent = filter ? '\u300c' + filter + '\u300d に一致するものがありません' : '';
			items.appendChild(empty);

			return;
		}
		rows.forEach(function (row) {
			items.appendChild(row.kind === 'group' ? createGroup(row) : createEntry(row));
		});

		// Straight into the name, so the placeholder never has to be found again.
		if (state.rename !== undefined && state.rename !== null) {
			var fresh = items.querySelector('[data-row-key="group:' + state.rename + '"] .label');
			if (fresh) {
				fresh.scrollIntoView({ block: 'nearest' });
				startRename(fresh, { title: fresh.textContent, entry: { type: 'group', id: state.rename } });
			}
		}
	};

	/**
	 * The rows that match what was typed, or all of them when nothing was.
	 *
	 * Names and paths both, because a basename repeats across projects often
	 * enough that the name alone does not identify one — the same reason the
	 * path is drawn under it.
	 *
	 * Groups drop out while filtering. A heading standing over none of its
	 * children, or over one that happened to match, says less than nothing; the
	 * children that match are shown flat, as they are when ordering by recency.
	 */
	function filtered(rows) {
		if (!filter) {
			return rows;
		}

		var needle = filter.toLowerCase();

		return rows.filter(function (row) {
			if (row.kind === 'group') {
				return false;
			}

			var name = (row.title || '').toLowerCase();
			var path = (row.path || '').toLowerCase();

			return name.indexOf(needle) !== -1 || path.indexOf(needle) !== -1;
		}).map(function (row) {
			// Flat, so a child does not sit indented under a heading that is no
			// longer there.
			return row.nested ? Object.assign({}, row, { nested: false }) : row;
		});
	}

	/**
	 * Shows or hides the field. Closing clears it: leaving a filter in place
	 * behind a hidden field is how a list comes to be missing things for
	 * reasons nobody can see.
	 */
	function showSearch(show) {
		searchBox.hidden = !show;
		findButton.classList.toggle('on', show);
		if (show) {
			query.focus();
			query.select();
		} else if (filter) {
			filter = '';
			query.value = '';
			if (lastState) {
				window.__bundleRender(lastState);
			}
		}
	}

	/** What a row is, across renders. Groups and projects can share a number. */
	function rowKey(row) {
		return row.kind === 'group'
			? 'group:' + row.entry.id
			: row.entry.type + ':' + (row.entry.key !== undefined ? row.entry.key : row.entry.id);
	}

	/**
	 * The rows in the order to draw them: as given, unless the sequence is being
	 * held still, in which case the remembered one leads and anything new
	 * follows in the order it arrived.
	 *
	 * Only recency is held. A hand-made order changes when a row is dragged, and
	 * the drag is the one place the answer has to be immediate.
	 */
	function orderedRows(state) {
		if (!recent || !frozenOrder) {
			return state.rows;
		}

		var byKey = {};
		state.rows.forEach(function (row) { byKey[rowKey(row)] = row; });

		var ordered = [];
		frozenOrder.forEach(function (key) {
			if (byKey[key]) {
				ordered.push(byKey[key]);
				delete byKey[key];
			}
		});
		state.rows.forEach(function (row) {
			if (byKey[rowKey(row)]) {
				ordered.push(row);
			}
		});

		return ordered;
	}

	// Held from the moment the pointer arrives, using what is on screen right
	// then — the reorder to be avoided has not happened yet at that point.
	list.addEventListener('mouseenter', function () {
		if (recent && !frozenOrder) {
			frozenOrder = [];
			for (var i = 0; i < items.children.length; i++) {
				var key = items.children[i].dataset.rowKey;
				if (key) {
					frozenOrder.push(key);
				}
			}
		}
	});

	list.addEventListener('mouseleave', function () {
		if (frozenOrder) {
			frozenOrder = null;
			if (lastState) {
				window.__bundleRender(lastState);
			}
		}
	});

	/**
	 * A double click arrives as click, click, dblclick. Acting on the first
	 * click immediately would re-render the strip and destroy the input the
	 * double click is about to create, so the single click waits to be sure.
	 */
	function onClickOrDoubleClick(element, onClick, onDoubleClick) {
		var timer;

		element.onclick = function () {
			clearTimeout(timer);
			timer = setTimeout(onClick, 220);
		};
		element.ondblclick = function (event) {
			event.stopPropagation();
			clearTimeout(timer);
			onDoubleClick();
		};
	}

	function createEntry(row) {
		var element = document.createElement('div');
		element.dataset.rowKey = rowKey(row);
		element.className = 'row entry' + (row.active ? ' active' : '') +
			(row.nested ? ' nested' : '') + (row.open ? '' : ' closed') +
			(row.attention ? ' attention' : '') + (row.running ? ' running' : '') +
			(row.unlisted ? ' unlisted' : '');

		var dot = document.createElement('span');
		dot.className = 'dot';
		element.appendChild(dot);

		var label = document.createElement('span');
		label.className = 'label';
		label.appendChild(document.createTextNode(row.title));
		element.appendChild(label);

		var actions = document.createElement('span');
		actions.className = 'actions';
		element.appendChild(actions);

		// Every row gets one, so the button never appears to come and go. It acts
		// on whatever is nearest: a window if one is open, otherwise the entry
		// itself. Forgetting a project while its window is up would drop it from
		// the list and leave the window behind as a row with no workspace, which
		// reads as having lost the project rather than having closed it.
		var closeId = row.entry.type === 'tab' ? row.entry.id : (row.open ? row.tabId : undefined);

		var remove = document.createElement('span');
		remove.className = 'action';
		remove.textContent = '\u00D7';
		remove.title = closeId === undefined ? '一覧から削除' : 'ウィンドウを閉じる';
		remove.onclick = function (event) {
			event.stopPropagation();
			send(closeId === undefined
				? { cmd: 'remove', key: row.key }
				: { cmd: 'closeTab', id: closeId });
		};
		actions.appendChild(remove);

		// A wedged remote is the usual reason to want this, and closing and
		// opening again costs the window's state. Only shown where there is a
		// window to reload.
		if (closeId !== undefined) {
			var reload = document.createElement('span');
			reload.className = 'action';
			reload.textContent = '\u21BB';
			reload.title = 'ウィンドウを再読み込み';
			reload.onclick = function (event) {
				event.stopPropagation();
				send({ cmd: 'reloadTab', id: closeId });
			};
			actions.appendChild(reload);
		}

		// Placeholder rows have no workspace, so there is no path to show and the
		// row stays a single line.
		if (row.path) {
			var path = document.createElement('span');
			path.className = 'path';
			path.textContent = row.path;
			path.title = row.path;
			element.appendChild(path);
		}

		element.oncontextmenu = function (event) {
			event.preventDefault();
			send({ cmd: 'contextMenu', key: row.key, tabId: closeId });
		};

		onClickOrDoubleClick(element,
			function () { send({ cmd: 'open', entry: row.entry }); },
			function () {
				// A window with no workspace is recognised by nothing, so a name
				// would have nowhere to live once it closed. Better not to offer
				// the field than to take a name and drop it.
				if (row.entry.type === 'tab' && !row.key) {
					return;
				}
				startRename(label, row);
			});
		makeDraggable(element, row);

		return element;
	}

	function createGroup(row) {
		var element = document.createElement('div');
		element.dataset.rowKey = rowKey(row);
		element.className = 'row group';

		var twisty = document.createElement('span');
		twisty.className = 'twisty';
		twisty.textContent = row.collapsed ? '\\u25B8' : '\\u25BE';
		element.appendChild(twisty);

		var folder = document.createElement('span');
		folder.className = 'folder';
		folder.textContent = row.collapsed ? '\\u{1F4C1}' : '\\u{1F4C2}';
		element.appendChild(folder);

		var label = document.createElement('span');
		label.className = 'label';
		label.textContent = row.title;
		element.appendChild(label);

		// Groups outlive their contents otherwise: emptying one leaves a heading
		// with no way to be rid of it. Removing keeps the projects, at top level.
		var remove = document.createElement('span');
		remove.className = 'action';
		remove.textContent = '\u00D7';
		remove.title = 'グループを削除（中のプロジェクトは残ります）';
		remove.onclick = function (event) {
			event.stopPropagation();
			send({ cmd: 'removeGroup', id: row.entry.id });
		};
		element.appendChild(remove);

		element.oncontextmenu = function (event) {
			event.preventDefault();
			send({ cmd: 'contextMenu', groupId: row.entry.id });
		};

		onClickOrDoubleClick(element,
			function () { send({ cmd: 'toggleGroup', id: row.entry.id }); },
			function () { startRename(label, row); });
		makeDraggable(element, row);

		return element;
	}

	//#endregion

	//#region rename

	function startRename(element, row) {
		editing = true;

		var input = document.createElement('input');
		input.className = 'rename';
		input.value = row.title;
		element.textContent = '';
		element.appendChild(input);
		input.focus();
		input.select();

		var done = false;
		function commit(save) {
			if (done) {
				return;
			}
			done = true;
			editing = false;
			send(save && input.value.trim()
				? { cmd: 'rename', entry: row.entry, name: input.value.trim() }
				: { cmd: 'refresh' });
		}

		input.onblur = function () { commit(true); };
		input.onkeydown = function (event) {
			if (event.key === 'Enter') { commit(true); }
			if (event.key === 'Escape') { commit(false); }
			event.stopPropagation();
		};
	}

	//#endregion

	//#region drag and drop

	function makeDraggable(element, row) {
		// Nothing to save a new arrangement into while the order is computed, and
		// nothing sensible to write while most of the list is hidden: dropping
		// between two rows that happen to match says nothing about where the row
		// belongs among the ones that do not.
		if (recent || filter) {
			return;
		}

		element.draggable = true;

		element.ondragstart = function (event) {
			drag = row.entry;
			event.dataTransfer.effectAllowed = 'move';
			// Firefox style browsers need data set for the drag to start at all.
			event.dataTransfer.setData('text/plain', JSON.stringify(row.entry));
		};
		element.ondragend = function () {
			drag = null;
			clearDropFeedback();
		};

		element.ondragover = function (event) {
			if (!drag || JSON.stringify(drag) === JSON.stringify(row.entry)) {
				return;
			}
			event.preventDefault();
			clearDropFeedback();

			// A tab dropped on the middle of a group goes inside it; anywhere else
			// reorders relative to the row under the pointer.
			var bounds = element.getBoundingClientRect();
			var offset = (event.clientY - bounds.top) / bounds.height;
			var position = row.entry.type === 'group' && drag.type !== 'group' && offset > 0.25 && offset < 0.75
				? 'inside'
				: (offset < 0.5 ? 'before' : 'after');

			element.classList.add('drop-' + position);
			element.dataset.dropPosition = position;
		};
		element.ondragleave = function () { clearDropFeedback(); };

		element.ondrop = function (event) {
			event.preventDefault();
			if (!drag) {
				return;
			}
			send({
				cmd: 'move',
				drag: drag,
				target: row.entry,
				position: element.dataset.dropPosition || 'after'
			});
			drag = null;
			clearDropFeedback();
		};
	}

	function clearDropFeedback() {
		Array.prototype.forEach.call(items.querySelectorAll('.row'), function (row) {
			row.classList.remove('drop-before', 'drop-after', 'drop-inside');
		});
	}

	// Dropping past the last row moves the item to the end of the top level.
	items.ondragover = function (event) { if (drag) { event.preventDefault(); } };
	items.ondrop = function (event) {
		if (drag && event.target === items) {
			send({ cmd: 'move', drag: drag, position: 'after' });
			drag = null;
		}
	};

	//#endregion

	//#region chrome

	document.getElementById('add').onclick = function () { send({ cmd: 'openFolder' }); };
	// A folder comes from a dialog, but an address has to be typed, and the
	// strip has nowhere to type. The settings window already holds the list.
	// The host list is drawn as a native menu rather than in the page: it comes
	// from a file the page cannot read, and there can be a hundred entries.
	document.getElementById('remote').onclick = function () { send({ cmd: 'openRemote' }); };
	document.getElementById('group').onclick = function () { send({ cmd: 'newGroup' }); };
	document.getElementById('settings').onclick = function () { send({ cmd: 'openManager' }); };
	toggle.onclick = function () { send({ cmd: 'toggle' }); };
	recentButton.onclick = function () { send({ cmd: 'toggleRecent' }); };

	findButton.onclick = function () { showSearch(searchBox.hidden); };

	query.oninput = function () {
		filter = query.value.trim();
		if (lastState) {
			window.__bundleRender(lastState);
		}
	};

	query.onkeydown = function (event) {
		if (event.key === 'Escape') {
			showSearch(false);
		}
		// Enter takes the top match. With the list narrowed to what was asked
		// for, reaching for the mouse to click the only row left is a step that
		// says nothing.
		if (event.key === 'Enter') {
			var first = items.querySelector('.entry');
			if (first) {
				first.click();
				// Enter says "that one", so the narrowing has done its job. A
				// click says "show me", and leaves the list as it is.
				showSearch(false);
			}
		}
	};

	// Opened from anywhere, including a workbench that has the keyboard. The
	// host forwards the chord; matching Cmd+Ctrl+B keeps the strip's own
	// shortcuts together rather than scattered across the modifier space.
	window.__bundleFind = function () { showSearch(true); };

	handle.addEventListener('mousedown', function (event) {
		dragging = true;
		event.preventDefault();
		send({ cmd: 'resizeStart' });
	});
	handle.addEventListener('dblclick', function () { send({ cmd: 'toggle' }); });

	window.addEventListener('mousemove', function (event) {
		if (dragging) {
			send({ cmd: 'resize', x: Math.round(event.clientX) });
		}
	});
	window.addEventListener('mouseup', function () {
		if (dragging) {
			dragging = false;
			send({ cmd: 'resizeEnd' });
		}
	});

	//#endregion
}());
</script>
</body></html>`;
}
