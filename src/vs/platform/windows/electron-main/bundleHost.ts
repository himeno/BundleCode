/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import electron from 'electron';
import { onUnexpectedError } from '../../../base/common/errors.js';
import { isMacintosh } from '../../../base/common/platform.js';
import { URI } from '../../../base/common/uri.js';
import { EventEmitter } from 'events';
import { getSidebarPage } from './bundleSidebarPage.js';
import { getManagerPage } from './bundleManagerPage.js';
import { collectSshHosts, defaultSshConfigPath, readSshConfig } from './bundleSshConfig.js';
import { installUpdate, updateInProgress } from './bundleInstall.js';
import { BUNDLE_UPDATE_PROGRESS_CHANNEL } from '../common/bundleUpdate.js';

/**
 * Hosts several workbench renderers inside a single native window.
 *
 * Every workspace keeps its own `WebContentsView` (and therefore its own
 * extension host), exactly as it would in a standalone window. Only one view is
 * attached to the host window at a time, so switching is a view swap: no
 * reload, no state loss, and no change to the extension host architecture.
 *
 * The strip lists *projects*, not open tabs. A project stays on the list after
 * its window is closed and reopens on click, which is what makes the strip a
 * place to organise work rather than a view of what happens to be open.
 *
 * `CodeWindow` expects an `electron.BrowserWindow`, so each tab is handed a
 * facade that forwards content level calls to its own view and window level
 * calls to the shared host window.
 */

const DEFAULT_SIDEBAR_WIDTH = 260;
const MIN_SIDEBAR_WIDTH = 140;
const MAX_SIDEBAR_WIDTH = 600;

/**
 * Width of the drag strip on the right edge of the tab list. When the sidebar is
 * collapsed only this strip remains, so there is always something to grab.
 */
const HANDLE_WIDTH = 6;

/**
 * Width the strip keeps when its list is folded away. The actions stay on
 * screen rather than going with the list: folding is about making room for the
 * workbench, not about giving up the way back to the projects.
 */
const RAIL_WIDTH = 44;

/** Clearance for the macOS window controls above the strip's toolbar. */
const TITLEBAR_INSET = 38;

/**
 * Width the traffic lights occupy on macOS when a window hides its title bar.
 * Content that starts at the top left has to begin after them.
 */
const TRAFFIC_LIGHT_INSET = 78;

const SAVE_DELAY = 500;

/**
 * How many ssh hosts the remote menu leads with. Enough for the machines in
 * rotation, few enough that the list stays readable at a glance — past that it
 * stops being a shortcut and becomes a second copy of the full list.
 */
const RECENT_REMOTE_HOSTS = 6;

/** Ids must not collide with real `BrowserWindow` ids. */
let nextRuntimeId = 100_000;

interface IBundleTab {
	readonly id: number;
	view: electron.WebContentsView;
	readonly emitter: EventEmitter;
	readonly facade: electron.BrowserWindow;
	/** Title reported by the renderer. */
	title: string;
	/** Identifies the project; undefined until the window configuration is known. */
	workspaceKey: string | undefined;
	/**
	 * When this tab was last switched to. Held here as well as on the project so
	 * that a window which is open but not on the list can take part in the
	 * recency order. It is not persisted: an unlisted window is not remembered
	 * at all, so there is nothing for a time to belong to once it closes.
	 */
	lastActive: number | undefined;
	attached: boolean;
	/** Something in this tab asked to be looked at. Cleared by looking at it. */
	attention: boolean;
	/**
	 * A terminal in this tab is busy. Unlike attention this is a state the
	 * renderer reports both ends of, so it is never cleared by looking.
	 */
	running: boolean;
}

/**
 * Something the user has opened at least once. Outlives its window.
 *
 */
interface IBundleProject {
	readonly key: string;
	name: string | undefined;
	/** When it was last switched to. Absent until it has been. */
	lastActive: number | undefined;
}

interface IBundleGroup {
	readonly id: number;
	name: string;
	collapsed: boolean;
	children: EntryRef[];
}

/**
 * An entry in the strip. Groups hold projects, and nesting stops there: one
 * level is enough to organise work without turning reordering into a tree
 * editing problem. `tab` covers windows that have no workspace yet, which
 * cannot be remembered and so are never persisted.
 */
type EntryRef =
	| { readonly type: 'project'; readonly key: string }
	| { readonly type: 'group'; readonly id: number }
	| { readonly type: 'tab'; readonly id: number };

/**
 * Layout as written to disk. Projects are keyed by workspace rather than by
 * runtime id, because ids are handed out per session while the strip has to
 * recognise the same project again after a restart.
 */
interface IPersistedLayout {
	readonly width: number;
	readonly collapsed: boolean;
	readonly groups: { readonly id: number; readonly name: string; readonly collapsed: boolean }[];
	readonly order: ({ readonly kind: 'group'; readonly id: number } | { readonly kind: 'project'; readonly key: string })[];
	readonly members: { readonly groupId: number; readonly keys: string[] }[];
	readonly names: { readonly key: string; readonly name: string }[];
	/** Ordering by recency rather than by hand. */
	readonly recent?: boolean;
	readonly theme?: 'auto' | 'light' | 'dark';
	readonly lastActive?: { readonly key: string; readonly time: number }[];
	/** When each ssh host was last connected to, so the menu can lead with them. */
	readonly remoteHosts?: { readonly host: string; readonly time: number }[];
}

/** Opens a workspace in a new tab. Injected because `BundleHost` predates the services. */
let projectOpener: ((key: string) => void) | undefined;

/** Opens the user settings file for editing. Injected for the same reason. */
let settingsOpener: (() => void) | undefined;

/** Opens an empty window connected to an ssh host. Injected for the same reason. */
let remoteOpener: ((host: string) => void) | undefined;

/** Opens a file on disk for editing. Injected for the same reason. */
let fileOpener: ((path: string) => void) | undefined;

/** Reads and writes the persisted layout. Injected for the same reason. */
let stateStore: { read(): IPersistedLayout | undefined; write(layout: IPersistedLayout): void } | undefined;

/**
 * Reloads a tab's window. Injected rather than reloading the view directly,
 * because a window reload is more than fetching the same URL again: the
 * configuration is rebuilt first, and only `CodeWindow` knows how.
 */
let tabReloader: ((tabId: number) => void) | undefined;

export class BundleHost {

	private static instance: BundleHost | undefined;

	static getInstance(options: electron.BrowserWindowConstructorOptions): BundleHost {
		if (!BundleHost.instance) {
			BundleHost.instance = new BundleHost(options);
		}

		return BundleHost.instance;
	}

