/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Markup for the settings window.
 *
 * Same arrangement as the strip: loaded once, fed state through
 * `window.__bundleRender`, and reporting back as `bundle:<json>` console
 * messages.
 *
 * Sectioned rather than a single screen. It opens from a gear, so it has to
 * look like somewhere settings live; arriving straight in a table of projects
 * left no room for anything that was not a project, and there is now a theme to
 * put somewhere.
 */
/**
 * @param leftInset Width to keep clear on the left of the heading. The window
 * hides its title bar, so on macOS the traffic lights are drawn over the
 * content's own top left corner, which is where the heading starts.
 */
/**
 */
export function getManagerPage(leftInset: number): string {
	return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
	:root {
		--bg: #1f1f1f; --panel: #191919; --edge: #2b2b2b; --text: #e4e4e4; --dim: #9a9a9a;
		--faint: #7a7a7a; --hover: #262626; --field: #2a2a2a; --field-edge: #3a3a3a;
		--accent: #0078d4; --accent-hover: #1a88e0; --on-accent: #fff; --open: #4ec9a3;
	}
	body.light {
		--bg: #fff; --panel: #f3f3f3; --edge: #e0e0e0; --text: #1f1f1f; --dim: #5a5a5a;
		--faint: #767676; --hover: #ececec; --field: #fff; --field-edge: #cecece;
		--accent: #005fb8; --accent-hover: #0a6cc8; --on-accent: #fff; --open: #1a7f64;
	}

	html, body { margin: 0; height: 100%; background: var(--window-bg, var(--bg)); color: var(--text);
		overflow: hidden; font: 13px -apple-system, system-ui, sans-serif; user-select: none; }
	#frame { display: flex; flex-direction: column; height: 100%; }

	h1 { font-size: 13px; font-weight: 600; margin: 0; padding: 12px 16px 12px ${16 + leftInset}px;
		color: var(--text); border-bottom: 1px solid var(--edge); -webkit-app-region: drag; }

	#body { flex: 1; display: flex; min-height: 0; }

	/* A list of sections rather than tabs across the top: sections will be added
	   over time and a column grows downwards without rearranging itself. */
	#nav { width: 168px; flex: none; background: var(--panel); border-right: 1px solid var(--edge);
		padding: 8px 6px; display: flex; flex-direction: column; gap: 2px; }
	#nav button { display: block; width: 100%; text-align: left; background: transparent;
		border: none; border-radius: 5px; color: var(--dim); font: inherit; padding: 6px 10px;
		cursor: pointer; }
	#nav button:hover { background: var(--hover); color: var(--text); }
	#nav button.on { background: var(--accent); color: var(--on-accent); }

	#panes { flex: 1; overflow-y: auto; min-width: 0; }
	.pane { display: none; padding: 16px; }
	.pane.on { display: block; }

	h2 { font-size: 12px; font-weight: 600; margin: 0 0 2px; color: var(--text); }
	h3 { font-size: 11px; font-weight: 600; margin: 18px 0 4px; color: var(--faint);
		text-transform: uppercase; letter-spacing: .04em; }
	.hint { color: var(--faint); font-size: 11px; margin: 0 0 14px; line-height: 1.5; }

	/* Appearance */
	.choice { display: flex; gap: 6px; }
	.choice button { flex: 1; background: var(--field); border: 1px solid var(--field-edge);
		border-radius: 5px; color: var(--text); font: inherit; padding: 8px 6px; cursor: pointer; }
	.choice button:hover { border-color: var(--accent); }
	.choice button.on { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }

	/* Projects */
	#head, .row { display: grid; grid-template-columns: 18px 1fr 132px 2fr 22px; gap: 8px;
		align-items: center; padding: 5px 8px; }
	#head { color: var(--faint); font-size: 11px; text-transform: uppercase; letter-spacing: .04em;
		border-bottom: 1px solid var(--edge); }
	#rows { padding: 2px 0; }
	.row { border-radius: 5px; border-top: 2px solid transparent; border-bottom: 2px solid transparent; }
	.row:hover { background: var(--hover); }
	.row.drop-before { border-top-color: var(--accent); }
	.row.drop-after { border-bottom-color: var(--accent); }

	.grip { cursor: grab; color: var(--faint); text-align: center; }
	.name { background: transparent; border: 1px solid transparent; border-radius: 4px;
		color: var(--text); font: inherit; padding: 3px 6px; width: 100%; box-sizing: border-box; }
	.name:hover { border-color: var(--field-edge); }
	.name:focus { border-color: var(--accent); background: var(--field); outline: none; }

	select { background: var(--field); border: 1px solid var(--field-edge); border-radius: 4px;
		color: var(--text); font: inherit; padding: 3px 4px; width: 100%; }

	/* Plain direction. Reversing it to keep the tail in view drags the leading
	   tilde to the far end, which reads as a different path. */
	.path { color: var(--faint); font-size: 11px; overflow: hidden; text-overflow: ellipsis;
		white-space: nowrap; user-select: text; }

	.remove { color: var(--faint); cursor: pointer; text-align: center; }
	.remove:hover { color: var(--text); }
	.open { color: var(--open); }

	#groups .grow { display: flex; align-items: center; gap: 8px; padding: 2px 0; }

	/* Bookmarks. No grip: the column beside the strip is where order is chosen,
	   and repeating drag-to-reorder here would give two places to disagree. */

	/* Adding belongs to the section it adds to, not to the window. */
	#paneActions { display: flex; gap: 8px; padding-top: 12px; }

	/* Only while it is being used. A field standing open would read as something
	   left unfinished every time the window is opened for anything else. */

	#foot { display: flex; gap: 8px; padding: 10px 16px; border-top: 1px solid var(--edge); }
	button.action { background: var(--field); border: 1px solid var(--field-edge); border-radius: 5px;
		color: var(--text); font: inherit; padding: 5px 12px; cursor: pointer; }
	button.action:hover { border-color: var(--accent); }
	button.primary { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
	button.primary:hover { background: var(--accent-hover); }
	.spacer { flex: 1; }
	.empty { color: var(--faint); padding: 20px 8px; text-align: center; }
</style></head><body>
	<div id="frame">
		<h1>設定</h1>
		<div id="body">
			<div id="nav">
				<button data-pane="appearance" class="on">外観</button>
				<button data-pane="projects">プロジェクト</button>
			</div>
			<div id="panes">
				<div class="pane on" id="pane-appearance">
					<h2>テーマ</h2>
					<p class="hint">サイドバーとこの画面の配色。「エディターに合わせる」は、
						表示中のワークスペースのテーマが明るいか暗いかに追従します。</p>
					<div class="choice" id="theme">
						<button data-theme="auto">エディターに合わせる</button>
						<button data-theme="light">ライト</button>
						<button data-theme="dark">ダーク</button>
					</div>
				</div>
				<div class="pane" id="pane-projects">
					<h2>プロジェクトとグループ</h2>
					<p class="hint">名前はその場で書き換えられます。グリップをつかむと並べ替え、
						プルダウンでグループを移せます。</p>
					<div id="head"><span></span><span>名前</span><span>グループ</span><span>パス / URL</span><span></span></div>
					<div id="rows"></div>
					<h3>グループ</h3>
					<div id="groups"></div>
					<div id="paneActions">
						<button id="addProject" class="action">＋ プロジェクト</button>
						<button id="addGroup" class="action">＋ グループ</button>
					</div>
				</div>
			</div>
		</div>
		<div id="foot">
			<button id="settings" class="action" title="VS Code 本体の設定">settings.json</button>
			<span class="spacer"></span>
			<button id="close" class="action primary">閉じる</button>
		</div>
	</div>
<script>
(function () {
	var rows = document.getElementById('rows');
	var groupList = document.getElementById('groups');
	var drag = null;
	var groups = [];
	var applied = [];

	function send(payload) {
		console.log('bundle:' + JSON.stringify(payload));
	}

	window.__bundleRender = function (state) {
		document.body.classList.toggle('light', state.theme === 'light');
		applyColors(state.colors);
		renderTheme(state.themeSetting);
		groups = state.groups;
		renderRows(state.projects);
		renderGroups(state.groups);


		// Sent only by whoever asked for the window, so an ordinary redraw does
		// not pull the reader back to a section they navigated away from.
		if (state.section) {
			selectPane(state.section);
		}
	};


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

	//#region sections

	function selectPane(name) {
		Array.prototype.forEach.call(document.querySelectorAll('#nav button'), function (button) {
			button.classList.toggle('on', button.dataset.pane === name);
		});
		Array.prototype.forEach.call(document.querySelectorAll('.pane'), function (pane) {
			pane.classList.toggle('on', pane.id === 'pane-' + name);
		});
	}

	Array.prototype.forEach.call(document.querySelectorAll('#nav button'), function (button) {
		button.onclick = function () { selectPane(button.dataset.pane); };
	});

	//#endregion

	//#region appearance

	function renderTheme(setting) {
		Array.prototype.forEach.call(document.querySelectorAll('#theme button'), function (button) {
			button.classList.toggle('on', button.dataset.theme === (setting || 'auto'));
			button.onclick = function () { send({ cmd: 'setTheme', theme: button.dataset.theme }); };
		});
	}

	//#endregion

	//#region projects

	function renderRows(projects) {
		rows.innerHTML = '';

		if (!projects.length) {
			var empty = document.createElement('div');
			empty.className = 'empty';
			empty.textContent = 'プロジェクトがありません。「＋ プロジェクト」から追加してください。';
			rows.appendChild(empty);
			return;
		}

		projects.forEach(function (project) {
			rows.appendChild(createRow(project));
		});
	}

	function createRow(project) {
		var row = document.createElement('div');
		row.className = 'row';

		var grip = document.createElement('span');
		grip.className = 'grip' + (project.open ? ' open' : '');
		grip.textContent = project.open ? '\\u25CF' : '\\u2261';
		grip.title = project.open ? '開いています' : 'ドラッグで並べ替え';
		row.appendChild(grip);

		var name = document.createElement('input');
		name.className = 'name';
		name.value = project.name;
		name.onchange = function () { send({ cmd: 'rename', entry: project.entry, name: name.value.trim() }); };
		name.onkeydown = function (event) { if (event.key === 'Enter') { name.blur(); } };
		row.appendChild(name);

		var select = document.createElement('select');
		select.appendChild(new Option('（なし）', ''));
		groups.forEach(function (group) {
			select.appendChild(new Option(group.name, String(group.id), false, group.id === project.groupId));
		});
		select.value = project.groupId === undefined ? '' : String(project.groupId);
		select.onchange = function () {
			send({ cmd: 'assignGroup', key: project.key, groupId: select.value === '' ? null : Number(select.value) });
		};
		row.appendChild(select);

		var path = document.createElement('div');
		path.className = 'path';
		path.textContent = project.path;
		path.title = project.path;
		row.appendChild(path);

		var remove = document.createElement('span');
		remove.className = 'remove';
		remove.textContent = '\\u00D7';
		remove.title = '一覧から削除';
		remove.onclick = function () { send({ cmd: 'remove', key: project.key }); };
		row.appendChild(remove);

		makeDraggable(row, project, grip);

		return row;
	}

	function makeDraggable(row, project, grip) {
		// Only the grip starts a drag, so the name field stays selectable.
		grip.onmousedown = function () { row.draggable = true; };
		row.onmouseup = function () { row.draggable = false; };

		row.ondragstart = function (event) {
			drag = project;
			event.dataTransfer.effectAllowed = 'move';
			event.dataTransfer.setData('text/plain', project.key);
		};
		row.ondragend = function () {
			drag = null;
			row.draggable = false;
			clearFeedback();
		};
		row.ondragover = function (event) {
			if (!drag || drag.key === project.key) {
				return;
			}
			event.preventDefault();
			clearFeedback();

			var bounds = row.getBoundingClientRect();
			var position = (event.clientY - bounds.top) / bounds.height < 0.5 ? 'before' : 'after';
			row.classList.add('drop-' + position);
			row.dataset.dropPosition = position;
		};
		row.ondragleave = clearFeedback;
		row.ondrop = function (event) {
			event.preventDefault();
			if (drag) {
				send({
					cmd: 'move',
					drag: drag.entry,
					target: project.entry,
					position: row.dataset.dropPosition || 'after'
				});
			}
			drag = null;
			clearFeedback();
		};
	}

	function clearFeedback() {
		Array.prototype.forEach.call(rows.querySelectorAll('.row'), function (row) {
			row.classList.remove('drop-before', 'drop-after');
		});
	}

	//#endregion

	//#region groups

	function renderGroups(list) {
		groupList.innerHTML = '';

		list.forEach(function (group) {
			var line = document.createElement('div');
			line.className = 'grow';

			var name = document.createElement('input');
			name.className = 'name';
			name.value = group.name;
			name.onchange = function () { send({ cmd: 'rename', entry: group.entry, name: name.value.trim() }); };
			name.onkeydown = function (event) { if (event.key === 'Enter') { name.blur(); } };
			line.appendChild(name);

			var remove = document.createElement('span');
			remove.className = 'remove';
			remove.textContent = '\\u00D7';
			remove.title = 'グループを削除（中のプロジェクトは残ります）';
			remove.onclick = function () { send({ cmd: 'removeGroup', id: group.id }); };
			line.appendChild(remove);

			groupList.appendChild(line);
		});
	}

	//#endregion

	document.getElementById('addProject').onclick = function () { send({ cmd: 'openFolder' }); };
	document.getElementById('addGroup').onclick = function () { send({ cmd: 'newGroup' }); };

	document.getElementById('settings').onclick = function () { send({ cmd: 'openSettings' }); };
	document.getElementById('close').onclick = function () { send({ cmd: 'closeManager' }); };
}());
</script>
</body></html>`;
}