	/**
	 * Web contents of every hosted workbench. Security checks that enumerate
	 * `BrowserWindow.getAllWindows()` to recognise trusted frames need these as
	 * well, because a hosted workbench has no window of its own.
	 */
	static getAllTabWebContents(): electron.WebContents[] {
		return BundleHost.instance?.tabs.map(tab => tab.view.webContents) ?? [];
	}

	/** Wired up once the windows service exists, so the strip can open projects. */
	static setProjectOpener(opener: (key: string) => void): void {
		projectOpener = opener;
	}

	static setSettingsOpener(opener: () => void): void {
		settingsOpener = opener;
	}

	static setRemoteOpener(opener: (host: string) => void): void {
		remoteOpener = opener;
	}

	static setFileOpener(opener: (path: string) => void): void {
		fileOpener = opener;
	}

	static setStateStore(store: { read(): IPersistedLayout | undefined; write(layout: IPersistedLayout): void }): void {
		stateStore = store;
	}

	static setTabReloader(reloader: (tabId: number) => void): void {
		tabReloader = reloader;
	}

	/**
	 * Tells the strip which project a tab belongs to. Called once the window
	 * configuration is known, which is after the tab itself has been created.
	 *
	 * `restored` separates the windows that come back on their own at startup
	 * from the ones somebody asked for, which is the difference between leaving
	 * the recency order alone and being the newest thing in it.
	 */
	static setTabWorkspace(tabId: number, key: string | undefined, restored: boolean): void {
		BundleHost.instance?.assignWorkspace(tabId, key, restored);
	}

	private readonly host: electron.BrowserWindow;
	private readonly sidebar: electron.WebContentsView;
	private readonly tabs: IBundleTab[] = [];
	private activeTab: IBundleTab | undefined;

	private readonly projects = new Map<string, IBundleProject>();
	private readonly groups = new Map<number, IBundleGroup>();

	/** Display order of the top level. Entries inside a group live in `group.children`. */
	private order: EntryRef[] = [];

	private sidebarWidth = DEFAULT_SIDEBAR_WIDTH;
	private collapsed = false;

	/**
	 * Order by when a project was last switched to, newest first, instead of by
	 * the arrangement the user built. Flattens groups while it is on: a heading
	 * between the newest and the next newest would defeat the point of asking
	 * for the newest.
	 */
	private recent = false;

	/**
	 * Which palette the strip draws itself in. `auto` follows the workbench,
	 * which is the only one of the three the strip cannot answer on its own.
	 */
	private theme: 'auto' | 'light' | 'dark' = 'auto';

	/** What the workbench last reported. Only consulted while `theme` is `auto`. */
	private workbenchTheme: 'light' | 'dark' = 'dark';

	/**
	 * Colours the workbench resolved from its theme. Passed on only while
	 * following it; asking for light or dark is asking for the strip's own
	 * palette, not for an approximation of somebody's extension.
	 */
	private workbenchColors: Record<string, string> = {};

	/**
	 * While the width is being dragged the sidebar is stretched across the whole
	 * window. Without that the pointer would leave the view as soon as it crossed
	 * into the workbench and the drag would stall.
	 */
	private resizing = false;

	private sidebarReady = false;

	/**
	 * Vertical space the window controls take at the top left. With a custom
	 * title bar the traffic lights are drawn over the window corner, which now
	 * belongs to the strip rather than to a workbench.
	 */
	private readonly topInset: number;

	private saveHandle: ReturnType<typeof setTimeout> | undefined;

	/** Separate window so paths and group membership have room to be edited. */
	private manager: electron.BrowserWindow | undefined;

	/**
	 * Address bar for sites. One view reused across every site rather than one
	 * per tab: only the visible site can be typed into, so the rest would be
	 * renderers kept alive to show a field nobody can reach.
	 */

	/**
	 * A group that has just been made and should open for renaming. Consumed by
	 * the render it causes, so a later render does not reopen the field over
	 * whatever is being done by then.
	 */
	private renameOnArrival: number | undefined;

	/** ssh host to when it was last connected to. Orders the remote menu. */
	private readonly remoteHosts = new Map<string, number>();


	/** Section the manager should show next. Consumed by the render it causes. */
	private managerSection: string | undefined;

	private constructor(options: electron.BrowserWindowConstructorOptions) {

		// The host owns the native window. Its own web contents stay empty:
		// everything the user sees comes from child views.
		//
		// `show` is passed through deliberately. defaultBrowserWindowOptions only
		// withholds it for maximized and fullscreen windows, which CodeWindow then
		// shows itself; forcing it off here leaves the window invisible forever in
		// a packaged build, where the "show it anyway after N seconds" safety net
		// in CodeWindow does not run.
		this.host = new electron.BrowserWindow(options);
		this.topInset = isMacintosh && options.titleBarStyle === 'hidden' ? TITLEBAR_INSET : 0;

		this.sidebar = new electron.WebContentsView({
			webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true }
		});
		// Transparent so the stretched overlay used while resizing does not hide
		// the workbench underneath it.
		this.sidebar.setBackgroundColor('#00000000');
		this.host.contentView.addChildView(this.sidebar);

		// The sidebar reports interaction through console messages. That keeps the
		// strip free of preload scripts and IPC channel registration, which matters
		// because it is not a workbench and has no services.
		this.sidebar.webContents.on('console-message', event => this.onSidebarMessage(event.message));
		this.sidebar.webContents.on('did-finish-load', () => {
			this.sidebarReady = true;
			this.pushSidebarState();
		});

		this.host.on('resize', () => this.layout());
		this.host.on('closed', () => {
			BundleHost.instance = undefined;
		});

		this.restore();
		this.registerHostEvents();
		this.loadSidebarShell();
	}

	//#region messages

	/**
	 * @param source Tab the message came from, when it came from a workbench
	 * rather than from one of the strip's own pages. Lets a renderer report
	 * about itself without having to know which project it is.
	 */
	private onSidebarMessage(message: string, source?: IBundleTab): void {
		if (!message.startsWith('bundle:')) {
			return;
		}

		let payload: { cmd: string;[key: string]: unknown };
		try {
			payload = JSON.parse(message.slice('bundle:'.length));
		} catch {
			return;
		}

		switch (payload.cmd) {
			case 'open':
				return this.openEntry(payload.entry as EntryRef);
			case 'remove':
				return this.forget(payload.key as string);
			case 'closeTab':
				return this.closeTab(payload.id as number);
			case 'listProject':
				return this.listProject(payload.key as string);
			case 'contextMenu':
				return this.showContextMenu(payload);
			case 'attention':
				return this.flagAttention(source);
			case 'running':
				return this.flagRunning(source, !!payload.value);
			case 'looked':
				return this.clearAttention(source);
			case 'installUpdate':
				// 失敗は `failed` として配信に乗るので、ここで拾うものは残らない。
				// **モーダルには戻さないこと** — 読んで閉じるしかない出し方だと、
				// 落とせた分が残っているのに続きから取り直す道が出ない。
				installUpdate(payload.url as string, payload.version as string | undefined).catch(onUnexpectedError);
				return;
			case 'updateStatus': {
				// 配信は起きた瞬間にしか流れない。更新の途中で開いたタブはそれを
				// 聞いていないので、自分から訊く。**訊かないと、既に走っている更新を
				// もう一度持ちかけることになる。**
				const progress = updateInProgress();
				if (progress && source && !source.view.webContents.isDestroyed()) {
					source.view.webContents.send(BUNDLE_UPDATE_PROGRESS_CHANNEL, progress);
				}
				return;
			}
			case 'reloadTab':
				return this.reloadTab(payload.id as number);
			case 'toggle':
				return this.toggleSidebar();
			case 'refresh':
				return this.pushSidebarState();
			case 'resizeStart':
				this.resizing = true;
				return this.layout();
			case 'resize':
				return this.setSidebarWidth(payload.x as number);
			case 'resizeEnd':
				this.resizing = false;
				return this.layout();
			case 'newGroup':
				return this.createGroup();
			case 'theme':
				return this.setWorkbenchTheme(
					payload.kind as 'light' | 'dark',
					(payload.colors ?? {}) as Record<string, string>
				);
			case 'setTheme':
				return this.setTheme(payload.theme as 'auto' | 'light' | 'dark');
			case 'toggleRecent':
				return this.toggleRecent();
			case 'toggleGroup':
				return this.toggleGroup(payload.id as number);
			case 'openFolder':
				this.promptForFolder();
				return;
			case 'openRemote':
				return this.showRemoteMenu();
			case 'openSettings':
				settingsOpener?.();
				return;
			case 'openManager':
				return this.openManager(payload.section as string | undefined);
			case 'closeManager':
				this.manager?.close();
				return;
			case 'assignGroup':
				return this.assignGroup(payload.key as string, payload.groupId as number | null);
			case 'removeGroup':
				return this.removeGroup(payload.id as number);
			case 'rename':
				return this.rename(payload.entry as EntryRef, payload.name as string);
			case 'move':
				return this.move(
					payload.drag as EntryRef,
					payload.target as EntryRef | undefined,
					payload.position as 'before' | 'after' | 'inside'
				);
		}
	}

	//#endregion

	//#region projects

	/** Brings a project's window forward, opening it first if it is closed. */
	private openEntry(entry: EntryRef): void {
		if (entry.type === 'tab') {
			return this.activate(entry.id);
		}
		if (entry.type === 'group') {
			return this.toggleGroup(entry.id);
		}

		const open = this.tabs.find(tab => tab.workspaceKey === entry.key);
		if (open) {
			return this.activate(open.id);
		}

		projectOpener?.(entry.key);
	}

	/**
	 * Reloads what a row stands for. A site has no window configuration to
	 * rebuild, so it goes round again by itself rather than through the
	 * reloader, which only knows how to rebuild a workbench.
	 */
	private reloadTab(id: number): void {
		tabReloader?.(id);
	}

	/**
	 * Marks a tab as wanting to be looked at.
	 *
	 * Marked on the tab on screen as well. What is watched for is the name going
	 * from working to done, and leaving the tab in front of you out of that means
	 * the one project whose state is easiest to check is the one the strip stays
	 * silent about. Being able to see the terminal is not the same as watching
	 * it, which is the whole reason for handing the work over.
	 */
	private flagAttention(tab: IBundleTab | undefined): void {
		if (!tab || tab.attention) {
			return;
		}

		tab.attention = true;
		this.pushState();
	}

	/**
	 * Records whether a tab is working. Reported for the tab on screen as well:
	 * unlike a request for attention, this says what is happening rather than
	 * asking for something, and it is worth seeing on the strip even when the
	 * terminal that is busy is right there.
	 */
	private flagRunning(tab: IBundleTab | undefined, value: boolean): void {
		if (!tab || tab.running === value) {
			return;
		}

		tab.running = value;
		this.pushState();
	}

	/**
	 * Someone typed into one of this tab's terminals, which answers the request
	 * for attention the same way switching to the tab does.
	 *
	 * Needed because the tab on screen is never switched to, so without this the
	 * mark it is now allowed to carry would have no way of coming off. Taken from
	 * input rather than from work starting again: an agent redrawing its prompt
	 * is output, and clearing on that wipes the mark a moment after it lands.
	 */
	private clearAttention(tab: IBundleTab | undefined): void {
		if (!tab || !tab.attention) {
			return;
		}

		tab.attention = false;
		this.pushState();
	}

	/**
	 * Closes the window a row stands for. Used by rows whose workspace is not
	 * known yet, where there is no project to forget and closing is the only way
	 * to make the row go away. Goes through the same path as Cmd+W, so unsaved
	 * work still prompts.
	 */
	private closeTab(id: number): void {
		const tab = this.tabs.find(candidate => candidate.id === id);
		if (!tab) {
			return;
		}

		tab.view.webContents.close();
	}

	/**
	 * A native menu rather than one drawn in the page. The strip's pages have no
	 * preload and no IPC, so anything they draw themselves would have to
	 * reimplement dismissal, keyboard handling and placement, and would still
	 * look unlike every other menu on the machine.
	 */
	private showContextMenu(payload: { [key: string]: unknown }): void {
		const key = payload.key as string | undefined;
		const tabId = payload.tabId as number | undefined;
		const groupId = payload.groupId as number | undefined;
		const items: electron.MenuItemConstructorOptions[] = [];

		if (key && !this.isListed(key)) {
			items.push({ label: '一覧に追加', click: () => this.listProject(key) });
		}

		if (tabId !== undefined) {
			items.push({ label: 'ウィンドウを再読み込み', click: () => this.reloadTab(tabId) });
			items.push({ label: 'ウィンドウを閉じる', click: () => this.closeTab(tabId) });
		}

		if (key && this.isListed(key)) {
			if (items.length) {
				items.push({ type: 'separator' });
			}
			items.push({ label: '一覧から削除', click: () => this.forget(key) });
		}

		if (groupId !== undefined) {
			items.push({ label: 'グループを削除', click: () => this.removeGroup(groupId) });
		}

		if (!items.length) {
			return;
		}

		electron.Menu.buildFromTemplate(items).popup({ window: this.host });
	}

	/**
	 * Offers the hosts named in `~/.ssh/config`, most recently used first.
	 *
	 * Recency is the whole design here. The file has grown for years and holds
	 * close to a hundred names, most of them git remotes and machines long
	 * retired, while the ones actually worked on are a handful. An alphabetical
	 * list of everything buries them, so the few come first by name and the rest
	 * stay one level down, in the order the file declares them — that order is
	 * the user's own grouping, and re-sorting it would throw away the only
	 * structure the file has.
	 *
	 * Connecting opens an empty window rather than a folder, because a host is
	 * not a workspace and nothing here knows which path is wanted. Once a folder
	 * is opened over there its `vscode-remote://` address becomes an ordinary
	 * project key, so the second visit comes from the strip and never passes
	 * through this menu.
	 */
	private showRemoteMenu(): void {
		const path = defaultSshConfigPath();
		const hosts = collectSshHosts(readSshConfig, path);
		const items: electron.MenuItemConstructorOptions[] = [];

		if (!hosts.length) {
			// Said in the menu rather than swallowed: an empty menu looks like a
			// button that does nothing, and the reason is worth one line.
			items.push({ label: 'SSH の設定にホストがありません', enabled: false });
		} else {
			const recent = hosts
				.filter(host => this.remoteHosts.has(host))
				.sort((a, b) => this.remoteHosts.get(b)! - this.remoteHosts.get(a)!)
				.slice(0, RECENT_REMOTE_HOSTS);

			for (const host of recent) {
				items.push({ label: host, click: () => this.openRemote(host) });
			}
			if (recent.length) {
				items.push({ type: 'separator' });
			}

			items.push({
				label: 'すべてのホスト',
				submenu: hosts.map(host => ({ label: host, click: () => this.openRemote(host) }))
			});
		}

		items.push({ type: 'separator' });
		items.push({ label: 'SSH の設定を開く', click: () => fileOpener?.(path) });

		electron.Menu.buildFromTemplate(items).popup({ window: this.host });
	}

	private openRemote(host: string): void {
		this.remoteHosts.set(host, Date.now());
		this.save();
		remoteOpener?.(host);
	}

	private isListed(key: string): boolean {
		return this.order.some(entry => entry.type === 'project' && entry.key === key)
			|| [...this.groups.values()].some(group => group.children.some(child => child.type === 'project' && child.key === key));
	}

	/** Puts a window's workspace on the list, which is what makes it a project. */
	private listProject(key: string): void {
		if (this.isListed(key)) {
			return;
		}

		if (!this.projects.has(key)) {
			this.projects.set(key, { key, name: undefined, lastActive: Date.now() });
		}
		this.order.push({ type: 'project', key });

		// The window is one of the listed projects now, so its temporary row goes.
		const open = this.tabs.find(tab => tab.workspaceKey === key);
		if (open) {
			this.unlink({ type: 'tab', id: open.id });
		}

		this.pushState();
		this.save();
	}

	/** Drops a project from the strip. An open window is left alone. */
	private forget(key: string): void {
		this.projects.delete(key);
		this.unlink({ type: 'project', key });

		// Still open, so it stays visible as an entry that is not remembered.
		const open = this.tabs.find(tab => tab.workspaceKey === key);
		if (open) {
			this.order.push({ type: 'tab', id: open.id });
		}

		this.pushState();
		this.save();
	}

	//#endregion

	//#region organising

	/**
	 * A new group arrives named `New Group`, which is a placeholder rather than
	 * a name — it exists so the row has something to draw. The strip is asked to
	 * put the row straight into a rename, so the placeholder is selected and the
	 * first thing typed replaces it. Leaving it to be found and double clicked
	 * makes naming a separate errand from creating.
	 */
	private createGroup(): void {
		const group: IBundleGroup = { id: nextRuntimeId++, name: 'New Group', collapsed: false, children: [] };
		this.groups.set(group.id, group);
		this.order.push({ type: 'group', id: group.id });
		this.renameOnArrival = group.id;
		this.pushState();
		this.save();
	}

	private toggleGroup(groupId: number): void {
		const group = this.groups.get(groupId);
		if (group) {
			group.collapsed = !group.collapsed;
			this.pushState();
			this.save();
		}
	}

	/**
	 * Renames whatever the row stands for.
	 *
	 * A row for a window that is not on the list joins the list on being named.
	 * Names are kept per project, so there was nowhere to put one and the rename
	 * did nothing at all: the input appeared, took what was typed, and the row
	 * came back with its old title. Refusing outright would be no better, since
	 * a listed project and an open unlisted window are all but the same row to
	 * look at. Naming a thing is claiming it, so it is treated as such.
	 */
	private rename(entry: EntryRef, name: string): void {
		if (entry.type === 'group') {
			const group = this.groups.get(entry.id);
			if (group) {
				group.name = name;
			}

			this.pushState();
			this.save();
			return;
		}

		let key: string | undefined;
		if (entry.type === 'project') {
			key = entry.key;
		} else {
			// A window with no workspace is recognised by nothing, so there is
			// no key for a name to hang off and nothing to remember it by.
			key = this.tabs.find(tab => tab.id === entry.id)?.workspaceKey;
			if (key) {
				this.listProject(key);
			}
		}

		const project = key ? this.projects.get(key) : undefined;
		if (project) {
			project.name = name;
		}

		this.pushState();
		this.save();
	}

	/** Moves a project into a group, or back out to the top level. */
	private assignGroup(key: string, groupId: number | null): void {
		const entry: EntryRef = { type: 'project', key };
		this.unlink(entry);

		const group = groupId === null ? undefined : this.groups.get(groupId);
		if (group) {
			group.children.push(entry);
		} else {
			this.order.push(entry);
		}

		this.pushState();
		this.save();
	}

	/** Removes a group. Its projects move back to the top level rather than away. */
	private removeGroup(groupId: number): void {
		const group = this.groups.get(groupId);
		if (!group) {
			return;
		}

		const index = this.order.findIndex(entry => entry.type === 'group' && entry.id === groupId);
		this.order.splice(index === -1 ? this.order.length : index, index === -1 ? 0 : 1, ...group.children);
		this.groups.delete(groupId);

		this.pushState();
		this.save();
	}

	//#endregion

	//#region manager window

	/**
	 * @param section Which part of the window to arrive at. Set by whoever asked
	 * for it: the strip's globe means "add a site", and landing on the theme
	 * would leave the person who pressed it to go looking.
	 */
	private openManager(section?: string): void {
		this.managerSection = section;

		if (this.manager && !this.manager.isDestroyed()) {
			this.manager.focus();
			this.pushState();
			return;
		}

		this.manager = new electron.BrowserWindow({
			width: 720,
			height: 520,
			parent: this.host,
			// Matches the page, so opening in a light theme does not flash dark.
			backgroundColor: this.resolvedTheme === 'light' ? '#ffffff' : '#1f1f1f',
			titleBarStyle: isMacintosh ? 'hiddenInset' : 'default',
			minimizable: false,
			maximizable: false,
			webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true }
		});

		this.manager.on('closed', () => { this.manager = undefined; });
		this.manager.webContents.on('console-message', event => this.onSidebarMessage(event.message));
		this.manager.webContents.on('did-finish-load', () => this.pushState());

		const html = getManagerPage(isMacintosh ? TRAFFIC_LIGHT_INSET : 0);
		this.manager.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
	}

	/** Rows for the manager: every project, flattened, with its group. */
	private buildManagerState(): object {
		const groupOf = new Map<string, number>();
		for (const group of this.groups.values()) {
			for (const child of group.children) {
				if (child.type === 'project') {
					groupOf.set(child.key, group.id);
				}
			}
		}

		const ordered: string[] = [];
		for (const entry of this.order) {
			if (entry.type === 'project') {
				ordered.push(entry.key);
			} else if (entry.type === 'group') {
				const group = this.groups.get(entry.id);
				for (const child of group?.children ?? []) {
					if (child.type === 'project') {
						ordered.push(child.key);
					}
				}
			}
		}
		// Anything only reachable through a group that is not in `order`.
		for (const key of this.projects.keys()) {
			if (!ordered.includes(key)) {
				ordered.push(key);
			}
		}

		// Once only. Redrawing for a title change should not drag the window back
		// to wherever it was originally asked to open.
		const section = this.managerSection;
		this.managerSection = undefined;

		return {
			section,
			theme: this.resolvedTheme,
			themeSetting: this.theme,
			colors: this.resolvedColors,
			projects: ordered.map(key => {
				const project = this.projects.get(key)!;
				const tab = this.tabs.find(candidate => candidate.workspaceKey === key);

				return {
					key,
					entry: { type: 'project', key },
					name: project.name || tab?.title || BundleHost.labelFor(key),
					path: BundleHost.readablePath(key),
					groupId: groupOf.get(key),
					open: !!tab
				};
			}),
			groups: [...this.groups.values()].map(group => ({
				id: group.id,
				entry: { type: 'group', id: group.id },
				name: group.name
			}))
		};
	}

	/** A path a person can read, rather than a URI. */
	private static readablePath(key: string): string {
		try {
			const path = decodeURI(key).replace(/^file:\/\//, '');
			const home = process.env['HOME'];
			return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
		} catch {
			return key;
		}
	}

	//#endregion

	//#region organising

	private async promptForFolder(): Promise<void> {
		const result = await electron.dialog.showOpenDialog(this.host, {
			properties: ['openDirectory', 'multiSelections', 'createDirectory']
		});

		if (!result.canceled) {
			for (const path of result.filePaths) {
				projectOpener?.(URI.file(path).toString());
			}
		}
	}

	private static same(a: EntryRef, b: EntryRef): boolean {
		return a.type === b.type && (a.type === 'project'
			? a.key === (b as { key: string }).key
			: a.id === (b as { id: number }).id);
	}

	/** Detaches an entry from wherever it currently sits. */
	private unlink(entry: EntryRef): void {
		this.order = this.order.filter(candidate => !BundleHost.same(candidate, entry));
		for (const group of this.groups.values()) {
			group.children = group.children.filter(child => !BundleHost.same(child, entry));
		}
	}

	private move(entry: EntryRef, target: EntryRef | undefined, position: 'before' | 'after' | 'inside'): void {
		this.relocate(entry, target, position);

		this.pushState();
		this.save();
	}

	/** The move itself, with no opinion about what it means. */
	private relocate(entry: EntryRef, target: EntryRef | undefined, position: 'before' | 'after' | 'inside'): void {
		if (entry.type === 'group' && position === 'inside') {
			position = 'after'; // groups do not nest
		}

		this.unlink(entry);

		if (!target) {
			this.order.push(entry);
			return;
		}

		if (target.type === 'group' && position === 'inside') {
			this.groups.get(target.id)?.children.push(entry);
			return;
		}

		// Reordering next to an entry has to happen in whichever list holds it.
		if (target.type !== 'group' && entry.type !== 'group') {
			for (const group of this.groups.values()) {
				const index = group.children.findIndex(child => BundleHost.same(child, target));
				if (index !== -1) {
					group.children.splice(position === 'before' ? index : index + 1, 0, entry);
					return;
				}
			}
		}

		const index = this.order.findIndex(candidate => BundleHost.same(candidate, target));
		this.order.splice(index === -1 ? this.order.length : (position === 'before' ? index : index + 1), 0, entry);
	}

	//#endregion

	//#region persistence

	private restore(): void {
		const layout = stateStore?.read();
		if (!layout) {
			return;
		}

		this.sidebarWidth = Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, layout.width || DEFAULT_SIDEBAR_WIDTH));
		this.collapsed = !!layout.collapsed;

		this.recent = !!layout.recent;
		if (layout.theme === 'light' || layout.theme === 'dark' || layout.theme === 'auto') {
			this.theme = layout.theme;
		}
		for (const entry of layout.remoteHosts ?? []) {
			this.remoteHosts.set(entry.host, entry.time);
		}

		const names = new Map((layout.names ?? []).map(entry => [entry.key, entry.name]));
		const lastActive = new Map((layout.lastActive ?? []).map(entry => [entry.key, entry.time]));
		const ensureProject = (key: string) => {
			if (!this.projects.has(key)) {
				this.projects.set(key, { key, name: names.get(key), lastActive: lastActive.get(key) });
			}
		};

		// Groups keep their ids across restarts so remembered membership still
		// resolves; ids handed out later must not collide with them.
		for (const group of layout.groups ?? []) {
			this.groups.set(group.id, { id: group.id, name: group.name, collapsed: group.collapsed, children: [] });
			nextRuntimeId = Math.max(nextRuntimeId, group.id + 1);
		}

		for (const member of layout.members ?? []) {
			const group = this.groups.get(member.groupId);
			for (const key of member.keys) {
				ensureProject(key);
				group?.children.push({ type: 'project', key });
			}
		}

		// The strip is fully populated here, before any window exists. That is the
		// point of listing projects rather than tabs: closed work is still there.
		for (const entry of layout.order ?? []) {
			if (entry.kind === 'group') {
				if (this.groups.has(entry.id)) {
					this.order.push({ type: 'group', id: entry.id });
				}
			} else {
				ensureProject(entry.key);
				this.order.push({ type: 'project', key: entry.key });
			}
		}
	}

	/** Registers the project a tab turned out to hold. */
	private assignWorkspace(tabId: number, key: string | undefined, restored: boolean): void {
		const tab = this.tabs.find(candidate => candidate.id === tabId);
		if (!tab || !key || tab.workspaceKey === key) {
			return;
		}

		tab.workspaceKey = key;

		// Opening a project counts as going there, and this is the only place
		// that can say so. A tab is created, focused, and only then told which
		// workspace it holds, so by the time the key arrives `activate` has
		// already run and found nothing to stamp — which left every project
		// opened from a closed row sitting at the bottom of the recency order
		// until it was switched away from and back. Sites never had the problem:
		// theirs is set when the tab is built, so focusing one stamps it.
		//
		// Restored windows are the exception and the reason this is a parameter
		// rather than an unconditional stamp. Stamping them rewrites every open
		// project's history in restore order on each start, which leaves the
		// order saying nothing at all.
		if (!restored) {
			tab.lastActive = Date.now();
			const project = this.projects.get(key);
			if (project) {
				project.lastActive = tab.lastActive;
			}
		}

		// Opening a folder is not the same as wanting it on the list. Anything
		// ever opened used to be added, which turned a place to organise work
		// into a history of everywhere that had been looked at. It joins the
		// list when asked to, and until then the window shows as a temporary row.
		if (this.isListed(key)) {
			this.unlink({ type: 'tab', id: tab.id });
		}

		this.pushState();
		this.save();
	}

	/** Debounced: dragging a divider or an entry produces a burst of changes. */
	private save(): void {
		if (!stateStore) {
			return;
		}

		clearTimeout(this.saveHandle);
		this.saveHandle = setTimeout(() => stateStore?.write(this.serialize()), SAVE_DELAY);
	}

	private serialize(): IPersistedLayout {
		const order: IPersistedLayout['order'] = [];
		for (const entry of this.order) {
			if (entry.type === 'group') {
				order.push({ kind: 'group', id: entry.id });
			} else if (entry.type === 'project') {
				order.push({ kind: 'project', key: entry.key });
			}
			// `tab` entries hold no workspace, so there is nothing to remember.
		}

		const names: IPersistedLayout['names'] = [];
		const lastActive: NonNullable<IPersistedLayout['lastActive']> = [];
		for (const project of this.projects.values()) {
			if (project.name) {
				names.push({ key: project.key, name: project.name });
			}
			if (project.lastActive !== undefined) {
				lastActive.push({ key: project.key, time: project.lastActive });
			}
		}

		return {
			width: this.sidebarWidth,
			collapsed: this.collapsed,
			groups: [...this.groups.values()].map(group => ({ id: group.id, name: group.name, collapsed: group.collapsed })),
			order,
			members: [...this.groups.values()].map(group => ({
				groupId: group.id,
				keys: group.children.filter(child => child.type === 'project').map(child => (child as { key: string }).key)
			})),
			names,
			recent: this.recent,
			theme: this.theme,
			lastActive,
			remoteHosts: [...this.remoteHosts].map(([host, time]) => ({ host, time }))
		};
	}

	//#endregion

	//#region tabs

	/**
	 * Creates a view for a new window and returns the `BrowserWindow` facade that
	 * `CodeWindow` will drive.
	 */
	createTab(options: electron.BrowserWindowConstructorOptions): electron.BrowserWindow {
		const view = new electron.WebContentsView({ webPreferences: options.webPreferences });
		const emitter = new EventEmitter();

		const tab: IBundleTab = {
			id: nextRuntimeId++,
			view,
			emitter,
			facade: undefined!, // assigned below, the proxy needs the tab
			title: '',
			lastActive: undefined,
			workspaceKey: undefined,
			attached: false,
			attention: false,
			running: false
		};
		(tab as { facade: electron.BrowserWindow }).facade = this.createFacade(tab);

		// The workbench's own title bar carries a toggle for the strip, and it
		// reports through the same console channel as the strip's pages. The
		// workbench is talkative, so the prefix is checked before anything else.
		view.webContents.on('console-message', event => {
			if (event.message.startsWith('bundle:')) {
				this.onSidebarMessage(event.message, tab);
			}
		});

		// Intercepted in the main process so the shortcut works without the
		// workbench having to know about the strip. Chosen to stay clear of the
		// workbench's own Cmd+B / Ctrl+B side bar toggle.
		view.webContents.on('before-input-event', (event, input) => {
			const modifier = isMacintosh ? input.meta && input.control : input.control && input.alt;
			if (input.type !== 'keyDown' || !modifier) {
				return;
			}

			const key = input.key.toLowerCase();
			if (key === 'b') {
				event.preventDefault();
				this.toggleSidebar();
			} else if (key === 'f') {
				event.preventDefault();
				this.focusSearch();
			}
		});

		view.webContents.on('page-title-updated', (_event, title) => {
			tab.title = title;
			this.pushState();
		});

		// A workbench is its tab, so losing the view loses the tab. A site keeps
		// its own count instead, since one page going does not end the site.
		view.webContents.on('destroyed', () => this.removeTab(tab));

		// Placeholder until the workspace is known; replaced by the project then.
		// A site needs none: it is opened from an entry that is already listed.
		this.order.push({ type: 'tab', id: tab.id });
		this.track(tab);

		return tab.facade!;
	}

	/** Wiring every tab needs, whatever it turns out to be showing. */
	private track(tab: IBundleTab, focus: boolean = true): void {
		this.tabs.push(tab);
		if (focus) {
			this.activate(tab.id);
		}
		this.pushState();
	}

	activate(tabId: number): void {
		const tab = this.tabs.find(candidate => candidate.id === tabId);
		if (!tab || tab === this.activeTab) {
			return;
		}

		// Detaching rather than hiding keeps the inactive renderer alive while
		// removing it from the view tree, so it cannot capture input or paint.
		if (this.activeTab?.attached) {
			this.host.contentView.removeChildView(this.activeTab.view);
			this.activeTab.attached = false;
			this.activeTab.emitter.emit('blur');
		}

		this.host.contentView.addChildView(tab.view);
		tab.attached = true;
		this.activeTab = tab;

		// Looking at it is what answers the request for attention.
		tab.attention = false;

		// On the tab whether or not it holds a listed project, so that an
		// unlisted window can be ranked too. Only the project's copy is worth
		// saving: the tab's dies with the window.
		tab.lastActive = Date.now();

		if (tab.workspaceKey) {
			const project = this.projects.get(tab.workspaceKey);
			if (project) {
				project.lastActive = tab.lastActive;
				this.save();
			}
		}

		this.layout();
		this.pushSidebarState();

		tab.view.webContents.focus();
		tab.emitter.emit('focus');
	}

	private removeTab(tab: IBundleTab): void {
		const index = this.tabs.indexOf(tab);
		if (index === -1) {
			return;
		}

		this.tabs.splice(index, 1);

		// Only the placeholder goes; a project stays on the strip after its
		// window closes, which is the whole point of listing projects.
		this.unlink({ type: 'tab', id: tab.id });

		// Tabs also go away while the whole window is tearing down, so every
		// touch of the host has to tolerate it being gone already. Throwing here
		// surfaces as an uncaught exception in the main process, which takes the
		// application down with it.
		const hostAlive = !this.host.isDestroyed();

		if (tab.attached && hostAlive) {
			this.host.contentView.removeChildView(tab.view);
		}
		tab.emitter.emit('closed');

		if (this.activeTab === tab) {
			this.activeTab = undefined;
		}

		// Nothing below may touch the host once it is gone. Activating a
		// replacement in particular reaches into contentView, which throws and
		// becomes an uncaught exception in the main process.
		if (!hostAlive) {
			return;
		}

		if (!this.activeTab) {
			const next = this.tabs[Math.min(index, this.tabs.length - 1)];
			if (next) {
				this.activate(next.id);
			}
		}

		if (this.tabs.length === 0) {
			// Cleared before closing so that a tab opened in the meantime builds a
			// fresh host instead of reusing this one as it is being destroyed.
			BundleHost.instance = undefined;
			this.host.close();
		} else {
			this.pushState();
		}
	}

	//#endregion

	//#region sidebar chrome

	/** Reported by every workbench, so only a change is worth redrawing for. */
	private setWorkbenchTheme(kind: 'light' | 'dark', colors: Record<string, string>): void {
		const serialised = JSON.stringify(colors);
		if (this.workbenchTheme === kind && JSON.stringify(this.workbenchColors) === serialised) {
			return;
		}

		this.workbenchTheme = kind;
		this.workbenchColors = colors;
		if (this.theme === 'auto') {
			this.pushState();
		}
	}

	private get resolvedColors(): Record<string, string> {
		return this.theme === 'auto' ? this.workbenchColors : {};
	}

	private setTheme(theme: 'auto' | 'light' | 'dark'): void {
		this.theme = theme;
		this.pushState();
		this.save();
	}

	private get resolvedTheme(): 'light' | 'dark' {
		return this.theme === 'auto' ? this.workbenchTheme : this.theme;
	}

	private toggleRecent(): void {
		this.recent = !this.recent;
		this.pushState();
		this.save();
	}

	/**
	 * Puts the cursor in the strip's filter field, unfolding the strip first if
	 * it is away. Reached from a workbench, which has the keyboard almost all of
	 * the time — a field that can only be opened by clicking it is one that gets
	 * used only when the mouse was already going there.
	 */
	private focusSearch(): void {
		if (this.collapsed) {
			this.toggleSidebar();
		}

		this.sidebar.webContents.focus();
		this.sidebar.webContents
			.executeJavaScript('window.__bundleFind && window.__bundleFind()')
			.catch(() => { /* the page may not have loaded yet */ });
	}

	toggleSidebar(): void {
		this.collapsed = !this.collapsed;
		this.layout();
		this.pushState();
		this.save();
	}

	private setSidebarWidth(width: number): void {
		this.sidebarWidth = Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, Math.round(width)));
		this.collapsed = false;
		this.layout();
		this.pushState();
		this.save();
	}

	/** Width the entry list currently occupies, excluding the drag strip. */
	private get listWidth(): number {
		return this.collapsed ? RAIL_WIDTH : this.sidebarWidth;
	}

	private layout(): void {
		const { width, height } = this.host.getContentBounds();
		const reserved = this.listWidth + HANDLE_WIDTH;

		// Stretched to the full window while dragging so the pointer stays inside
		// the view; the page keeps everything past the strip transparent.
		this.sidebar.setBounds({ x: 0, y: 0, width: this.resizing ? width : reserved, height });

		this.activeTab?.view.setBounds({
			x: reserved,
			y: 0,
			width: Math.max(0, width - reserved),
			height
		});
	}

	/** Falls back to the last path segment so a project always has a label. */
	private static labelFor(key: string): string {
		try {
			const path = decodeURI(key).replace(/\/+$/, '');
			const name = path.slice(path.lastIndexOf('/') + 1);
			return name.replace(/\.code-workspace$/, '') || key;
		} catch {
			return key;
		}
	}

	/** Flattens the ordered tree into the rows the strip draws, top to bottom. */
	private buildRows(): object[] {
		const rows: object[] = [];

		const push = (entry: EntryRef, nested: boolean) => {
			if (entry.type === 'tab') {
				const tab = this.tabs.find(candidate => candidate.id === entry.id);
				if (tab) {
					rows.push({
						kind: 'entry', entry, nested,
						// A window with a workspace is recognisable by it, and
						// saying so is what makes adding it to the list a
						// decision rather than a guess.
						title: tab.workspaceKey ? BundleHost.labelFor(tab.workspaceKey) : (tab.title || 'Untitled'),
						path: tab.workspaceKey ? BundleHost.readablePath(tab.workspaceKey) : undefined,
						key: tab.workspaceKey,
						open: true,
						active: tab === this.activeTab,
						attention: tab.attention,
						running: tab.running,
						/** Not on the list, so the strip offers to put it there. */
						unlisted: !!tab.workspaceKey
					});
				}
				return;
			}

			const project = this.projects.get(entry.type === 'project' ? entry.key : '');
			if (!project) {
				return;
			}

			const tab = this.tabs.find(candidate => candidate.workspaceKey === project.key);
			rows.push({
				kind: 'entry', entry, nested,
				title: project.name || tab?.title || BundleHost.labelFor(project.key),
				open: !!tab,
				active: !!tab && tab === this.activeTab,
				attention: !!tab?.attention,
				running: !!tab?.running,
				key: project.key,
				// Shown under the name. Two projects often share a basename, and
				// the name alone then says nothing about which one this is.
				path: BundleHost.readablePath(project.key),
				// So the strip can close the window without forgetting the project.
				tabId: tab?.id
			});
		};

		// Newest first, groups flattened. Anything never switched to keeps the
		// arrangement it had, after everything that has been.
		if (this.recent) {
			// Open windows that are not on the list rank alongside the ones that
			// are. They used to be appended after the ranking, unconditionally,
			// which made a whole run of rows that could never move however often
			// they were used — and from the strip there is nothing to say why,
			// since being listed or not is a faint difference in a row's look and
			// not something the ordering ought to turn on. Their time lives on
			// the tab, because there is no project entry to put it on.
			const ranked: { entry: EntryRef; time: number; index: number }[] = [];

			for (const project of this.projects.values()) {
				ranked.push({
					entry: { type: 'project', key: project.key },
					time: project.lastActive ?? 0,
					index: ranked.length
				});
			}

			for (const entry of this.order) {
				if (entry.type === 'tab') {
					ranked.push({
						entry,
						time: this.tabs.find(tab => tab.id === entry.id)?.lastActive ?? 0,
						index: ranked.length
					});
				}
			}

			// Never visited leaves the arrangement it had, and listed projects
			// come before unlisted windows there, which is the order the two
			// loops above already put them in.
			ranked.sort((a, b) => b.time - a.time || a.index - b.index);

			for (const { entry } of ranked) {
				push(entry, false);
			}

			return rows;
		}

		for (const entry of this.order) {
			if (entry.type !== 'group') {
				push(entry, false);
				continue;
			}

			const group = this.groups.get(entry.id);
			if (!group) {
				continue;
			}

			rows.push({ kind: 'group', entry, title: group.name, collapsed: group.collapsed });
			if (!group.collapsed) {
				for (const child of group.children) {
					push(child, true);
				}
			}
		}

		return rows;
	}

	/** Refreshes every surface that shows the layout. */
	private pushState(): void {
		this.pushSidebarState();

		if (this.manager && !this.manager.isDestroyed()) {
			this.manager.webContents
				.executeJavaScript(`window.__bundleRender(${JSON.stringify(this.buildManagerState())})`)
				.catch(() => { /* window may be gone */ });
		}
	}

	private pushSidebarState(): void {
		if (!this.sidebarReady) {
			return;
		}

		const rename = this.renameOnArrival;
		this.renameOnArrival = undefined;

		const state = {
			rows: this.buildRows(),
			rename,
			recent: this.recent,
			theme: this.resolvedTheme,
			colors: this.resolvedColors,
			width: this.listWidth,
			collapsed: this.collapsed
		};

		// Injected rather than re-loaded: a reload on every title change or drag
		// step would throw away the page several times per second.
		this.sidebar.webContents.executeJavaScript(`window.__bundleRender(${JSON.stringify(state)})`).catch(() => { /* view may be gone */ });
	}

	private loadSidebarShell(): void {
		const html = getSidebarPage(HANDLE_WIDTH, this.topInset);
		this.sidebar.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
	}

	//#endregion

	//#region facade

	/**
	 * Routes `BrowserWindow` members: content facing ones go to this tab's view,
	 * everything else falls through to the shared host window. Falling through
	 * by default means an unforeseen call site degrades to acting on the host
	 * instead of throwing.
	 */
	private createFacade(tab: IBundleTab): electron.BrowserWindow {
		const host = this.host;
		const bundle = this;

		const overrides: Record<string, unknown> = {
			id: tab.id,
			webContents: tab.view.webContents,

			loadURL: (url: string) => tab.view.webContents.loadURL(url),
			isDestroyed: () => tab.view.webContents.isDestroyed(),
			destroy: () => tab.view.webContents.close(),
			close: () => tab.view.webContents.close(),

			show: () => {
				bundle.activate(tab.id);
				host.show();
			},
			showInactive: () => host.showInactive(),
			focus: () => {
				bundle.activate(tab.id);
				host.focus();
			},
			isVisible: () => host.isVisible() && tab.attached,
			isFocused: () => host.isFocused() && tab.attached,

			// Titles and window chrome only make sense for the visible tab.
			setTitle: (title: string) => {
				tab.title = title;
				bundle.pushSidebarState();
				if (tab.attached) {
					host.setTitle(title);
				}
			},

			// A tab has no window of its own to turn into a native macOS tab.
			addTabbedWindow: () => undefined,

			// Swallowed rather than forwarded. Each tab restores its own remembered
			// geometry on startup, and without this the last one to open resizes
			// the shared window for everybody. Remote windows make it obvious:
			// they keep their own state, so opening one shrinks the whole window.
			// The host is already sized by the options of the tab that created it.
			setBounds: () => undefined,
			setContentBounds: () => undefined,
			setSize: () => undefined,
			setContentSize: () => undefined,
			setPosition: () => undefined,
			center: () => undefined,

			// Event plumbing is per tab: `focus`/`blur`/`closed` are synthesized
			// on activation, the rest are relayed from the host below.
			on: (event: string, listener: (...args: unknown[]) => void) => { tab.emitter.on(event, listener); return tab.facade; },
			once: (event: string, listener: (...args: unknown[]) => void) => { tab.emitter.once(event, listener); return tab.facade; },
			addListener: (event: string, listener: (...args: unknown[]) => void) => { tab.emitter.on(event, listener); return tab.facade; },
			removeListener: (event: string, listener: (...args: unknown[]) => void) => { tab.emitter.removeListener(event, listener); return tab.facade; },
			removeAllListeners: (event?: string) => { tab.emitter.removeAllListeners(event); return tab.facade; },
			emit: (event: string, ...args: unknown[]) => tab.emitter.emit(event, ...args)
		};

		return new Proxy({}, {

			// So that `instanceof BrowserWindow` holds, which is how some call
			// sites tell a window from a plain options object.
			getPrototypeOf: () => electron.BrowserWindow.prototype,

			get(_target, property: string | symbol) {
				// `hasOwn` rather than `in`: `in` walks the prototype chain, so a
				// plain object literal answers for `constructor`, `toString` and
				// the rest of Object.prototype.
				if (typeof property === 'string' && Object.hasOwn(overrides, property)) {
					return overrides[property];
				}

				// Electron's dialog API decides whether its first argument is a
				// window by comparing `constructor` against BrowserWindow, and
				// falls back to reading that argument as the options when the
				// comparison fails. Answering with anything else costs every
				// native dialog raised from a tab its message and its buttons.
				// The fall through below cannot serve this: it binds the
				// functions it returns, and a bound class is not the class.
				if (property === 'constructor') {
					return electron.BrowserWindow;
				}

				// CodeWindow objects can outlive the shared window, and Electron
				// throws on every access to a destroyed one. Since these calls run
				// on paths like window state bookkeeping, a throw here becomes an
				// uncaught exception in the main process rather than a handled
				// error, so a dead host answers inertly instead.
				if (host.isDestroyed()) {
					return typeof (electron.BrowserWindow.prototype as unknown as Record<string | symbol, unknown>)[property] === 'function'
						? () => undefined
						: undefined;
				}

				const value = (host as unknown as Record<string | symbol, unknown>)[property];

				return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(host) : value;
			},
			set(_target, property: string | symbol, value: unknown) {
				(host as unknown as Record<string | symbol, unknown>)[property] = value;

				return true;
			}
		}) as unknown as electron.BrowserWindow;
	}

	/** Relays a host window event to every tab, or only to the visible one. */
	private relay(event: string, activeOnly: boolean): void {
		this.host.on(event as 'maximize', (...args: unknown[]) => {
			for (const tab of this.tabs) {
				if (!activeOnly || tab === this.activeTab) {
					tab.emitter.emit(event, ...args);
				}
			}
		});
	}

	private registerHostEvents(): void {
		for (const event of ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'always-on-top-changed']) {
			this.relay(event, false);
		}
		for (const event of ['swipe']) {
			this.relay(event, true);
		}

	}

	//#endregion
}
